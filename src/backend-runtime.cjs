'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { chatTitle, describeStatus, describeTasks } = require('./task-status.cjs');
const { createDelivery } = require('./delivery.cjs');
const { formatIncoming } = require('./incoming.cjs');
const { createMediaStore } = require('./media.cjs');
const { helpText, parseCommand, createCommandStore } = require('./commands.cjs');
const { root, stateDirectory, storageKey, parseQueueKey, readSettings, resolveTarget, checkWorkingDir, writeState, rememberTarget, targetRecord } = require('./target-config.cjs');

const eventMessages = {
  backend_switched: '后续消息将使用切换后的后端，原任务继续处理。',
  backend_switch_failed: '后端切换失败，继续使用原后端。',
  target_reload_error: '目标配置无法读取或无效，本条消息未投递。',
  target_created: '已创建并记住目标聊天。',
  starting: '正在连接企业微信机器人。',
  authenticated: '企业微信连接已认证，可以接收消息。',
  disconnected: '企业微信连接已断开。',
  reconnecting: '正在重新连接企业微信。',
  connection_error: '企业微信连接出错。',
  media_save_failed: '保存企微附件失败。',
  receive_error: '接收或保存企微消息时出错。',
  progress_sent: '任务回执已发回原会话。',
  progress_failed: '任务回执发送失败。',
  stopped: '桥接已停止。',
  delivery_queued: '已收到企微消息，并写入本地队列。',
  delivery_submitted: '目标聊天已开始处理消息。',
  delivery_completed: '目标聊天已完成本轮并生成回复。',
  delivery_accepted: '目标聊天已接受消息，等待最终答复。',
  delivery_deferred: '暂时无法启动处理程序，消息保留在本地等待重试。',
  delivery_rejected: '处理程序启动参数无效，消息投递失败。',
  delivery_uncertain: '无法确认投递结果，请查看目标聊天。',
  delivery_storage_error: '读写本地投递队列时出错。',
  cli_exited: 'CLI 进程已退出。',
  approval_requested: '操作正在等待本人审批。',
  approval_resolved: '本次操作的审批已结束。',
  cli_warning: 'CLI 报告会话保存异常；已生成的答复仍会回发，请检查磁盘空间和会话记录。',
  reply_no_route: '企微回调未提供原会话 ID，无法回发。',
  reply_waiting: '正在等待这条企微消息对应的最终答复。',
  reply_ready: '回发内容已准备好，等待发回原企微会话。',
  reply_sent: '消息已发回原企微会话。',
  reply_deferred: '本次未发出回复，稍后重试。',
  reply_failed: '未能将这条消息的答复发回原会话。',
  reply_uncertain: '无法确认企微是否收到回复，已停止重发以避免重复。',
  reply_read_error: '暂时无法读取最终答复，稍后重试。',
  reply_storage_error: '读写本地回发记录时出错。',
};

async function createBackendRuntime({ config, backend, initialTarget, defaults, client, sendReply, onError, requestApproval }) {
  const { taskTimeoutMs } = config;
  let active, commands;
  const workers = new Map();
  const taskReplies = new Map();
  const stateDir = stateDirectory(root, backend);
  fs.mkdirSync(stateDir, { recursive: true });
  const messages = { ...eventMessages, ...backend.eventMessages };
  let lastDelivery = null, lastReply = null;
  function log(event, details = {}, target = active ?? initialTarget) {
    const time = new Date().toISOString();
    if (event.startsWith('delivery_')) lastDelivery = { event, time };
    if (event.startsWith('reply_')) lastReply = { event, time };
    const line = JSON.stringify({ time, event, backend: backend.id, message: messages[event], ...details, workingDir: target.workingDir, threadId: target.threadId ?? null }) + '\n';
    fs.appendFileSync(path.join(stateDir, 'events.jsonl'), line);
    process.stdout.write(line);
  }
  async function close() {
    await Promise.all([...taskReplies.values()].map(item => item.done));
    await Promise.all([...workers.values()].map(w => w.delivery.close()));
    commands?.close();
  }
  try {
    const botKey = createHash('sha256').update(config.botId).digest('hex').slice(0, 16);
    const queueMapping = id => path.join(stateDir, botKey, storageKey(id), 'queue.json');
    commands = createCommandStore(path.join(stateDir, 'memory', botKey));
    function openTarget(target) {
      if (target.queueKey) return openQueue(target);
      const known = target.threadId && commands.queueFor(target.threadId, target.workingDir);
      const linked = !known && target.threadId && readSettings(queueMapping(target.threadId)).queueKey;
      let queueKey = known || (linked && parseQueueKey(linked)) || target.threadId || randomUUID();
      const dir = commands.queueDirectory(queueKey);
      if (dir && dir !== target.workingDir) queueKey = randomUUID();
      return openQueue({ ...target, queueKey });
    }

    function openQueue(target) {
      const { queueKey } = target;
      const existing = workers.get(queueKey);
      if (existing) return existing;
      const current = { threadId: target.threadId, workingDir: target.workingDir, queueKey };
      const inbox = path.join(stateDir, botKey, storageKey(queueKey));
      const snapshot = () => ({ threadId: current.threadId, workingDir: current.workingDir, queueKey });
      current.delivery = createDelivery({
        ...snapshot(), backend, ownerId: config.ownerId, stateDir: inbox, sendReply,
        progressAfterMs: config.progressAfterMs,
        taskTimeoutMs, requestApproval,
        progressText: async route => {
          const title = route.senderId === config.ownerId
            ? await chatTitle(backend, current.threadId, { allowPreview: route.chatType === 'single' }) : backend.name;
          return '已投递到 ' + title + '，完成后会在这里回复。';
        },
        log: (event, details) => log(event, details, current),
        onCreated(id) {
          writeState(queueMapping(id), { queueKey });
          current.threadId = id;
          commands.track(snapshot());
          if (current === active) {
            // A user may have changed or deleted the file while the backend was starting.
            let saved;
            try { saved = readSettings(path.join(stateDir, 'last-target.json')); }
            catch { log('target_reload_error'); }
            if (saved?.queueKey === queueKey && !saved.threadId && saved.workingDir === current.workingDir) {
              rememberTarget(backend, current);
            }
          }
          log('target_created', {}, current);
        },
      });
      workers.set(queueKey, current);
      commands.track(snapshot());
      return current;
    }
    function activate(target) {
      const next = openTarget(target);
      rememberTarget(backend, next);
      active = next;
    }
    function applyPlan(plan) {
      const origin = workers.get(plan.origin);
      if (!origin) throw new Error('Missing command origin queue');
      if (plan.unbind) commands.bind(plan.route, null);
      else if (plan.target && plan.bound) commands.bind(plan.route, targetRecord(openTarget(plan.target)));
      else if (plan.target) activate(plan.target);
      origin.delivery.enqueue(plan.id, plan.reply, plan.route.chatType, plan.route, plan.requestId, plan.route.senderId, true);
      commands.finish(plan.id);
    }
    // Snapshot task states in receive order. Only title enrichment and its reply run
    // outside that sequence, so a slow backend cannot stall other conversations.
    function sendTaskReply(id, origin, route, requestId, describe) {
      if (taskReplies.has(id)) return taskReplies.get(id).done;
      const done = describe().then(reply => {
        applyPlan(commands.plan(id, () => ({ id, origin: origin.queueKey, route, requestId, reply })));
      }).catch(() => {
        log('receive_error', { wecomRequestId: requestId }, origin);
        onError();
      }).finally(() => taskReplies.delete(id));
      taskReplies.set(id, { origin, done });
      return done;
    }

    function taskSnapshot(task, route) {
      const queue = openQueue(task.target);
      return { ...task.target, number: task.number, threadId: task.target.threadId ?? queue.threadId, media: task.media,
        state: queue.delivery.taskState(task.id, route) };
    }

    async function retireIdle() {
      for (const [key, w] of workers) {
        if (w !== active && ![...taskReplies.values()].some(item => item.origin === w) && w.delivery.idle()) {
          await w.delivery.close();
          workers.delete(key);
          commands.untrack(key);
        }
      }
    }
    for (const target of commands.targets()) openTarget(target);
    activate(initialTarget);
    for (const plan of commands.pending()) applyPlan(plan);
    await retireIdle();
    const context = {
      botId: config.botId, ownerId: config.ownerId,
      saveMedia: createMediaStore(client, path.join(stateDir, botKey, 'media'), details => log('media_save_failed', details))
    };
    async function handle(frame, localReply) {
      const message = await formatIncoming(frame.body, context);
      if (!message) return;
      const route = message.route;
      const binding = route && commands.binding(route);
      let targetError, next = active, sources;
      try {
        if (binding) checkWorkingDir(binding.workingDir);
        const target = binding || await resolveTarget(backend, defaults);
        sources = binding ? { thread: '会话绑定', directory: '会话绑定' } : target.sources;
        next = openTarget(target);
        // A new chat needs a persistent queue identity before its first turn.
        if (!binding) {
          if (!target.threadId && !target.queueKey) rememberTarget(backend, next);
          active = next;
        }
      } catch {
        targetError = binding ? '本会话绑定目录不可用。请用 /bind <绝对目录> 重新绑定，或用 /bind off 恢复默认目标。' :
          '目标配置无效，请检查 last-target.json 和 .config.local.json 后重发。';
        log('target_reload_error', { wecomRequestId: frame.headers?.req_id });
      }
      const receipt = commands.claim(message.id, next.queueKey);
      if (receipt.done) return;
      const origin = workers.get(receipt.queue_key);
      if (!origin) throw new Error('Missing message origin queue');
      const owner = frame.body.from.userid === config.ownerId;
      const cmd = parseCommand(frame.body);
      const requestId = frame.headers?.req_id;
      const repairingBinding = cmd?.name === 'bind' && !!cmd.arg;
      if (targetError && !repairingBinding && !['help', 'history', 'status', 'tasks', 'retry', 'cancel', 'backend', 'approve', 'deny'].includes(cmd?.name)) {
        if (route) origin.delivery.enqueue(message.id, targetError,
          message.chatType, route, requestId, frame.body.from.userid, true);
        commands.finish(message.id);
        return;
      }
      if (cmd && route) {
        let target, reply, unbind = false;
        const titleOptions = { allowPreview: route.chatType === 'single' };
        if (localReply !== undefined) reply = localReply;
        else if (cmd.name === 'help') reply = cmd.arg ? '用法：/help' : helpText;
        else if (!owner) reply = '此指令仅限机器人绑定的本人使用。';
        else if (cmd.name === 'retry' || cmd.name === 'cancel') {
          const number = cmd.arg ? Number(cmd.arg.replace(/^#/, '')) : undefined;
          if (cmd.arg && (!/^#?[1-9]\d*$/.test(cmd.arg) || !Number.isSafeInteger(number))) {
            reply = '用法：/' + cmd.name + ' [任务编号]。发送 /tasks 查看编号。';
          } else {
            const task = commands.task(route, number);
            if (!task) reply = number ? '当前后端在本会话未找到任务 #' + number + '。' : '本会话尚无任务。';
            else {
              const { delivery } = openQueue(task.target);
              reply = cmd.name === 'retry' ? delivery.retryTask(message.id, task.id, route, task.target.workingDir)
                : delivery.cancelTask(message.id, task.id, route);
            }
          }
        }
        else if (cmd.name === 'status' || cmd.name === 'tasks') {
          if (cmd.arg) reply = '用法：/' + cmd.name;
          else {
            let describe;
            if (cmd.name === 'tasks') {
              const tasks = commands.recentTasks(route).map(task => taskSnapshot(task, route));
              describe = () => describeTasks(backend, tasks, titleOptions);
            } else {
              const last = commands.task(route);
              const snapshot = { target: targetRecord(next), sources, error: targetError, last: last && taskSnapshot(last, route) };
              describe = () => describeStatus(backend, snapshot, titleOptions);
            }
            const done = sendTaskReply(message.id, origin, route, requestId, describe);
            await retireIdle();
            return { done };
          }
        }
        else if (cmd.name === 'bind') {
          if (cmd.arg === 'off') {
            unbind = true;
            reply = '本会话将使用机器人默认目标。';
          } else {
            try {
              target = cmd.arg ? { workingDir: path.resolve(checkWorkingDir(cmd.arg)), queueKey: randomUUID() } : targetRecord(origin);
              reply = '本会话已绑定到 ' + target.workingDir + '。';
            } catch { reply = '用法：/bind、/bind <本机绝对目录> 或 /bind off'; }
          }
        }
        else if (cmd.name === 'history') {
          if (cmd.arg) reply = '用法：/history';
          else {
            const rows = commands.history().map(item => {
              const current = !targetError && item.workingDir === next.workingDir &&
                (item.threadId ? item.threadId === next.threadId : item.queueKey === next.queueKey);
              return (current ? '【当前】' : '') + (item.threadId || '尚未创建聊天') + '\n' + item.workingDir;
            });
            reply = rows.length ? backend.name + ' · 最近使用的目标（最多 20 条，最近使用在前）\n\n' +
              rows.join('\n\n') + '\n\n切换：/thread <ID> 或 /cwd <目录>' : '当前后端尚无使用记录。';
          }
        }
        else if (cmd.name === 'threads') {
          if (cmd.arg) reply = '用法：/threads';
          else {
            try {
              const threads = await backend.listThreads(origin.workingDir, titleOptions);
              const rows = threads.map(({ id, name }) => {
                const title = name?.trim().replace(/\s+/g, ' ') || '未命名聊天';
                return (id === origin.threadId ? '【当前】' : '') + title + '\n' + id;
              });
              reply = rows.length ? origin.workingDir + ' · ' + rows.length + ' 个聊天\n\n' + rows.join('\n\n') :
                '当前工作目录没有未归档聊天。';
            } catch { reply = '读取聊天列表失败，请稍后重试 /threads。'; }
          }
        }
        else if (cmd.name === 'new' || cmd.name === 'cwd' || cmd.name === 'thread') {
          try {
            if (cmd.name === 'thread') {
              const threadId = backend.parseThreadId(cmd.arg);
              const [directory, title] = await Promise.all([
                backend.getWorkingDir(threadId), chatTitle(backend, threadId, { ...titleOptions, compact: true }),
              ]);
              const workingDir = checkWorkingDir(directory);
              target = { threadId, workingDir };
              reply = '已切换聊天 ' + title + '\n工作目录：' + workingDir;
            } else {
              if (cmd.name === 'new' && cmd.arg) throw new Error('用法：/new');
              const workingDir = cmd.name === 'cwd' ? path.resolve(checkWorkingDir(cmd.arg)) : origin.workingDir;
              target = { workingDir, queueKey: randomUUID() };
              reply = '下一条普通消息将开启新聊天。工作目录：' + workingDir;
            }
          } catch { reply = cmd.name === 'thread' ? '切换失败，请提供本机已有聊天的 ID 或受支持的聊天链接。' :
              cmd.name === 'cwd' ? '用法：/cwd 本机已存在的绝对目录' : '用法：/new'; }
        }
        const plan = commands.plan(message.id, () => ({
          id: message.id, origin: origin.queueKey, route, requestId, target, unbind, bound: !!binding || cmd.name === 'bind',
          reply: reply ?? commands.memory(cmd, commands.scope(origin.workingDir, route)),
        }));
        applyPlan(plan);
      } else if (!cmd) {
        const text = owner && route ? commands.append(message.text, origin.workingDir, route) : message.text;
        if (route) commands.recordTask(route, message.id, targetRecord(origin), message.media);
        origin.delivery.enqueue(message.id, text, message.chatType, route, requestId, frame.body.from.userid);
        commands.finish(message.id);
      } else {
        log('reply_no_route', { senderId: frame.body.from.userid }, origin);
        commands.finish(message.id);
      }
      await retireIdle();
    }
    return { backend, handle, close, log, handled: id => commands.handled(id),
      status: () => ({ backend: backend.id, backendName: backend.name,
        senderScope: typeof backend.submitExternal === 'function' ? 'all' : 'owner',
        threadId: active?.threadId ?? null, workingDir: active?.workingDir ?? initialTarget.workingDir, lastDelivery, lastReply }),
    };
  } catch (error) { await close(); throw error; }
}

module.exports = { createBackendRuntime };
