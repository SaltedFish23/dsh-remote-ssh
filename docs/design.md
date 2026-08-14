# 设计说明：工作区驱动的透明 Remote SSH

## 核心不变量

1. 不存在 `remote_read`、`remote_bash` 等平行工具；shell 名称按工作区 OS 选择（POSIX Remote 为 `bash`，Windows LOCAL 为 `pwsh`）。
2. 当前 workspace cwd 是执行世界的唯一主选择器。
3. 远端错误、断线、缺少程序和删除映射都 fail closed；禁止本机 fallback。
4. alias 是稳定身份，不是同步目录或挂载点。
5. Workspace/Session 是历史数据；删除执行映射不能删除历史。

## 组合结构

DSH 原有本地 filesystem/subprocess provider 被隔离在 private Cordis realm，并通过 `localFs`、`localSubprocess` 暴露给根路由：

```text
                           ┌─ localFs / localSubprocess
ordinary tools ─ routers ─┤
                           └─ RemoteSshManager ─ SSH/AHP
```

- `TransparentFileSystem`：用 cwd/path 匹配 alias，委托本机 fs 或该 workspace 的 AHP fs；
- `TransparentSubprocessRuntime`：用 `spec.cwd` 选择本机 subprocess 或 host-scoped AHP subprocess；所有 stdin 模式都留在 AHP；
- Remote `bash`：`dsh-tool-bash-persistent` → owner-scoped `ctx.terminals` → `terminal-bash` → routed `spawnTerminal()` → AHP Terminal；
- `TransparentShellExecutor`：保留给非模型工具的 one-shot shell consumer；
- 内置 `tool-fs-search` 保持原名并复用 routed subprocess，因此 `rg` 在当前 workspace 主机解析；
- background handle 也由同一 subprocess 路由产生。

## Catalog 与标题

Settings 保存两类 durable record：

```text
Server    { id, label, sshTarget, sshArgs, remoteCodeCommand }
Workspace { id, serverId, remotePath, aliasPath? }
```

Manager 为每个 Remote Workspace 生成稳定本地 alias，并向 DSH WorkspaceRegistry 注册：

```text
<server.label> > <remote basename>
```

本机 picker 选中的路径会注册为：

```text
LOCAL > <local basename>
```

## 路由判定

Manager 维护 active routes 和 `remoteAliases` 历史集合。判定顺序：

1. cwd 落在 active remote alias：remote；
2. cwd 落在 tombstoned alias：抛错；
3. absolute path 落在 active remote alias：remote；
4. absolute path 落在 tombstoned alias：抛错；
5. 其余：local。

cwd 优先保证远端工作区中的相对路径始终在远端解释。对 POSIX 远端，alias 下的本地表现路径由 `WorkspacePathMapper` 转换为远端绝对路径。

## 远端墓碑状态机

```text
configured ──remove──► tombstoned
    │                      │
    │ tools allowed        │ history readable
    │ lazy context         │ tools rejected
    ▼                      ▼
 remote/local alias     alias retained
```

移除 mapping 时 active route 与远端 context 会消失；alias 目录、WorkspaceRegistry 中已有 Workspace 和 Session 数据均保留。`remoteAliases` 不删除旧 alias，因此旧会话的新工具调用不能掉进 local 分支。

重新添加同一远端路径默认生成新的 workspace id/alias。旧 alias 继续是墓碑，避免把旧会话悄悄绑定到一个语义上可能不同的新目标。

## 文件系统与连接

远端 filesystem 使用 VS Code Agent Host Protocol：

| DSH fs | AHP |
|---|---|
| resolve/stat/lstat | resourceResolve |
| read text/bytes | resourceRead |
| guarded write/edit | resourceWrite createOnly / ifMatch |
| list directory | resourceList |
| mkdir/delete/move | 对应 Resource action |

AHP etag 作为 opaque FsVersion，保持 read-before-write 和 stale-version 语义。`RemoteSshManager` 按 `serverId` 惰性创建一个 host runtime/AHP client；每个 workspace 只创建自己的 mapper、fs view 和 shell view。同主机 workspace 的 `remote` 对象引用相同。

host runtime 请求 POSIX `/` Resource access，以实现 DSH 原生权限含义：Full Access 可跨 workspace；workspace-write 的 mutation 由 `RemoteSshFileSystem` 按每次调用的 `workspaceRoot` 检查；read-only 拒绝 mutation。AHP 授权范围不是 DSH workspace sandbox。

## 进程与 shell

普通远端 subprocess 使用共享 AHP：

1. 在 host runtime root 创建 fixed stdin（可选）、stdout、stderr Resource；
2. AHP Terminal 在映射后的 cwd 启动精确 argv，stdout/stderr 重定向到不同文件；
3. 本地通过同一 AHP WebSocket 轮询 Resource 并向 pipe/inherit/bounded reader 增量发布；
4. Terminal marker 返回 exit code，AbortSignal dispose Terminal；
5. live stdin 先创建 FIFO，再由第二条 AHP Terminal 接收 Base64 分块并解码写入；随机 EOF marker 关闭 writer；
6. 最终采集后删除临时 Resource/FIFO，取消会同时 dispose 主进程与输入泵。

这使 `rg`/glob/grep、普通后台收集进程与 ignore/fixed/live stdin 调用都不再新建 SSH，同时保留 stdout/stderr 分离。argv、cwd 和环境变量使用固定 POSIX quoting；Windows 本机绝对 executable（例如某插件缓存的 `C:\...\rg.exe`）在远端只保留 basename 并去掉 `.exe`，让远端 PATH 重新解析。

Remote `bash` 为每个 live Agent 创建一个持久 AHP Terminal。命令直接通过 TerminalInput 进入该 Bash，不创建每调用一次的脚本 Resource；cwd、环境变量、函数和 shell 后台任务自然跨调用保留。Harness PTY registry 负责 owner 隔离、串行 send、bounded scrollback、超时 reset 与 Agent dispose 清理。

交互 subprocess terminal 同样直接使用 AHP `createTerminal`/TerminalInput/TerminalData；Ctrl-C、Ctrl-Z 可写入 PTY。AHP 不公开 foreground process group id，因此其他定向 signal 明确失败。

OpenSSH 仅用于 host runtime 的 bootstrap 与 tunnel。POSIX 本机可用短 ControlPath、`ControlMaster=auto` 与 `ControlPersist=60` 合并启动阶段的 SSH 会话；Windows 自带 OpenSSH 和 Git OpenSSH 在实测中会 reset multiplex session，因此 Windows 禁用 ControlMaster。两种平台进入 AHP ready 状态后，普通 fs、shell、搜索、subprocess 和 PTY 都走 host 长连接，不存在逐命令握手。

## 本地 picker 的 UTF-16 兼容层

上游 `@deepseek-ai/dsh-host-directory-picker-native@0.1.0-rc.6` 的 Windows worker 只检查 UTF-16LE 码元低字节是否为零，会截断含“开”(U+5F00) 等字符的路径（discussion #396）。bundle 因此禁用 stock picker occupant，并注册 `directory-picker-native-fixed`：Windows 使用 STA FolderBrowserDialog，完整路径以 UTF-16LE Base64 跨进程返回；macOS/Linux 继续调用上游 `pickNativeDirectory`。这层只改变 host capability，不改变组合后的 LOCAL/Remote workspace 流。

## 失败域

- alias tombstoned：明确报映射已移除；
- SSH 认证/网络失败：返回 ssh 错误，不切 local；
- 远端 executable 缺失：远端 exit 127，不查本机；
- AHP bootstrap/协议失败：远端 fs 调用失败；
- restrictive shell policy：明确拒绝；
- remote `rg` 缺失：普通 glob/grep 工具失败；
- mapper 收到远端 alias 外路径：拒绝，避免把本机路径发送到远端。

## 非目标与后续

- 不实现第二套远端工具或自定义 daemon；
- 不实现经典 Remote Agent 私有 wire protocol；
- 不声称本地 sandbox 能约束远端内核；
- 当前不支持 Windows SSH 远端；
- live stdin 输入泵依赖远端 POSIX `mkfifo` 与 `base64 -d`；
- AHP stdout/stderr Resource polling 当前每次读取整文件，尚无 range/offset read；
- 当前不自动安装远端 bash/pwsh/rg/code。
