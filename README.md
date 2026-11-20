# wecom-agent-bridge

把企业微信消息交给本机 Codex 或 Claude Code，处理结果由机器人回到原单聊或群聊。支持续接聊天、按会话绑定项目、保存记忆和运行中切换后端。

## 快速开始

需要：

- Windows、macOS 或 Linux，Node.js 24+。
- 已安装并登录的 Codex CLI **0.166.0+** 或 Claude Code **2.1.259+**。
- 已开启长连接的企业微信智能机器人及其 Secret。
- 已安装并授权的 [wecom-cli](https://github.com/WecomTeam/wecom-cli#快速开始)。用 `wecom-cli identity whoami` 核对身份。

基础版本依据：[Codex `queue --resume`](https://github.com/openai/codex/releases/tag/rust-v0.166.0)、[Claude `--permission-prompts none`](https://github.com/anthropics/claude-code/releases/tag/v2.1.259)。企微审批已在 Codex `0.169.0-alpha.11.1`、Claude `2.1.325` 验证；建议使用已验证或更新版本，旧版本未逐一联调。

在仓库目录运行：

```sh
npm ci
node start.cjs --check
node start.cjs
```

按提示输入 Secret。日志出现 `authenticated` 后，私聊机器人发送“请只回复连接成功”进行测试；群聊先 @ 机器人。终端实时显示日志，Ctrl+C 停止。

找不到 CLI 时，将 `CODEX_CLI_PATH` 或 `CLAUDE_CLI_PATH` 设为可执行文件的绝对路径。只需安装使用的后端。

## 配置

复制 [.config.sample.json](.config.sample.json) 为 `.config.local.json`：

```json
{
  "backend": "codex",
  "taskTimeoutMs": 1800000,
  "backends": {
    "codex": {
      "workingDir": "D:/projects/demo",
      "threadId": ""
    },
    "claude": {
      "workingDir": "",
      "threadId": ""
    }
  }
}
```

- `backend`：默认 `codex`，可设为 `claude`。运行中用 `/backend` 切换，重启后仍以配置为准。
- `workingDir`、`threadId`：均可省略。目录必须已存在；同时提供时使用指定目录，只有 ID 时从聊天记录获取目录。Codex 也接受 `codex://threads/<ID>` 或复制的 Markdown 深度链接。
- `taskTimeoutMs`：本地 CLI 单次执行时限，默认 30 分钟，`0` 关闭。不包含排队时间，也不限制已进入 Codex 桌面队列的任务。

配置只在启动时读取。未绑定的会话每次投递都重新读取 `last-target.json`，优先使用上次目标，缺少的字段从启动配置补充；删除记录也会立即生效。没有任何目标时，在启动目录新建聊天。

顶层 `workingDir`、`threadId` 仍可用于配置 Codex。两个后端分别保存目标、绑定、队列和记忆。

## 企微指令

私聊直接输入，群聊先 @ 机器人。`/help` 对所有人开放，其余管理指令仅限 `wecom-cli` 授权的本人账号。

| 指令 | 用途 |
| --- | --- |
| `/help` | 查看帮助 |
| `/backend [codex\|claude]` | 查看或切换整个机器人的后端 |
| `/status` | 查看聊天标题、ID 末段、工作目录和上一条任务的投递、回发状态 |
| `/bind [绝对目录\|off]` | 固定当前目标、绑定指定目录，或解除绑定 |
| `/threads` | 列出当前目录的未归档聊天 |
| `/thread <ID 或深度链接>` | 切换到已有聊天及其目录 |
| `/history` | 查看当前后端最近使用的聊天和目录，最多 20 条 |
| `/new` | 在当前目录开启新聊天 |
| `/cwd <绝对目录>` | 切换目录并开启新聊天 |
| `/tasks` | 查看当前后端在本企微会话的最近 10 条任务、编号、目标和状态 |
| `/retry [编号]` | 重试指定任务中确定失败的投递或回发，省略编号则操作上一条 |
| `/cancel [编号]` | 取消指定的本地排队或执行中的任务，省略编号则操作上一条 |
| `允许 [审批编号]` · `拒绝 [审批编号]` | 回应 Codex / Claude 的待审批操作，也支持 `/approve`、`/deny` |
| `/memory [内容]` · `/记忆 [内容]` | 有内容则保存，没有则查看；同名约定会更新 |
| `/forget #1` · `/忘记 #1` | 删除指定记忆，也可用名称或完整原文 |

新聊天在下一条普通消息到达时创建。切换目标或后端不改变已入队任务的目标；查询、重试旧后端的任务，需先切回该后端。

一个后端聊天可以处理多条企微任务。用 `/tasks` 查看编号，再发送 `/retry #12` 或 `/cancel #12`。编号在当前机器人和后端内持久保存，只能在任务原会话中操作。升级时会保留旧版为每个会话记录的上一条任务。

未绑定的会话共用默认目标。要让项目群独立，在群里发送：

```text
/bind D:/projects/demo
```

之后该群的 `/cwd`、`/thread`、`/new` 只改变本群目标，私聊切换项目也不会影响它。macOS、Linux 使用对应的本机绝对路径。私聊同样支持绑定。

记忆按后端、机器人、企微会话、本人账号和工作目录隔离，不绑定聊天 ID。同目录 `/new` 后仍保留，每份最多 20 条，每条最多 1000 字符。

## 执行权限

“本人”由企微回调的发送者 ID 与 `wecom-cli` 授权账号匹配确定。

| 来源 | Codex | Claude Code |
| --- | --- | --- |
| 本人 | 桥接直接执行时使用 `danger-full-access + never`。交给桌面端时沿用该聊天的权限 | `bypassPermissions` 跳过常规审批。显式禁止和组织策略仍有效 |
| 其他人 | 独立临时会话，使用 `workspace-write + on-request + auto_review`（替我审批）；允许联网，权限请求由 Codex 自动评估，不转发本人审批 | 独立临时会话，使用 `auto` 自动判断权限；仍需人工确认的操作直接拒绝，不转发本人审批 |

Windows 的非本人 Codex 任务使用 elevated 沙箱。私有 GitLab 等服务需在本机预先授权。

非本人 Codex 任务可读取当前账户可读的文件；超出沙箱的权限请求交给自动审批判断，可能被允许或拒绝。

非本人 Claude 任务使用 `--permission-mode auto --permission-prompts none --no-session-persistence`，不续接本人聊天、不保存该临时会话。`auto` 不提供操作系统级目录隔离，不能保证只访问工作目录。

桥接直接执行的任务需要审批时，机器人在原会话显示操作详情、目录和编号。本人在该会话回复“允许 编号”或“拒绝 编号”。仅有一条待审批时可省略编号，群里仍需 @ 机器人。5 分钟未回复、发送失败、任务取消或桥接停止时拒绝，旧编号不可复用。审批等待时间计入任务时限。

桥接直接执行本人任务时使用上表的权限，系统账户和组织策略仍然适用。企微审批只授予本次 Codex 命令或修改所需的权限，临时权限最多持续到本轮结束。

本人消息通常由桥接直接新建或续接 Codex 聊天，任务结束后释放写入锁。桌面端持有同一个聊天的写入锁时，桥接将消息排入该聊天并唤醒桌面端，再把对应答复发回原企微会话。桌面接手时需使用同一个工作目录，审批和取消在桌面聊天中处理。

Claude 通过临时 `PermissionRequest` Hook 接入，不修改全局配置；禁用 Hook 或被策略直接禁止的操作不会转入审批。两个后端均暂不支持问答表单。

Claude 建议使用独立聊天；续接已有聊天前，先停止其他运行实例。桥接不会向正在运行的 Claude 终端或桌面会话追加消息。

## Secret 与本地数据

Secret 读取顺序：`WECOM_BOT_SECRET` → 已保存的 Secret → 终端输入。**环境变量中的 Secret 不保存**；手动输入的 Secret 在认证成功后明文保存到 `.state/bot-<机器人 ID 的 SHA-256>.secret`，macOS、Linux 新建文件权限为 `0600`。

更换 Secret：停止桥接，在未设置该环境变量的终端运行 `node start.cjs --replace-secret`。

Codex 状态位于 `.state/`，Claude 位于 `.state/backends/claude/`，包含 `last-target.json`、队列、附件、记忆和日志。`.state/` 和 `.config.local.json` 均被 Git 忽略。

## 运行与排查

另一个终端可查看或停止服务：

```sh
node src/control.cjs status
node src/control.cjs stop
```

停止、取消或超时会终止本地任务及子进程，不撤销已有修改，也不会自动重跑。Codex 桌面队列中的任务需在目标聊天中停止。

| 现象 | 处理方式 |
| --- | --- |
| 消息进入了错误的项目或聊天 | 用 `/status` 检查目标及来源，再用 `/bind`、`/cwd` 或 `/thread` 调整 |
| 长时间没有答复 | 用 `/status` 查看进度；处理或入队后等待超过 60 秒会发一次进度回执 |
| 投递或回发失败 | 桥接会通知原会话；修复后用 `/retry`。结果未知时先检查聊天，避免重复执行 |
| 启动前的消息没有收到 | 只接收在线推送，不补拉离线历史；重启仅恢复本地已入队任务 |
| Claude 报 `cli_warning` | 检查磁盘空间和聊天记录；已生成的答复仍会回发 |

终端及状态目录的 `events.jsonl` 包含 `workingDir`、`threadId`、发送者和请求 ID。`cli_exited` 记录退出码、耗时和错误摘要；Claude 的 `permissionDenials` 表示有工具操作被拒绝。

桥接通过 WebSocket 收消息、`wecom-cli` 回发。附件先保存到本机，再将路径交给后端；回复默认简洁，正文明确要求的内容和格式完整保留。同一机器人应只运行一个长连接客户端。

## 测试

`npm test` 运行离线测试。`npm run test:codex:smoke`、`npm run test:claude:smoke` 调用已登录的本机 CLI 验证新建、续接和审批，会消耗模型额度，不发送企微消息。
