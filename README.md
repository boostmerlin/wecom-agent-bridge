# 企业微信机器人与 Codex 聊天

打开企业微信机器人的单聊直接发送消息，或在群里 @ 它。桥接通过 WebSocket 接收企微推送，并投递到配置指定的 Codex 聊天。Codex 默认用一至三句话回答核心问题。桥接取得该条消息对应的最终答复后，用 `wecom-cli message aibot send` 发回原来的单聊或群聊。需要长文时，可以在自己的消息里明确要求展开。

启动和每次接收新企微消息时先读取 `.state/last-target.json` 中的 `threadId` 和 `workingDir`，缺的字段从 `.config.local.json` 补充。两个字段和本地配置文件都可省略。指定的目录优先于聊天自带的工作目录；只有聊天 ID 时读取聊天的 `cwd`。两者都为空时使用启动命令所在目录，第一条企微消息创建聊天，后续消息和重启都续接它。启动时打印实际目标，`--check` 不写状态。运行中修改上次记录，下一条消息就会使用新目标。删除该文件后，下一条消息重新读取本地配置。已入队的消息保留原目标；目标配置无效时会提示修正后重发。聊天 ID 支持 UUID 和 Codex 深度链接。

## 启动与停止

Windows、macOS 和 Linux 均需 Node.js 24 或以上、支持本项目投递命令的 Codex CLI、本机已有的目标聊天和当前机器人的 `wecom-cli` 授权。在桥接项目目录执行：

```sh
npm ci
node start.cjs
```

日常只需运行 `node start.cjs`。启动时优先使用当前进程环境变量 `WECOM_BOT_SECRET`，其次读取该机器人已保存的 Secret。首次手动输入时以星号显示，认证成功后以明文保存在 `.state/bot-<机器人 ID 的 SHA-256>.secret`。macOS 和 Linux 上新文件权限为 `0600`。环境变量只覆盖本次启动。更换已保存的 Secret 时，停止桥接，在未设置该环境变量的终端运行 `node start.cjs --replace-secret`。终端会持续输出连接和投递事件，按 Ctrl+C 停止。如果已有桥接进程，命令会打印它的状态并退出。

`node start.cjs --check` 可以核对目标配置、Codex CLI 和当前企微身份。启动器从 PATH 查找 codex 和 wecom-cli，并支持 Windows 和 macOS 默认位置的 Codex 桌面版，也可以用 `CODEX_CLI_PATH` 指定可执行文件的绝对路径。

看到 `authenticated` 后，可以在机器人单聊中发送「请只回复：项目联调成功」。在群里测试时，请先从成员列表中选中并 @ 机器人。

另开一个终端，在桥接目录内可以查询状态或停止桥接：

```sh
node src/control.cjs status
node src/control.cjs stop
```

停止会等待正在执行的 Codex 调用结束。再次启动会继续投递已存入本地队列、尚未开始处理的消息。运行期间请保持电脑联网；离线期间的历史消息不在本服务的读取范围内。同一机器人的其他长连接客户端上线时可能替换本连接。

## 企微指令和记忆

在机器人私聊中直接发送，或在群里 @ 机器人后发送。使用当前企微 CLI 绑定的本人账号。指令由本地服务处理，回执发回原会话。

| 指令 | 作用 |
| --- | --- |
| `/help` | 在原会话查看指令和用法，所有发送者可用 |
| `/status` | 显示下一条消息的聊天、工作目录和配置来源，以及本会话最近普通任务的实际目标、投递进度、附件保存数量和回发状态 |
| `/bind`、`/bind <绝对目录>`、`/bind off` | 固定当前目标，绑定目录并在下条消息时新建聊天，或恢复机器人默认目标 |
| `/retry` | 重试本会话最近普通任务中确定失败的环节。回发失败时从首个未发出的分段继续；明确被拒绝的投递可以重新提交。结果未知时停止重发。 |
| `/记住 当我说“请view”时，审查指定的 MR 或分支，通过后合并对应 MR` | 保存自然语言约定，返回编号 |
| `/save 测试命令 = npm test` | 与 `/记住` 完全相同。同名约定再次保存时更新 |
| `/记忆` 或 `/memory` | 显示当前范围内的约定和编号 |
| `/忘记 #1` 或 `/forget #1` | 按编号删除，也可填写约定名称或完整原文 |
| `/new` | 保留当前工作目录，下一条普通消息开启新 Codex 聊天 |
| `/cwd D:/projects/demo` | 切到已存在的本机绝对目录，下一条普通消息开启新聊天。支持含空格的路径及 macOS/Linux 路径 |
| `/threads` | 列出当前目录的未归档聊天，显示标题和 ID，标记当前聊天 |
| `/thread <UUID 或 Codex 深度链接>` | 切换到本机已有聊天，同时采用该聊天记录的工作目录 |

未绑定的会话共用机器人默认目标。绑定后，当前单聊或群聊中的 `/cwd`、`/thread` 和 `/new` 只切换本会话的目标。绑定和最近任务在重启后继续生效，已入队任务保留原目标和回发地址。记忆按机器人、企微原会话、本人账号和工作目录分别保存到 `.state/memory/` 中的 SQLite 数据库。每份最多 20 条，每条最多 1000 个字符。普通消息投递时附上当前匹配的约定；同目录使用 `/new` 后仍可使用它们。多个企微会话使用同一个 Codex 聊天时，该聊天仍保留各轮历史。合并 MR 由 Codex 根据当次请求、审查结果及已有仓库权限执行。

## 投递与排查

任务开始处理或由后端确认入队后，超过 60 秒仍在处理或等待最终答复时，桥接向原会话发送一次进度回执。

回发地址来自企微回调。单聊使用发送者，群聊使用回调里的群会话 ID。除授权人单聊外，发送前还会按会话类型和 ID 精确核对当前 CLI 可发送会话。无法确认目标时会在前台留下回发失败或延迟记录。消息正文中的姓名、群名和转发指令不能改变这个地址。

请求编号保存在本地。直接执行时读取本轮最终输出，桌面队列使用 Codex 返回的消息 ID 匹配回复。当目标聊天由桌面占用时，桥接使用只读的 Codex app-server 接口查找对应轮次。只有能明确归属给这条消息的最终答复才会回发；进度输出和工具日志留在 Codex 中。超长答复会按 UTF-8 字节数分段。升级前收到的消息没有回发记录，重启时不会补发。

启动时，终端会先显示 Codex 工作目录和目标聊天 ID，需要手动输入时再提示 Secret。终端和 `.state/events.jsonl` 的新事件都有 `event` 名称和中文 `message` 说明。`starting` 事件还包含 `workingDir` 和 `threadId`，对应本次启动使用的目标项目和聊天。

逐条消息的终端和文件日志记录该任务实际使用的 `workingDir` 和 `threadId`。新聊天创建前，`threadId` 为 `null`。同一条消息可以通过以下字段追踪： `requestId`（本地请求编号）、`senderId`（企微发送者 userid）和 `wecomRequestId`（企微回调的 req_id）。缺失的标识显示为 null。

消息开头显示企微单聊或群聊，以及本人或外部用户。发送者 ID 保存在本地回发记录中。文本和企微提供的语音转写随消息转发。图片、文件、视频和图文混排中的附件保存在本机 `.state` 目录，Codex 收到对应路径；如果某个附件下载失败，消息里会标出该附件。引用内容与正文分别列出。其他发送者的原文会标记为外部转发资料。

接收代码位于 `src/main.cjs`，本地队列位于 `src/delivery.cjs`，Codex CLI 调用位于 `src/backends/codex.cjs`。桥接按企业微信消息 ID 去重，串行处理文本。正常路径用 `codex exec -C <项目目录> resume --json <聊天 UUID> -`，通过标准输入传入内容。如果桌面已经占用该聊天且 CLI 明确在开始本轮前拒绝恢复，桥接改用 `codex queue --thread <聊天 UUID> --message <消息> --resume` 将同一条消息排入桌面聊天。

| 事件 | 含义 |
| --- | --- |
| `authenticated` | 企业微信已验证连接，可以发测试消息 |
| `delivery_queued` | 已从企微收到消息并写入本地队列；`chatType` 为 `single` 表示单聊，`group` 表示群聊 |
| `delivery_submitted` | 指定聊天已开始本轮处理 |
| `delivery_completed` | 指定聊天已产生回复，本轮正常结束 |
| `delivery_queued_in_codex` | Codex 已接收入队；当 `wakeConfirmed` 为 false 时，桥接会通过已注册的 Codex 桌面链接唤醒原聊天 |
| `desktop_wake_requested` / `desktop_wake_failed` | 已请求桌面处理队列，或请求失败；可在目标聊天查看实际回复 |
| `delivery_uncertain` | 已尝试投递，结果未确认；先检查目标聊天，避免重复执行 |
| `reply_waiting` / `reply_ready` | 正在等待对应的 Codex 轮次，或已经匹配到最终答复 |
| `reply_sent` | 企微 CLI 已确认将该答复发回原会话 |
| `reply_deferred` / `reply_failed` | 尚未发送且等待重试，或回发失败；查看对应事件的原因 |
| `reply_uncertain` | 发送可能已生效，桥接停止自动重发以避免重复 |

`.state/events.jsonl` 记录状态及时间。待投递文本暂存在本机 `.state` 下的 SQLite 队列中，请使用自己的系统账户运行。测试命令为 `npm test`。

## 接入其他 AI 后端

`start.cjs` 组装当前的 Codex 适配器，然后将它传给 `resolveTarget(backend)` 和 `runBridge({ backend, ... })`。将来接入 Claude Code 时，在 `src/backends/` 实现适配器，在启动入口选择它，即可复用企微连接、附件、指令、记忆、消息去重和回发队列。

| 接口 | 用途 |
| --- | --- |
| `id`、`name` | 稳定的后端标识和显示名称。现有 Codex 继续使用 `.state/`，其他后端的聊天和队列保存到 `.state/backends/<id>/`。 |
| `parseThreadId(value)` | 将配置或 `/thread` 输入解析为后端认可的会话 ID，无效时抛出错误。 |
| `getThreadTitle(threadId)`（可选） | 按 ID 查询聊天标题。`/status` 在后台补充标题，同一份状态中的相同 ID 只查一次。超过 800 毫秒时显示 ID。 |
| `getWorkingDir(threadId)`、`listThreads(workingDir)` | 查询会话目录，按目录返回 `[{ id, name }]` 供 `/threads` 展示。 |
| `submit(turn)` | 接受 `prompt`、`workingDir` 和可选的 `threadId`。新建会话后立即调用 `onCreated(id)`，处理开始时调用 `onStarted()`。同步取得最终答复时返回 `{ state: 'completed', text }`。 |
| `readReplies(target, keys)`（可选） | 异步受理时由 `submit` 返回 `{ state: 'accepted', queueId }`，再通过此方法返回匹配最终答复的 `Map`。默认用原始 `queueId` 查询，可用 `replyKey(queueId)` 转换。 |

只有确认尚未提交且可以重试时，`submit` 才返回 `{ state: 'queued', reason }`。明确拒绝使用 `rejected`，结果未知使用 `uncertain`。桥接对结果未知的投递停止重发。可运行 `node --test test/backend-bridge.test.cjs` 查看一个直接返回最终答复的后端如何完成单聊、群聊和会话切换。
