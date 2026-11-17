# wecom-agent-bridge

把企业微信消息交给本机的 Codex 或 Claude Code 处理，结果由机器人回复到原单聊或群聊。支持续接聊天、按群绑定项目和保存常用约定。默认后端为 Codex。

## 快速开始

运行环境：

- Windows、macOS 或 Linux，Node.js 24 或以上。
- 已安装并登录 Codex CLI 或 [Claude Code](#使用-claude-code)，版本要求见下表。
- 已开启长连接的企业微信智能机器人，以及对应的 Secret。
- 已授权的 `wecom-cli`，参阅[官方安装与授权文档](https://github.com/WecomTeam/wecom-cli#快速开始)。运行 `wecom-cli identity whoami` 检查当前身份。

| 后端 | 参数要求的最低版本 | 必需接口与参数 | 本机检查版本 |
| --- | --- | --- | --- |
| Codex | **0.166.0** | `exec resume --json`、app-server `thread/queue/add`、`queue --thread --message --resume` | `0.169.0-alpha.11.1`（桌面版内置） |
| Claude Code | **2.1.259** | `--print`、`--output-format stream-json`、`--verbose`、`--resume`、`--permission-prompts none` 和 `auth status` | `2.1.325` |

版本依据：[Codex 0.166.0](https://github.com/openai/codex/releases/tag/rust-v0.166.0) 新增 `queue --resume`，[Claude Code 2.1.259](https://github.com/anthropics/claude-code/releases/tag/v2.1.259) 新增 `--permission-prompts none`。旧版本未逐一联调，Codex 队列 API 仍为实验性接口；安装后请运行 `--check` 并测试消息回发。

找不到 CLI 时，将 `CODEX_CLI_PATH` 或 `CLAUDE_CLI_PATH` 设为对应可执行文件的绝对路径。桥接分别适配两种 CLI，命令参数不通用。

在仓库目录运行：

```sh
npm ci
node start.cjs --check
node start.cjs
```

`--check` 检查 CLI、企微身份和工作目录。启动后按提示输入 Secret；日志出现 `authenticated` 后，私聊机器人发送 **请只回复「连接成功」**，确认能收到回复。群聊中需要先 @ 机器人。

未配置目标且没有上次记录时，第一条普通消息会在启动目录创建聊天。终端实时输出日志，按 Ctrl+C 停止。也可在另一个终端查看或停止服务：

```sh
node src/control.cjs status
node src/control.cjs stop
```

停止服务会终止本地任务及其子进程。排队中的任务保留，已中断的任务不会自动重跑。

## 使用 Claude Code

安装并登录 **Claude Code 2.1.259 或以上版本**，无需同时安装 Codex。

在 `.config.local.json` 中设置后端和默认目录：

```json
{
  "backend": "claude",
  "backends": {
    "claude": {
      "workingDir": "D:/projects/demo",
      "threadId": ""
    }
  }
}
```

按快速开始中的步骤检查并启动。第一条普通消息创建聊天，后续消息继续使用该聊天。[企微指令](#企微指令)在两个后端均可使用。

Claude 当前只执行本人任务。需要人工审批的工具操作会被拒绝；如需放行，请先修改本机 Claude 权限配置。

建议让桥接创建独立聊天。使用 `/thread` 续接已有聊天前，请先停止该聊天的其他运行实例。桥接不会向正在运行的 Claude 终端或桌面聊天追加任务，也不会唤醒桌面。

## 给项目群绑定工作目录

在群里 @ 机器人，依次发送：

```text
/bind D:/projects/demo
请概括这个项目的用途，用两句话回复。
/status
```

`/bind` 将当前群绑定到指定目录；第一条任务会新建聊天，`/status` 可查看执行和回发状态。私聊中的 `/new` 不会改变这个群的目标。目录必须已存在，macOS 和 Linux 使用 `/home/me/projects/demo` 等本机绝对路径。

## 企微指令

私聊直接输入指令，群聊先 @ 机器人，再输入指令。`/help` 对所有发送者开放，其余管理指令由 `wecom-cli` 绑定的本人账号使用。

| 指令 | 用途 |
| --- | --- |
| `/help` | 查看全部指令和用法。 |
| `/backend` · `/backend codex` · `/backend claude` | 查看当前后端，或切换整个机器人的后端，仅限本人。首次切换会检查对应 CLI、授权及目标目录；失败保留原后端。 |
| `/status` | 查看下一条消息的目标、目录和配置来源，以及本会话上一条普通任务的实际目标、附件保存数量和回发进度。 |
| `/bind` · `/bind <绝对目录>` · `/bind off` | 固定当前目标、绑定一个目录并在下条普通消息时新建聊天，或恢复机器人默认目标。 |
| `/threads` · `/thread <ID 或深度链接>` | 列出当前目录的未归档聊天，或切换到已有聊天及其工作目录。 |
| `/history` | 列出当前后端通过桥接投递过普通任务的聊天 ID 和工作目录，按最近使用排序，最多 20 条，并标记当前目标。仅查看或切换目标不会新增使用记录。 |
| `/new` · `/cwd <绝对目录>` | 在当前目录或指定目录开启新聊天。聊天在下一条普通消息到达时创建。 |
| `/retry` | 重试本会话上一条普通任务中确定失败的环节。回发失败时，从首个未发出的分段继续。只有此前投递明确被拒绝，才会重新提交任务。 |
| `/cancel` | 取消本企微会话上一条普通任务。尚未执行的任务直接取消，本地执行中的任务终止进程；已完成的任务不受影响。已交给 Codex 桌面队列的任务须在目标聊天中停止。 |
| `/memory [内容]` · `/记忆 [内容]` | 不带内容时查看当前范围内的约定及编号，带内容时保存。例如 `/memory 测试命令 = npm test`，再次保存同名约定会更新内容。 |
| `/忘记 #1` · `/forget #1` | 删除指定约定，也可填写名称或完整原文。 |

未绑定的会话共用机器人默认目标。绑定后，`/cwd`、`/thread` 和 `/new` 只作用于当前企微会话。已入队的任务保留原目标和回发地址。

记忆按后端、机器人、企微会话、本人账号和工作目录隔离，不绑定聊天 ID。每份最多 20 条，每条最多 1000 个字符。同目录使用 `/new` 后仍沿用原记忆。

`/backend` 切换整个机器人的后端，已有任务继续执行。两个后端分别保存目标、绑定、队列和记忆，共用机器人连接。重启后使用配置中的 `backend`，其他后端的队列在切换到该后端时恢复。查询或重试旧任务，需要先切回对应后端。

`/history` 汇总当前后端各企微会话的使用记录，保存在该后端状态目录的 `memory/<机器人标识>/commands.sqlite` 中。新聊天创建后自动补上 ID。升级前的历史只能从各会话保留的最后一个任务补录。

`/cancel` 始终作用于当前后端、本企微会话的上一条任务，即使已经切换项目。取消和超时不会撤销已有改动，也不会自动重跑任务。

## 默认项目和聊天

将 [.config.sample.json](.config.sample.json) 复制为 `.config.local.json`，按需设置字段。例如，只指定工作目录：

```json
{
  "workingDir": "D:/projects/demo"
}
```

- `workingDir` 是本机已存在的绝对目录。`threadId` 接受聊天 UUID、`codex://threads/<UUID>` 或 Codex 复制的 Markdown 深度链接。
- `.config.local.json` 每次启动读取一次。`backend` 默认为 `codex`，`backends.codex` 和 `backends.claude` 分别设置两个后端。顶层 `workingDir`、`threadId` 仅用于 Codex。
- 未绑定的会话每次收消息时重新读取对应后端的 `last-target.json`：Codex 在 `.state/`，Claude 在 `.state/backends/claude/`。缺少的字段从本次启动读取的默认配置补充，删除上次记录同样立即生效。运行中编辑 `.config.local.json` 不会改变已读取的默认值，重启后才生效。
- 同时指定两个字段时，使用显式目录。只有聊天 ID 时，使用聊天记录中的目录。只有目录时，首条普通消息会新建聊天，以后可在重启后续接。
- 多个企微会话指向同一个 Codex 聊天时，共享该聊天的历史。需要独立上下文的群可以使用 `/bind <目录>`。

`taskTimeoutMs` 设置单次 CLI 执行时限，默认 `1800000`（30 分钟），设为 `0` 关闭，修改后重启生效。两个后端共用此配置，排队时间不计入。超时会终止进程并通知原会话，`/status` 显示“执行超时”。已交给 Codex 桌面队列的任务不受此时限控制。

## 执行权限

“本人”指 `wecom-cli` 授权账号，桥接通过企微回调中的发送者 ID 判断。

| 来源与后端 | 执行方式 |
| --- | --- |
| 本人 → Codex | 续接选定聊天，沿用原有审批策略。本地 CLI 允许联网；桌面队列沿用目标聊天的权限。 |
| 其他人 → Codex | 每条消息新建临时会话，使用 `workspace-write`。允许联网、目录内写入，也允许读取目录外当前账户可读的文件。Windows 使用 elevated 沙箱。突破沙箱的操作会被拒绝，不会转入本人聊天。 |
| 本人 → Claude | 沿用本机工具权限。`--permission-prompts none` 拒绝需要人工审批的操作。 |
| 其他人 → Claude | 不执行任务，回复未执行通知。仍可使用 `/help`。 |

GitLab 等私有服务需要运行环境已有相应授权。

## Secret 和本地数据

Secret 按以下顺序读取：当前进程的 `WECOM_BOT_SECRET` → 本地保存的 Secret → 终端输入。环境变量中的 Secret 不会保存。手动输入以星号显示，认证成功后明文保存到 `.state/bot-<机器人 ID 的 SHA-256>.secret`；macOS 和 Linux 的新建文件权限为 `0600`。

替换 Secret：停止桥接，在未设置 `WECOM_BOT_SECRET` 的终端运行 `node start.cjs --replace-secret`。

Codex 的状态保存在 `.state/`，Claude 保存在 `.state/backends/claude/`，包括目标、绑定、队列、附件、记忆和日志。`.state/` 和 `.config.local.json` 均已加入 Git 忽略规则。

## 消息投递与排查

Codex 聊天被桌面版占用时，桥接通过 app-server 排队，用 `clientUserMessageId` 匹配最终答复。

Codex 使用 `--skip-git-repo-check`，工作目录不必是 Git 仓库。CLI 退出时记录 `cli_exited`，包含命令、退出码、终止信号和脱敏错误摘要。

两个后端都记录耗时 `elapsedMs`，中断时记录 `stopReason`。Claude 另记录模型、API 耗时、轮次、费用、用量及 `permissionDenials`（工具权限拒绝记录），不保存工具参数或完整事件。进程正常退出时也可能有操作被拒绝，请结合最终答复查看。

Claude 报告 `session_writes_lost` 时，日志会出现 `cli_warning`，列出保存失败的数据和磁盘错误。已生成的答复照常回发，但聊天记录可能不完整；请检查磁盘空间、配额和聊天历史。

投递失败会通知原企微会话。CLI 暂时无法启动时，任务保留并自动重试；明确被拒绝的任务可在修复后发送 `/retry`。结果未知时先检查目标聊天，避免重复执行。`/status` 会区分任务答复与失败通知。

桥接通过 WebSocket 接收消息，用 `wecom-cli` 回发。文本和语音转写随正文发送，图片、文件和视频先保存到本机，再将路径交给后端；下载失败会在消息中标出。回复默认简洁，正文要求的代码、命令、文案和格式仍完整保留。

| 现象 | 在哪里看、如何处理 |
| --- | --- |
| 消息去了意外的项目或聊天 | 在原会话发 `/status`，分别检查下一条消息的目标和上一条任务的实际目标。绑定目录被移动后可用 `/bind <新目录>` 或 `/bind off` 恢复。 |
| 长任务暂时没有最终答复 | 后端开始处理或确认入队后，超过 60 秒仍在等待时会发一次进度回执。若桌面正在占用目标聊天，桥接会把消息排入该聊天，按队列回执匹配最终答复。 |
| 最终答复回发失败 | `/status` 可查回发状态。长答复按 UTF-8 大小分段，`/retry` 可继续回发已保存的答复。发送结果未知时应先检查原会话，避免重复。 |
| 启动前发的消息没有出现 | 桥接接收在线推送。重启会恢复本机已入队的任务；离线期间的聊天历史不会补拉。同一机器人的另一个长连接客户端上线可能替换当前连接。 |

终端和各后端的 `events.jsonl` 记录目录 `workingDir`、聊天 `threadId`、发送者 `senderId` 和事件说明。用 `requestId` 或 `wecomRequestId` 查找同一条消息的相关日志。

| 事件 | 含义 |
| --- | --- |
| `authenticated` | 企微长连接已认证。 |
| `backend_switched` / `backend_switch_failed` | 已切换后续消息使用的后端 / 切换失败且保留原后端。 |
| `delivery_queued` / `delivery_submitted` | 消息已写入本地队列 / 目标聊天已开始处理。 |
| `delivery_queued_in_codex` / `desktop_wake_requested` | 消息已进入 Codex 桌面队列 / 桥接已请求桌面唤醒聊天。 |
| `cli_exited` | CLI 已退出，记录退出码、终止信号和脱敏错误摘要。 |
| `cli_warning` | Claude 会话记录或全局配置未能保存；不撤回已生成的答复。 |
| `delivery_completed` / `reply_ready` / `reply_sent` | 本轮直接执行已完成 / 回发内容已就绪 / 企微已确认回发。带 `failureReason` 时为失败通知。 |
| `delivery_uncertain` / `reply_uncertain` | 投递或回发结果未知，桥接停止自动重发。 |

## 开发

| 模块 | 职责 |
| --- | --- |
| [main.cjs](src/main.cjs) | 企微连接和后端切换 |
| [backend-runtime.cjs](src/backend-runtime.cjs) | 各后端的目标、绑定和指令 |
| [target-config.cjs](src/target-config.cjs) | 启动配置与上次目标 |
| [message-routing.cjs](src/message-routing.cjs) | 跨后端消息去重 |
| [delivery.cjs](src/delivery.cjs) · [replies.cjs](src/replies.cjs) | 任务投递、答复分段和重试 |
| [codex.cjs](src/backends/codex.cjs) | Codex CLI 调用和桌面聊天续接 |
| [claude.cjs](src/backends/claude.cjs) | Claude CLI 调用及 Agent SDK 本地会话查询 |

接入新后端：在 `src/backends/` 实现适配器，并更新[启动入口](start.cjs)、[运行时加载](src/backends/load.cjs)及配置和指令中的后端校验。适配器提供 `id`、`name`、`parseThreadId`、`getWorkingDir`、`listThreads` 和 `submit`。

创建聊天时调用 `onCreated(id)`，开始处理时调用 `onStarted()`。完成后返回 `{ state: 'completed', text }`；异步受理返回 `{ state: 'accepted', queueId }`，通过 `readReplies` 提供最终答复。可选的 `getThreadTitle` 查询聊天标题，`/status` 等待超过 800 毫秒后显示 ID。

支持取消的适配器声明 `supportsCancellation: true`，处理 `submit` 的 `signal` 和 `timeoutMs`；`submitExternal` 使用相同约定。进程生命周期由 [process-lifecycle.cjs](src/process-lifecycle.cjs) 管理。停止后返回 `uncertain` 和 `task_cancelled`、`task_timeout` 或 `bridge_stopped` 原因，避免自动重复执行。转交无法取消的远程队列前调用 `onDetached()`。执行统计通过 `onDiagnostic` 提交，会话保存警告通过 `onWarning` 提交。

只有确认尚未提交且可以重试时才返回 `queued`，明确拒绝返回 `rejected`，结果未知返回 `uncertain`。可参考[替代后端集成测试](test/backend-bridge.test.cjs)验证单聊、群聊、目标切换和重启续接。

## 测试

```sh
npm test
```

离线回归测试覆盖消息解析、权限、超时取消、进程清理、指令、队列和重启恢复，不调用模型或发送企微消息。

已安装并登录 Claude 后，可选运行：

```sh
npm run test:claude:smoke
```

此测试调用真实 Claude CLI，会消耗模型额度。它检查新建聊天、续接、权限拒绝和回发路由，企微发送端使用本地替代实现，不会给机器人发消息。

默认使用本机模型，可用 `CLAUDE_SMOKE_MODEL` 指定；每轮限时 120 秒。测试禁用 Hook、MCP 和技能，仅提供 Read 工具，并禁止读取测试文件。结束后清理临时项目和桥接队列，Claude 的测试聊天记录可能保留。
