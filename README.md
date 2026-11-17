# wecom-agent-bridge

在企业微信里给机器人发消息，让本机的 Codex 或 Claude Code 在指定项目中处理任务，再把最终答复发回原来的单聊或群聊。默认使用 Codex，可续接其桌面聊天；也可以为每个项目群固定工作目录和聊天。

## 快速开始

准备好以下环境：

- Windows、macOS 或 Linux，Node.js 24 或以上。
- 本机安装所选后端的 CLI：默认使用 Codex，也可[使用 Claude Code](#使用-claude-code)。版本要求见下表。如果启动器找不到可执行文件，将 `CODEX_CLI_PATH` 或 `CLAUDE_CLI_PATH` 设为对应 CLI 的绝对路径。
- 已开启长连接的企业微信智能机器人、该机器人的长连接 Secret，以及已授权的 `wecom-cli`（参阅 [wecom-cli 官方安装与授权配置文档](https://github.com/WecomTeam/wecom-cli#快速开始)）。用 `wecom-cli identity whoami` 核对身份。

| 后端 | 最低参数版本 | 所需能力 | 已验证参数能力的版本 |
| --- | --- | --- | --- |
| Codex | **0.166.0** | `exec resume --json`、app-server 的 `thread/queue/add`，以及启动器检查的 `queue --thread --message --resume` | `0.169.0-alpha.11.1`（桌面版内置 CLI） |
| Claude Code | **2.1.259** | `--print`、`--output-format stream-json`、`--verbose`、`--resume`、`--permission-prompts none` 和 `auth status` | `2.1.325` |

最低参数版本依据官方发布记录：[Codex 0.166.0](https://github.com/openai/codex/releases/tag/rust-v0.166.0) 增加了 `queue --resume`；[Claude Code 2.1.259](https://github.com/anthropics/claude-code/releases/tag/v2.1.259) 增加了 `--permission-prompts none`。这不代表所有旧版本均经过完整联调；Codex 的队列 API 仍属于实验性接口。启动器会检查所需 CLI 参数，部署时仍需运行下面的检查及消息回发验证。两个后端使用各自的命令和协议，不能互换 CLI 参数。

在仓库目录运行：

```sh
npm ci
node start.cjs --check
node start.cjs
```

`--check` 核对 CLI、企微身份和目标目录。正式启动后，按提示输入 Secret。看到 `authenticated`，在机器人私聊里发送 **请只回复「连接成功」**。收到「连接成功」即验证了从企微到 Codex 再回到企微的完整链路。群里测试时，先从成员列表选中并 @ 机器人。

首次使用可以跳过配置，第一条普通消息会在启动命令所在目录创建聊天。终端实时显示日志，按 Ctrl+C 停止。也可以在另一个终端运行 `node src/control.cjs status` 查询进程，或运行 `node src/control.cjs stop` 停止服务。停止时会终止桥接启动的本地任务进程及其工具子进程；未开始的任务保留在队列中，已中断的任务不会在重启后自动重跑。

## 使用 Claude Code

本机安装并登录 **Claude Code 2.1.259 或以上版本**，所需能力与验证版本见上表。启动器会检查所选 CLI、Claude 登录状态、企微身份和目标目录；选择 Claude 时无需安装 Codex。如果找不到 CLI，可将 `CLAUDE_CLI_PATH` 设为可执行文件的绝对路径。

在 `.config.local.json` 中选择后端，并按后端保存初始目标：

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

然后运行 `node start.cjs --check`，检查通过后运行 `node start.cjs`。在企微中发送「请只回复连接成功」验证回发。第一条普通消息创建 Claude 会话，后续消息按保存的会话 ID 续接。`/bind`、`/cwd`、`/new`、`/threads`、`/thread <UUID>`、`/status`、`/memory`、`/retry` 和 `/cancel` 均可使用。Claude 的会话列表、标题和目录通过官方 Agent SDK 读取本地元数据，不调用模型；执行任务仍使用本机 CLI。

- `.config.local.json` 是启动默认配置，每次启动读取一次。`backend` 指定默认后端，未填写时为 Codex；运行中可用 `/backend codex` 或 `/backend claude` 切换，无需重连机器人。旧版顶层 `threadId`、`workingDir` 继续用于 Codex，不会交给 Claude；也可以使用 `backends.codex` 分别配置字段。
- Claude 的目标、绑定、队列、附件、记忆和日志保存到 `.state/backends/claude/`，Codex 保持原位置。已记住的目标优先于对应后端的初始配置。切换仅影响后续消息，已打开的后端队列继续处理和回发，切回时沿用各自的目标和绑定。重启只加载默认后端，其他后端的持久化队列在首次切换到它时恢复。机器人 Secret 和长连接共用。
- Claude 第一版只执行企微绑定的本人任务。其他人的普通消息会收到未执行通知；`/help` 仍可使用，不会自动转交 Codex 或本人会话。
- 本人任务沿用本机 Claude 的工具权限配置，不自动增加授权。需要人工审批的操作通过 `--permission-prompts none` 自动拒绝，并由 Claude 说明未完成事项。若要允许某项操作，请先在本机配置合适的权限，再发送任务。
- 建议使用桥接创建的独立 Claude 会话。`/thread` 可恢复本机已有会话，但须先停止该会话的其他运行实例；第一版不向正在运行的终端或桌面窗口排队，也不唤醒桌面。桥接只保证自己的队列串行。
- Claude 运行中若桥接或 CLI 中断，任务标记为结果未知，不会自动重新执行。已保存的最终答复仍可通过 `/retry` 补发；未保存的结果须先检查 Claude 会话再决定后续操作。

## 给项目群绑定工作目录

例如，要让一个群里的任务都在 `D:/projects/demo` 中执行，在群里 @ 机器人，依次发送以下三条消息：

```text
/bind D:/projects/demo
请概括这个项目的用途，用两句话回复。
/status
```

目录须已存在。第一条指令绑定当前群，第二条消息在该目录新建聊天，第三条显示刚才的实际投递和回发情况。之后你在私聊里使用 `/new`，这个群仍会续接自己的聊天。macOS 和 Linux 使用本机绝对路径，例如 `/home/me/projects/demo`。

## 企微指令

桥接按企微回调中的发送者 ID 区分本人和其他人。以下权限说明适用于 Codex；Claude 的本人限制见上节。本人继续使用选定的 Codex 聊天和原有审批策略。桥接启动的 Codex 回合允许联网，排入已打开的桌面聊天时沿用该聊天的权限。其他人的每条消息都在当前工作目录新建临时会话，使用 `workspace-write`，允许联网和目录内写入，允许读取目录外当前账户可读的文件。Windows 使用 elevated 沙箱。需要突破沙箱的操作会被拒绝，不会自动批准，也不会转入本人的桌面聊天。GitLab 私有项目的访问取决于运行环境已有的授权。

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

记忆按机器人、企微会话、本人账号和工作目录保存。每份最多 20 条，每条最多 1000 个字符。同目录使用 `/new` 后仍可沿用这些约定。

`/backend` 不修改本地配置，也不把当前选择保存为启动默认值，重启仍使用配置中的 `backend`。私聊和群聊统一切换；每个后端各自保存群聊绑定。`/status`、`/retry`、`/cancel` 和记忆指令针对当前后端，要管理原后端的任务，先切回原后端。

`/history` 汇总当前机器人在该后端各企微会话的使用记录，保存在对应 `.state` 目录下的 `memory/<机器人标识>/commands.sqlite` 中，重启后仍保留。新聊天生成 ID 后会自动补全。升级时只能补录旧版本保留的各会话最后一个任务目标，无法还原更早的完整历史。

`/cancel` 仅限本人使用，即使随后切换了项目，也会定位当前后端、本企微会话上一条任务的原队列。它不会取消同队列里其他会话的任务。取消和超时不会撤销已产生的文件改动或外部操作，桥接也不会自动重跑；先检查实际结果，再决定是否发送新任务。

## 默认项目和聊天

将 [.config.sample.json](.config.sample.json) 复制为 `.config.local.json`，按需设置字段。例如，只指定工作目录：

```json
{
  "workingDir": "D:/projects/demo"
}
```

- `workingDir` 是本机已存在的绝对目录。`threadId` 接受聊天 UUID、`codex://threads/<UUID>` 或 Codex 复制的 Markdown 深度链接。
- 未绑定的会话每次收消息时重新读取对应后端的 `last-target.json`：Codex 在 `.state/`，Claude 在 `.state/backends/claude/`。缺少的字段从本次启动读取的默认配置补充，删除上次记录同样立即生效。运行中编辑 `.config.local.json` 不会改变已读取的默认值，重启后才生效。
- 同时指定两个字段时，使用显式目录。只有聊天 ID 时，使用聊天记录中的目录。只有目录时，首条普通消息会新建聊天，以后可在重启后续接。
- 多个企微会话指向同一个 Codex 聊天时，共享该聊天的历史。需要独立上下文的群可以使用 `/bind <目录>`。

顶层 `taskTimeoutMs` 控制本地 CLI 单次执行时限，单位为毫秒，默认 `1800000`（30 分钟），设为 `0` 关闭，修改后重启生效。例如 `"taskTimeoutMs": 3600000` 为一小时。Codex 和 Claude 共用此配置，计时从启动 CLI 开始，本地排队时间不计入。超时会终止进程并回发失败通知，`/status` 显示“执行超时”。此时限不控制已经交给 Codex 桌面队列的任务。

## Secret 和本地数据

启动时依次使用当前进程的 `WECOM_BOT_SECRET`、本机已保存的 Secret、终端手动输入。**环境变量提供的 Secret 只在本次启动使用。** 手动输入以星号显示，认证成功后以明文保存到 `.state/bot-<机器人 ID 的 SHA-256>.secret`，macOS 和 Linux 上新建凭据文件的权限为 `0600`。

要替换已保存的 Secret，先停止桥接，然后在未设置该环境变量的终端运行 `node start.cjs --replace-secret`。队列、附件、记忆和事件日志都在本机 `.state/` 下。`.state/` 和 `.config.local.json` 已加入 Git 忽略规则。

## 消息投递与排查

目标聊天被桌面版占用时，桥接通过 app-server 排队，并用显式的 `clientUserMessageId` 匹配最终答复。队列项 ID 和用户消息 ID 分别处理。发送长任务进度通知前会再次检查最终答复，减少任务已完成时仍发送“已投递”通知的情况。

新建和续接 Codex 聊天都使用 `--skip-git-repo-check`，工作目录可以是普通文件夹。每次 CLI 退出会记录 `cli_exited`，包含 `command`、`exitCode`、`signal`，以及可用的错误码和脱敏错误摘要。用 `requestId` 关联同一条消息的投递、CLI 和回发日志。

两个后端均记录实际进程耗时 `elapsedMs`；取消、超时或停止桥接时增加 `stopReason`。Claude 还会按 CLI 提供的数据记录 `model`、`durationMs`、`durationApiMs`、`numTurns`、`costUsd`、`usage` 和 `permissionDenials`（拒绝次数和工具名称）。正常退出不代表所有工具操作均获授权，可结合权限拒绝记录和最终答复判断。日志不保存工具参数或完整事件内容。

Claude 报告 `session_writes_lost` 时会记录 `cli_warning`，包含磁盘错误码、未保存的数据类别和受影响的聊天 ID。本轮已经生成的答复仍正常回发；请处理磁盘空间或配额问题，并检查会话历史，后续恢复可能缺少部分上下文。

投递失败或无法确认结果时，桥接会把通知及记录编号发回原企微会话。明确拒绝的任务可在修复后由本人发送 `/retry`；结果未知时先检查目标聊天，避免重复执行。暂时无法启动 CLI 时，会通知消息已保留并自动重试。失败通知沿用持久化回发队列，`/status` 会区分失败通知与任务答复。

桥接通过 WebSocket 接收在线推送，按企微消息 ID 去重。文本和语音转写随正文投递，图片、文件和视频保存到本机后将路径交给 Codex。引用和正文分别展示，附件下载失败会在消息中标出。默认回复简洁，正文要求的代码、命令、文案等内容完整返回，指定回复内容或格式时严格遵循。

| 现象 | 在哪里看、如何处理 |
| --- | --- |
| 消息去了意外的项目或聊天 | 在原会话发 `/status`，分别检查下一条消息的目标和上一条任务的实际目标。绑定目录被移动后可用 `/bind <新目录>` 或 `/bind off` 恢复。 |
| 长任务暂时没有最终答复 | 后端开始处理或确认入队后，超过 60 秒仍在等待时会发一次进度回执。若桌面正在占用目标聊天，桥接会把消息排入该聊天，按队列回执匹配最终答复。 |
| 最终答复回发失败 | `/status` 可查回发状态。长答复按 UTF-8 大小分段，`/retry` 可继续回发已保存的答复。发送结果未知时应先检查原会话，避免重复。 |
| 启动前发的消息没有出现 | 桥接接收在线推送。重启会恢复本机已入队的任务；离线期间的聊天历史不会补拉。同一机器人的另一个长连接客户端上线可能替换当前连接。 |

终端和 `.state/events.jsonl` 会记录 `workingDir`、`threadId` 和事件说明。按 `requestId`（本地请求）或 `wecomRequestId`（企微回调）可以追踪同一条消息，`senderId` 标识发送者。

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

## 开发与测试

```sh
npm test
```

[桥接入口](src/main.cjs) 管理单个企微连接和后端切换，[后端运行实例](src/backend-runtime.cjs) 管理各自的目标、绑定和指令，[目标配置](src/target-config.cjs) 处理启动默认值与状态文件。[消息路由记录](src/message-routing.cjs) 跨后端去重，避免切换后重复执行重送消息。[投递队列](src/delivery.cjs) 保存任务，[回发队列](src/replies.cjs) 负责分段、重试和回发。[Codex 适配器](src/backends/codex.cjs) 负责 CLI 调用和桌面聊天续接，[Claude 适配器](src/backends/claude.cjs) 负责非交互执行、会话续接和本地会话查询。

要接入其他 AI 后端，在 `src/backends/` 下实现适配器，再在 [启动入口](start.cjs) 中选择它。适配器提供 `id`、`name`、`parseThreadId`、`getWorkingDir`、`listThreads` 和 `submit`。创建聊天时调用 `onCreated(id)`，开始处理时调用 `onStarted()`。直接完成时返回 `{ state: 'completed', text }`；异步受理时返回 `{ state: 'accepted', queueId }`，并通过 `readReplies` 提供对应的最终答复。可选的 `getThreadTitle` 用于按 ID 查询标题。`/status` 会在 800 毫秒后回退到显示 ID。

支持取消的适配器声明 `supportsCancellation: true`，处理 `submit` 的 `signal` 和 `timeoutMs`；`submitExternal` 使用相同约定。进程生命周期由 [process-lifecycle.cjs](src/process-lifecycle.cjs) 管理。停止后返回 `uncertain` 和 `task_cancelled`、`task_timeout` 或 `bridge_stopped` 原因，避免自动重复执行。转交无法取消的远程队列前调用 `onDetached()`。执行统计通过 `onDiagnostic` 提交，会话保存警告通过 `onWarning` 提交。

只有确认尚未提交且可以重试时才返回 `queued`，明确拒绝返回 `rejected`，结果未知返回 `uncertain`。可参考[替代后端集成测试](test/backend-bridge.test.cjs)验证单聊、群聊、目标切换和重启续接。

## 测试

`npm test` 运行离线回归测试，覆盖协议解析、权限拒绝、超时取消、进程树清理、群聊指令、队列和重启恢复，不调用真实模型或发送企微消息。

已安装并登录 Claude 后，可选运行：

```sh
npm run test:claude:smoke
```

该测试使用临时项目和真实 Claude CLI，验证新建会话、重开队列后续接上下文、工具权限拒绝，以及答复进入原单聊和群聊的回发接口。企微发送端用本地接收器替代，不连接真实机器人。测试会调用模型并消耗额度，默认使用本机模型配置；可通过 `CLAUDE_SMOKE_MODEL` 指定模型。每轮上限 120 秒，测试设置禁用 Hook、MCP 和技能，只提供 Read 工具，并明确禁止读取测试文件。临时项目和桥接队列结束后清理，Claude 自身的测试会话记录仍可能保留。本测试不代替真实企微网络链路测试。
