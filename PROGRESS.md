# DeepSeek Harness Remote SSH：实现进度

> 2026-08-14 状态：多服务器 UI、透明路由、host-scoped AHP runtime、全 stdin 模式 AHP subprocess/PTY、远端墓碑、本机/远端统一目录浏览器和 Laptop 真实端到端均已实现并验证。仍属于可运行原型，主要剩余项是 Windows SSH 远端和超大输出优化。

## 工作区边界

- 插件：`E:\source\ai\dsh\remote-ssh`
- 参考仓库：`E:\source\ai\deepseek-harness`
- Harness checkout 只用于阅读、构建临时 profile 和运行 Web；源码工作树为 `master...origin/master` 且无修改。
- 所有实现、测试、构建产物与临时 DSH_HOME 都在插件目录。

## 已完成

### 1. 多服务器与工作区 Catalog

- Settings 中可添加、测试、删除多个 SSH server；
- 每台 server 可添加多个 POSIX remote workspace；
- 工作区树标题为 `<Server> > <basename>`；
- 本地 picker 采用 `LOCAL > <basename>`；
- 环境变量可注入初始 server/workspace；Settings 作为 live 配置层；
- alias 目录位于 DSH_HOME 下，只有身份与 cwd 作用，不同步远端内容。

### 2. 透明代理范式

`cordis.patch.yml` 保留普通模型工具名，并替换底层 capability：

- 隔离原有本地 fs/subprocess，桥接为 private provider；
- 根 `ctx.fs` 由 `TransparentFileSystem` 路由；
- 根 `ctx.subprocess` 由 `TransparentSubprocessRuntime` 路由；
- bash/pwsh 工具不提供 remote 工具；Remote Bash 每个 Agent 复用一个持久 AHP Terminal；
- 内置 glob/grep 复用 routed subprocess，因此远端调用远端 `rg`；
- 前台、后台、stdout/stderr、exit code 均按 cwd 所属 workspace 选择执行主机；
- 远端失败不会回退 local。

### 3. 远端 filesystem

- 系统 OpenSSH bootstrap 与 tunnel；
- 优先 `code agent host`，兼容 VS Code Server sibling `server/bin/code-server`；
- `@microsoft/agent-host-protocol` 0.4.0–0.8.0 协商；
- Resource read/write/list/mkdir/delete/move；
- AHP etag → DSH FsVersion；
- create-only、if-match、stale version 与 workspace write policy；
- 每 remote host 惰性创建一个 AHP context；多个 workspace 共享 connection/client，但各自拥有 path mapper 与 fs/shell view；
- host AHP 请求 `/`，Full Access 可跨 workspace；workspace-write/read-only 继续按 DSH per-call policy 检查。

### 4. 透明 subprocess/shell

- ignore/fixed/live-stdin 的 remote `spawn` 全部使用共享 AHP；stdout/stderr 分别重定向到 Resource 并增量采集；
- live stdin 使用第二条 AHP Terminal + Base64 分块 + 远端 FIFO，EOF/取消后清理 FIFO；
- POSIX quoting，不拼接未转义 argv；
- 本机绝对 `.exe` 路径远端化时只用 basename，让 remote PATH 重新解析；
- stdout/stderr 独立收集，支持 pipe/inherit/bounded tail；
- remote interactive terminal 使用 AHP createTerminal/Input/Data；
- Remote Bash 直接组合 Harness 的 `dsh-terminal`、`dsh-terminal-bash` 与 `dsh-tool-bash-persistent`；底层 routed `spawnTerminal()` 选择 AHP PTY；
- 每个 Agent 的 cwd、环境变量、激活环境、函数和后台 shell 状态跨 `bash` 调用保留；调用按 owner 串行，Agent dispose 时等待 PTY 回收；
- bash 命令通过 TerminalInput 直接进入持久 shell，每次调用不再生成远端 `command-*.sh` Resource；
- Agent policy 按工作区裁剪为 POSIX Remote 的 `bash` 或 Windows LOCAL 的 `pwsh`；远端 presenter 将内部 UUID alias 投影为 `<Server> > <workspace>`；
- restrictive sandbox mode 明确失败；
- AHP Terminal shell 已修复为 RS/US marker framing，不依赖远端 command-detection events。
- OpenSSH 只承担 host bootstrap/tunnel；POSIX 可用 ControlMaster 合并启动连接，Windows 禁用不可靠 multiplex，但两者均无逐命令 SSH。

### 5. 本机/远端统一目录浏览器

- LOCAL 和 Remote 共用同一个 `WorkspaceDirectoryPicker` 渲染组件；
- LOCAL 目录来自 Harness Host browse API，Remote 目录来自所选 host 的共享 AHP 连接；
- 两端都支持绝对路径输入、Enter 跳转、主目录、上一级、子目录导航和选择当前文件夹；
- 目录选择链路不再加载 native picker，不依赖 `koffi`，也不生成临时 worker，直接避开 #396 的 Windows UTF-16 路径截断链路。

### 6. 远端墓碑

删除 workspace 或 server 后：

- active route 与远端 context 被移除；
- Settings 不再显示该 mapping；
- alias 目录、Workspace record 和 Session 日志不删除；
- manager 永久保留 alias 曾经属于 remote 的事实；
- 旧会话仍可打开阅读；任何新工具调用报 `workspace alias is no longer configured`；
- 不可能把旧 alias 当本机目录执行。

已新增单元回归：删除发布路由后验证 alias 仍存在、workspace lookup 失败、旧 cwd 和旧 absolute path 均 fail closed。

### 7. Web UI

已在真实 DSH Web profile 验证：

- Settings 导航出现 `Remote SSH`，并自动读取用户/系统 OpenSSH 配置和递归 `Include`；
- 当前本机配置可发现 8 个具体 Host，且无解析错误；
- “添加新 SSH 主机”可选择要更新的用户或系统配置文件；
- Settings → 插件 → Remote SSH 提供自定义 SSH 配置绝对路径；
- 自定义配置路径和 SSH 命令都是 36px 高的单行输入框，最大宽度 520px；
- “浏览远端…”通过所选 host 的共享 AHP 连接打开远端主目录，可进入上级/子目录、输入绝对路径并回填；
- Laptop 实机目录浏览返回绝对 POSIX 路径并列出 28 个子目录，进入子目录后的回填已验证；
- LOCAL 与 Remote 使用完全相同的插件内目录浏览器，只有目录数据源不同；
- 非法相对配置路径返回 400 且不改变当前配置；
- connection probe 如实报告远端命令是否存在，不会借用本机命令；
- “添加工作区” dialog 同时显示 `LOCAL · 选择本机文件夹…` 和远端服务器/path 输入。

## 已完成验证

### 单元、类型与构建

`pnpm run check` 覆盖：

- real Cordis patch parse/composition 语义；
- path mapper 与 file URI；
- AHP filesystem；
- AHP Terminal framing；
- transparent shell；
- multi-workspace routing、invalid server 与 tombstone；
- TypeScript node/client build。

最终数量以本次结尾的 `vitest` 输出为准（当前为 8 个 test files、30 个 tests）。SSH config 和远端目录测试只使用临时文件、合成别名和 RFC 文档地址，不读取或复制开发机配置。

### Laptop AHP 集成

目标：

```text
SSH alias: Laptop-Yan
workspace: /tmp/dsh-remote-ssh-integration/workspace
seed.txt:  laptop-seed\n
```

`scripts/integration-ssh.mjs` 已证明：

- AHP 0.8.0；
- remote filesystem 读取 seed；
- terminal cwd 是远端 workspace；
- hostname 为 Laptop；
- 非零 exit code 7 正确返回。

### Laptop 透明路由集成

`scripts/integration-transparent.mjs` 已证明同一 root Context 下：

- `ctx.fs` 在 remote alias 读取 Laptop seed；
- `ctx.subprocess` 的 cwd/hostname 在 Laptop；
- stdout/stderr 分离；
- exit code 11；
- `subprocessSshFallbacks` 为 0，ignore/fixed/live-stdin subprocess 都走 AHP；
- live stdin 的中英文分块、EOF、SIGTERM 取消和 FIFO 无残留均已验证；
- `ctx.shell` 输出 `shell-host=Laptop`；
- 真实 Web profile 的 Laptop 工作区 Agent 工具目录只包含 `bash`，Windows LOCAL Agent 只包含 `pwsh`；
- Laptop 同一 Agent 连续两次 `bash` 调用只创建一个 AHP Terminal：第一次 `cd /home/yan/bot/coffee` 并 `export`，第二次得到相同 cwd 与环境变量；
- 实机观测 `command-*.sh` Resource 写入为 0；terminal presenter 返回 `/Laptop-Yan > bot`，不显示 alias UUID；
- 两个 Laptop workspace 的 `sharedHostRuntime` 为 `true`；
- AHP interactive terminal 返回 Laptop hostname 与 exit code 6；
- 同一个 `ctx.fs` 在 local cwd 读取本插件 `package.json`。

## 关键文件

- `src/manager.ts`：server/workspace catalog、route、lazy context、tombstone；
- `src/router-fs.ts`：透明 local/remote filesystem；
- `src/router-subprocess.ts`：透明 local/remote subprocess 与 terminal；
- `src/shell-transparent.ts`：bash/pwsh dialect；
- `src/agent-policy.ts`：Session execution-world 绑定、workspace shell 裁剪与 terminal cwd 投影；
- `src/index.ts`：SSH/AHP bootstrap 与 path mapper；
- `src/fs.ts`、`src/shell.ts`：AHP fs/terminal；
- `src/web.ts`、`src/client/index.tsx`：Settings API 与 Web UI；
- `cordis.patch.yml`：真实 bundle composition；
- `tests/manager.spec.ts`：墓碑 fail-closed 回归；
- `scripts/integration-ssh.mjs`、`scripts/integration-transparent.mjs`：Laptop 集成。

## 尚未完成

1. 只支持 POSIX/Linux remote path 与 quoting；Windows SSH 远端未实现。
2. live stdin 输入泵依赖远端 `mkfifo` 与 `base64 -d`。
3. Remote PTY 无 foreground process-group introspection；Ctrl-C/Ctrl-Z 可发送，其他定向 signal 明确失败。
4. bounded subprocess output 只有内存 tail，没有远端 spill file。
5. AHP subprocess 轮询时会重复读取完整 stdout/stderr Resource；超大输出尚无 range/offset 优化。
6. 密码、MFA 与首次 host-key prompt 没有 Web bridge；当前要求非交互 key/agent。
7. `rg`、`pwsh`、VS Code CLI/Server 不自动安装；remote 缺失即失败。
8. 还没有多台真实 SSH server 的并发压力、断线重连和长时间 soak 测试。
9. AHP draft 版本变化仍需持续兼容测试。

## 后续建议顺序

1. 把 AHP subprocess Resource polling 优化为 offset/range 或 bounded remote tail，避免超大输出重复传输；
2. 增加 server health/reconnect 状态与更精确错误分类；
3. 补远端 background kill、timeout、断线和大输出集成测试；
4. 设计 Windows remote path/dialect abstraction；
5. 在第二台真实 server 上验证多 host 并发与 tombstone 后重建 mapping。

## 安全与许可

- AHP Resource permission 不等于 shell sandbox；真正边界是 SSH 账号、远端 OS 权限、容器/VM；
- bundle 使用 danger-full-access / approval never；restrictive shell 请求明确拒绝；
- 插件不分发 VS Code Server，只调用用户已有 CLI/Server；官方 Server 的使用仍受 Microsoft 许可条款约束。
