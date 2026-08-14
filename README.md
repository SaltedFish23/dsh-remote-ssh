# dsh Remote SSH

`dsh-remote-ssh` 为 DeepSeek Harness 提供透明的本机/Remote SSH 工作区路由。模型仍然只看到普通的 `read`、`write`、`edit`、`glob`、`grep`、`bash`、`pwsh` 和后台任务等工具，不会出现一套额外的 `remote_*` 工具。

执行位置只由当前工作区决定：

- `LOCAL > project`：文件、shell、搜索和 subprocess 使用本机 provider；
- `Laptop > project`：相同工具通过 SSH/AHP 在 Laptop 上解析路径和执行命令；
- 远端断线、命令不存在或映射被移除：明确失败，绝不回退本机。

## 功能

- 自动读取 OpenSSH 用户/系统配置及递归 `Include`，并列出其中的具体 `Host`；
- Settings 中选择配置文件、添加 SSH 主机和管理多个远端工作区；
- 远端工作区路径可通过服务器端目录选择器浏览、输入绝对路径并回填，不要求记忆路径；
- 工作区选择器同时提供 `LOCAL` 与 Remote SSH 服务器；
- 会话树使用 `LOCAL > ...` / `<服务器名> > ...` 标题；
- 全局 `ctx.fs` 根据 cwd/path 透明选择本地或远端 AHP filesystem；
- 全局 `ctx.subprocess` 根据 cwd 透明选择本地进程或 host-scoped AHP；
- 普通工具名直接复用透明 provider；Remote `bash` 以每 Agent 一个 AHP PTY 的形式持久化；
- `bash` 与 `pwsh` 使用互不冲突的 Loader 条目，随后按会话工作区裁剪：POSIX/Linux Remote 只暴露 `bash`，Windows LOCAL 只暴露 `pwsh`；
- Remote `bash` 的 cwd、`export`、激活环境、函数和 shell 后台任务跨工具调用保留；Agent 销毁、超时或 shell 退出时回收/重建 PTY；
- bash 命令直接写入持久 AHP Terminal，不再为每次调用生成 `command-*.sh`；
- 远端 terminal 工具卡显示 `<服务器> > <工作区>`，不再泄露内部 UUID alias；
- 远端 AHP/SSH 隧道按 host 惰性创建；同一服务器的多个 workspace 共享一个 runtime；
- 远端 workspace alias 是身份记录，不同步文件；
- 删除远端映射后保留 alias、DSH Workspace 与 Session 历史（远端墓碑）。旧会话可阅读，但后续工具调用明确失败。

目前远端支持 POSIX/Linux。Windows SSH 远端尚未适配。

## 安装与启动

```powershell
cd E:\source\ai\dsh\remote-ssh
pnpm install
pnpm run check

dsh plugin --profile web add 'link:E:/source/ai/dsh/remote-ssh'
dsh --profile web
```

打开 Settings → Remote SSH，插件会直接读取平台默认的用户和系统 OpenSSH 配置。可测试其中已有的 Host、选择一个配置文件添加新 Host，然后用“浏览远端…”选择工作区目录；路径输入框仍可用于直接粘贴绝对路径。

如需覆盖默认发现位置，在 Settings → 插件 → Remote SSH 中填写一个自定义 SSH 配置文件的绝对路径；留空则恢复用户和系统默认配置。

也可用环境变量提供初始配置：

```powershell
$env:DSH_REMOTE_SSH_TARGET = 'my-laptop'
$env:DSH_REMOTE_SSH_LABEL = 'My Laptop'
$env:DSH_REMOTE_SSH_WORKSPACE = '/srv/project'
$env:DSH_REMOTE_SSH_ALIAS_ROOT = 'C:\Users\me\.dsh\remote-ssh\workspaces' # 可选
$env:DSH_REMOTE_SSH_LOCAL_WORKSPACE = 'C:\Users\me\.dsh\remote-ssh\project' # 可选
$env:DSH_REMOTE_SSH_CODE = 'code' # 可选
dsh --profile web
```

这些环境变量只是 settings 的初始/base 层；之后可在页面管理服务器和映射。

## 远端前置条件

- 非交互可用的系统 OpenSSH 连接；
- POSIX shell；
- VS Code CLI/Server 可用于 AHP filesystem（插件会尝试 `code agent host`，并兼容 VS Code Server 的 sibling `server/bin/code-server` 布局）；
- `bash`、`base64`、`mkfifo`、`rg` 等工具按实际需要安装在远端。

命令解析发生在当前工作区所属主机。当前 POSIX/Linux Remote 工作区只向模型提供普通 `bash` 工具；Windows LOCAL 工作区只提供普通 `pwsh`。工具名没有 `remote_` 前缀，Host 操作系统也不会替远端错误裁剪工具。

## 实现概览

```text
普通 DSH 工具
    │ cwd / path
    ▼
透明 fs / subprocess / shell router
    ├── LOCAL alias ──► 本机 provider
    └── Remote alias ─► host-scoped AHP fs/terminal/resource
```

系统 OpenSSH 只负责 `~/.ssh/config`、SSH Agent、known_hosts、ProxyJump、AHP bootstrap 与持久 tunnel；不会为每条工具命令重新握手。远端不安装 DSH，也不上传自定义 daemon。同一 host 的文件、持久 Bash PTY、普通 subprocess 和交互 PTY 都复用一个 AHP 长连接。每个 Agent 的普通 `bash` 调用复用同一个 AHP Terminal；普通非 PTY subprocess 才把 stdout/stderr 分别写入临时 Resource 文件，经同一 WebSocket 增量采集。live stdin 通过第二条 AHP Terminal 把 Base64 分块写入远端 FIFO，EOF、取消和 FIFO 清理均属于同一进程生命周期，不再存在逐命令 SSH fallback。

AHP host runtime 请求远端 `/` 的 Resource 能力，以匹配 DSH 权限模型：`danger-full-access` 可以访问同一主机上的其他绝对路径；`workspace-write` 的写操作仍按本次调用的 `workspaceRoot` 检查；`read-only` 拒绝写入。连接共享不等于 workspace 隔离。

## 远端墓碑语义

删除服务器或工作区映射时：

1. 从活动路由和 Settings 列表移除映射；
2. 关闭该映射已创建的远端 context；
3. 不删除本地 alias 目录；
4. 不删除 DSH Workspace、Session 或消息日志；
5. 永久记住该 alias 曾属于远端。

因此历史会话仍能打开和阅读，但任何以旧 alias 为 cwd/path 的新文件或进程调用都会报 `workspace alias is no longer configured`。这是 fail-closed 设计，防止同一路径被误当成本机目录。

## 统一目录选择器

`LOCAL` 和 Remote 使用同一个插件内目录浏览器组件：都可以编辑绝对路径、按 Enter 跳转、回到主目录、进入上级/子目录并选择当前文件夹。两者只在数据源上不同：LOCAL 通过 Harness Host browse API 列出本机目录，Remote 通过所选 SSH host 的共享 AHP 连接列出远端目录。

目录选择链路不再启动系统原生对话框，不依赖 `koffi`，也不会生成临时 picker worker，因此直接避开 [deepseek-harness discussion #396](https://github.com/deepseek-ai/deepseek-harness/discussions/396) 中的 Windows UTF-16 路径截断问题，同时保证本机与远端 100% 一致的选择体验。

## 安全模型

AHP permission 不能约束任意远端 shell。bundle 使用 `danger-full-access` / `approval never`，真正边界是 SSH 账号、远端 Unix 权限及容器/VM。restrictive shell policy 会被明确拒绝，不会伪装为已 sandbox。

## 当前限制

- 仅支持 POSIX/Linux SSH 远端；
- AHP filesystem、持久 Bash PTY、交互 PTY 以及 ignore/fixed/live-stdin 的普通 subprocess 全部复用 host 连接；
- AHP subprocess 通过轮询远端临时 stdout/stderr Resource 提供增量输出；极高吞吐、超大输出场景仍需进一步优化为 offset/range 协议；
- 远端 PTY 可发送 Ctrl-C，但无法可靠检查或定向其他 foreground process-group signal；
- subprocess bounded output 只保留内存尾部，尚无远端 spill file；
- AHP Resource 读取仍是整文件返回，默认上限 64 MiB；
- 搜索依赖远端 `rg`；缺失时诚实失败；
- 密码和首次 host-key 提示没有 Web 交互桥，请先在终端完成确认并使用 key/agent 认证；
- AHP 仍是 draft，VS Code 更新可能需要适配。

## 开发验证

```powershell
pnpm run check
node scripts/integration-ssh.mjs my-laptop /tmp/dsh-remote-ssh-integration/workspace
node scripts/integration-transparent.mjs my-laptop /tmp/dsh-remote-ssh-integration/workspace
```

`integration-transparent.mjs` 同时证明远端 fs、远端 cwd/hostname、独立 stdout/stderr、非零退出码、fixed/live stdin、取消与 FIFO 清理、零 subprocess SSH fallback、透明 shell，以及相同 `ctx.fs` 的本地读取。

更多架构约束见 [docs/design.md](docs/design.md)，当前交接状态见 [PROGRESS.md](PROGRESS.md)。

## 许可边界

插件只调用用户安装的 VS Code CLI/Server，并使用 MIT 许可的 `@microsoft/agent-host-protocol`；不会复制、修改或分发 VS Code Server。用户运行官方 Server 仍受 Microsoft VS Code Server License Terms 约束。
