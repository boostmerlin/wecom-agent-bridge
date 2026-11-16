# WeCom Codex Bridge

在企业微信里给机器人发消息，让本机的 Codex 在指定项目中处理任务，再把最终答复发回原来的单聊或群聊。可以从手机续接桌面上的聊天，也可以为每个项目群固定工作目录和聊天。

## 快速开始

准备好以下环境：

- Windows、macOS 或 Linux，Node.js 24 或以上。
- 本机可用的 Codex CLI，支持 `exec resume --json` 和 app-server 的 `thread/queue/add`。如果启动器找不到可执行文件，将 `CODEX_CLI_PATH` 设为它的绝对路径。
- 已开启长连接的企业微信智能机器人、该机器人的长连接 Secret，以及已授权的 `wecom-cli`。用 `wecom-cli identity whoami` 核对身份。

在仓库目录运行：

```sh
npm ci
node start.cjs --check
node start.cjs
```

`--check` 核对 CLI、企微身份和目标目录。正式启动后，按提示输入 Secret。看到 `authenticated`，在机器人私聊里发送 **请只回复「连接成功」**。收到「连接成功」即验证了从企微到 Codex 再回到企微的完整链路。群里测试时，先从成员列表选中并 @ 机器人。

首次使用可以跳过配置，第一条普通消息会在启动命令所在目录创建聊天。终端实时显示日志，按 Ctrl+C 停止。也可以在另一个终端运行 `node src/control.cjs status` 查询进程，或运行 `node src/control.cjs stop` 等待当前调用结束后停止服务。

## 给项目群绑定工作目录

例如，要让一个群里的任务都在 `D:/projects/demo` 中执行，在群里 @ 机器人，依次发送以下三条消息：

```text
/bind D:/projects/demo
请概括这个项目的用途，用两句话回复。
/status
```

目录须已存在。第一条指令绑定当前群，第二条消息在该目录新建聊天，第三条显示刚才的实际投递和回发情况。之后你在私聊里使用 `/new`，这个群仍会续接自己的聊天。macOS 和 Linux 使用本机绝对路径，例如 `/home/me/projects/demo`。

## 企微指令

桥接按企微回调中的发送者 ID 区分本人和其他人。本人继续使用选定的 Codex 聊天和原有审批策略。桥接启动的 Codex 回合允许联网，排入已打开的桌面聊天时沿用该聊天的权限。其他人的每条消息都在当前工作目录新建临时会话，使用 `workspace-write`，允许联网和目录内写入，允许读取目录外当前账户可读的文件。Windows 使用 elevated 沙箱。需要突破沙箱的操作会被拒绝，不会自动批准，也不会转入本人的桌面聊天。GitLab 私有项目的访问取决于运行环境已有的授权。

私聊直接输入指令，群聊先 @ 机器人，再输入指令。`/help` 对所有发送者开放，其余管理指令由 `wecom-cli` 绑定的本人账号使用。

| 指令 | 用途 |
| --- | --- |
| `/help` | 查看全部指令和用法。 |
| `/status` | 查看下一条消息的目标、目录和配置来源，以及本会话上一条普通任务的实际目标、附件保存数量和回发进度。 |
| `/bind` · `/bind <绝对目录>` · `/bind off` | 固定当前目标、绑定一个目录并在下条普通消息时新建聊天，或恢复机器人默认目标。 |
| `/threads` · `/thread <ID 或深度链接>` | 列出当前目录的未归档聊天，或切换到已有聊天及其工作目录。 |
| `/new` · `/cwd <绝对目录>` | 在当前目录或指定目录开启新聊天。聊天在下一条普通消息到达时创建。 |
| `/retry` | 重试本会话上一条普通任务中确定失败的环节。回发失败时，从首个未发出的分段继续。只有此前投递明确被拒绝，才会重新提交任务。 |
| `/记住 <内容>` · `/save <内容>` | 保存一条约定。例如 `/save 测试命令 = npm test`，再次保存同名约定会更新内容。 |
| `/记忆` · `/memory` | 查看当前范围内的约定及编号。 |
| `/忘记 #1` · `/forget #1` | 删除指定约定，也可填写名称或完整原文。 |

未绑定的会话共用机器人默认目标。绑定后，`/cwd`、`/thread` 和 `/new` 只作用于当前企微会话。已入队的任务保留原目标和回发地址。

记忆按机器人、企微会话、本人账号和工作目录保存。每份最多 20 条，每条最多 1000 个字符。同目录使用 `/new` 后仍可沿用这些约定。

## 默认项目和聊天

将 [.config.sample.json](.config.sample.json) 复制为 `.config.local.json`，按需设置字段。例如，只指定工作目录：

```json
{
  "workingDir": "D:/projects/demo"
}
```

- `workingDir` 是本机已存在的绝对目录。`threadId` 接受聊天 UUID、`codex://threads/<UUID>` 或 Codex 复制的 Markdown 深度链接。
- 未绑定的会话每次收消息时重新读取 `.state/last-target.json`，缺少的字段从 `.config.local.json` 补充。删除上次记录后，下一条消息重新使用本地配置。
- 同时指定两个字段时，使用显式目录。只有聊天 ID 时，使用聊天记录中的目录。只有目录时，首条普通消息会新建聊天，以后可在重启后续接。
- 多个企微会话指向同一个 Codex 聊天时，共享该聊天的历史。需要独立上下文的群可以使用 `/bind <目录>`。

## Secret 和本地数据

启动时依次使用当前进程的 `WECOM_BOT_SECRET`、本机已保存的 Secret、终端手动输入。**环境变量提供的 Secret 只在本次启动使用。** 手动输入以星号显示，认证成功后以明文保存到 `.state/bot-<机器人 ID 的 SHA-256>.secret`，macOS 和 Linux 上新建凭据文件的权限为 `0600`。

要替换已保存的 Secret，先停止桥接，然后在未设置该环境变量的终端运行 `node start.cjs --replace-secret`。队列、附件、记忆和事件日志都在本机 `.state/` 下。`.state/` 和 `.config.local.json` 已加入 Git 忽略规则。

## 消息投递与排查

目标聊天被桌面版占用时，桥接通过 app-server 排队，并用显式的 `clientUserMessageId` 匹配最终答复。队列项 ID 和用户消息 ID 分别处理。发送长任务进度通知前会再次检查最终答复，减少任务已完成时仍发送“已投递”通知的情况。

新建和续接 Codex 聊天都使用 `--skip-git-repo-check`，工作目录可以是普通文件夹。每次 CLI 退出会记录 `cli_exited`，包含 `command`、`exitCode`、`signal`，以及可用的错误码和脱敏错误摘要。用 `requestId` 关联同一条消息的投递、CLI 和回发日志。

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
| `delivery_queued` / `delivery_submitted` | 消息已写入本地队列 / 目标聊天已开始处理。 |
| `delivery_queued_in_codex` / `desktop_wake_requested` | 消息已进入 Codex 桌面队列 / 桥接已请求桌面唤醒聊天。 |
| `cli_exited` | CLI 已退出，记录退出码、终止信号和脱敏错误摘要。 |
| `delivery_completed` / `reply_ready` / `reply_sent` | 本轮直接执行已完成 / 回发内容已就绪 / 企微已确认回发。带 `failureReason` 时为失败通知。 |
| `delivery_uncertain` / `reply_uncertain` | 投递或回发结果未知，桥接停止自动重发。 |

## 开发与测试

```sh
npm test
```

[桥接入口](src/main.cjs) 负责企微连接和路由，[投递队列](src/delivery.cjs) 保存任务，[回发队列](src/replies.cjs) 负责分段、重试和回发。[Codex 适配器](src/backends/codex.cjs) 负责 CLI 调用和桌面聊天续接。

要接入其他 AI 后端，在 `src/backends/` 下实现适配器，再在 [启动入口](start.cjs) 中选择它。适配器提供 `id`、`name`、`parseThreadId`、`getWorkingDir`、`listThreads` 和 `submit`。创建聊天时调用 `onCreated(id)`，开始处理时调用 `onStarted()`。直接完成时返回 `{ state: 'completed', text }`；异步受理时返回 `{ state: 'accepted', queueId }`，并通过 `readReplies` 提供对应的最终答复。可选的 `getThreadTitle` 用于按 ID 查询标题。`/status` 会在 800 毫秒后回退到显示 ID。

只有确认尚未提交且可以重试时才返回 `queued`，明确拒绝返回 `rejected`，结果未知返回 `uncertain`。可参考[替代后端集成测试](test/backend-bridge.test.cjs)验证单聊、群聊、目标切换和重启续接。
