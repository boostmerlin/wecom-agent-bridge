const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { WSClient } = require('@wecom/aibot-node-sdk');
const { chatTitle, describeStatus } = require('./task-status.cjs');
const { listenControl } = require('./control.cjs');
const { createDelivery } = require('./delivery.cjs');
const { formatIncoming } = require('./incoming.cjs');
const { createMediaStore } = require('./media.cjs');
const { helpText, parseCommand, createCommandStore } = require('./commands.cjs');
const { createWecomSender } = require('./wecom-reply.cjs');

const root = path.join(__dirname, '..');

const eventMessages = {
  target_reload_error: '目标配置无法读取或无效，本条消息未投递。',
  target_created: '已创建并记住目标聊天。',
  starting: '正在连接企业微信机器人。',
  authenticated: '企业微信连接已认证，可以接收消息。',
  disconnected: '企业微信连接已断开。',
  reconnecting: '正在重新连接企业微信。',
  connection_error: '企业微信连接出错。',
  media_save_failed: '保存企微附件失败。',
  receive_error: '接收或保存企微消息时出错。',
  progress_sent: '长任务回执已发回原会话。',
  progress_failed: '长任务回执发送失败。',
  stopped: '桥接已停止。',
  delivery_queued: '已收到企微消息，并写入本地队列。',
  delivery_submitted: '目标聊天已开始处理消息。',
  delivery_completed: '目标聊天已完成本轮并生成回复。',
  delivery_accepted: '目标聊天已接受消息，等待最终答复。',
  delivery_deferred: '暂时无法启动处理程序，消息保留在本地等待重试。',
  delivery_rejected: '处理程序启动参数无效，消息投递失败。',
  delivery_uncertain: '无法确认投递结果，请查看目标聊天。',
  delivery_storage_error: '读写本地投递队列时出错。',
  reply_no_route: '企微回调未提供原会话 ID，无法回发。',
  reply_waiting: '正在等待这条企微消息对应的最终答复。',
  reply_ready: '已匹配到本轮最终答复，准备回发原会话。',
  reply_sent: '最终答复已发回原企微会话。',
  reply_deferred: '本次未发出回复，稍后重试。',
  reply_failed: '未能将这条消息的答复发回原会话。',
  reply_uncertain: '无法确认企微是否收到回复，已停止重发以避免重复。',
  reply_read_error: '暂时无法读取最终答复，稍后重试。',
  reply_storage_error: '读写本地回发记录时出错。',
};

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function stateDirectory(directory, backend) {
  if (typeof backend.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(backend.id)) throw new Error('Invalid backend ID');
  // Codex already has active queues at the original location.
  const base = path.join(directory, '.state');
  return backend.id === 'codex' ? base : path.join(base, 'backends', backend.id);
}

function storageKey(id) {
  return uuid.test(id) ? id : 's-' + createHash('sha256').update(id).digest('hex').slice(0, 32);
}

function parseQueueKey(key) {
  if (typeof key !== 'string' || !uuid.test(key)) throw new Error('Invalid local queue ID');
  return key.toLowerCase();
}

function checkWorkingDir(workingDir) {
  if (typeof workingDir !== 'string' || !path.isAbsolute(workingDir) || !fs.statSync(workingDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('工作目录必须是本机存在的绝对目录。请检查 .config.local.json 或目标聊天的工作目录。');
  }
  return workingDir;
}

function readSettings(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('需要 JSON 对象');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(file + '：' + error.message);
  }
}

function loadTarget(backend, directory = root) {
  const last = readSettings(path.join(stateDirectory(directory, backend), 'last-target.json'));
  const present = value => value != null && (typeof value !== 'string' || value.trim() !== '');
  const lastDir = last.workingDir;
  const local = present(last.threadId) && present(lastDir) ? {} :
    readSettings(path.join(directory, '.config.local.json'));
  const id = last.queueKey && !present(last.threadId) ? undefined : (present(last.threadId) ? last.threadId : local.threadId);
  const dir = present(lastDir) ? lastDir : local.workingDir;
  return {
    sources: {
      thread: last.queueKey || present(last.threadId) ? '.state' : present(id) ? '.config.local.json' : '自动新建',
      directory: present(lastDir) ? '.state' : present(dir) ? '.config.local.json' : present(id) ? '聊天记录' : '启动目录',
    },
    threadId: present(id) ? backend.parseThreadId(id) : undefined,
    workingDir: present(dir) ? checkWorkingDir(dir) : undefined,
    queueKey: !present(id) && last.queueKey ? parseQueueKey(last.queueKey) : undefined,
  };
}

async function resolveTarget(backend) {
  const target = loadTarget(backend);
  if (!target.workingDir) {
    target.workingDir = target.threadId
      ? checkWorkingDir(await backend.getWorkingDir(target.threadId))
      : process.cwd();
  }
  return target;
}

function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

function rememberTarget(backend, { threadId, workingDir, queueKey }, directory = root) {
  const target = { threadId: threadId ?? null, workingDir };
  if (!threadId && queueKey) target.queueKey = queueKey;
  writeState(path.join(stateDirectory(directory, backend), 'last-target.json'), target);
}

function targetRecord({ threadId, queueKey, workingDir }) {
  return { threadId, queueKey, workingDir };
}

async function runBridge(config) {
  let active, commands;
  const workers = new Map();
  const statusReplies = new Map();
  const { backend } = config;
  if (!config.botId || !config.secret || !config.ownerId || !backend) throw new Error('Invalid launcher settings');
  const stateDir = stateDirectory(root, backend);
  fs.mkdirSync(stateDir, { recursive: true });
  const messages = { ...eventMessages, ...backend.eventMessages };
  let connection = 'connecting';

  let client;
  let control;
  let stopping = false;
  let lastDelivery = null;
  let lastReply = null;
  let receiving = Promise.resolve();

  function log(event, details = {}, target = active ?? config) {
    const time = new Date().toISOString();
    if (event.startsWith('delivery_')) lastDelivery = { event, time };
    if (event.startsWith('reply_')) lastReply = { event, time };
    const line = JSON.stringify({ time, event, backend: backend.id, message: messages[event], ...details, workingDir: target.workingDir, threadId: target.threadId ?? null }) + '\n';
    fs.appendFileSync(path.join(stateDir, 'events.jsonl'), line);
    process.stdout.write(line);
  }
  async function stop(reason, code = 0) {
    if (stopping) return;
    stopping = true;
    connection = 'stopping';
    client?.disconnect();
    try {
      await receiving;
      await Promise.all([...statusReplies.values()].map(item => item.done));
      await Promise.all([...workers.values()].map(w => w.delivery.close()));
      commands?.close();
      log('stopped', { reason });
    } finally {
      control?.close();
      process.exitCode = code;
    }
  }

  try {
    control = await listenControl(() => ({ pid: process.pid, backend: backend.id, backendName: backend.name, connection, senderScope: 'all', replyToOrigin: true,
      threadId: active?.threadId ?? null, workingDir: active?.workingDir ?? config.workingDir, lastDelivery, lastReply }), () => stop('requested'));
    const botKey = createHash('sha256').update(config.botId).digest('hex').slice(0, 16);
    const queueMapping = id => path.join(stateDir, botKey, storageKey(id), 'queue.json');
    commands = createCommandStore(path.join(stateDir, 'memory', botKey));
    const sendReply = createWecomSender({ botId: config.botId, ownerId: config.ownerId });

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
        progressText: async route => {
          const title = route.senderId === config.ownerId ? await chatTitle(backend, current.threadId) : backend.name;
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
    // Snapshot status in receive order. Only title enrichment and its reply run
    // outside that sequence, so a slow backend cannot stall other conversations.
    function sendStatus(id, origin, route, requestId, snapshot) {
      if (statusReplies.has(id)) return;
      const done = describeStatus(backend, snapshot).then(reply => {
        applyPlan(commands.plan(id, () => ({ id, origin: origin.queueKey, route, requestId, reply })));
      }).catch(() => {
        log('receive_error', { wecomRequestId: requestId }, origin);
        void stop('receive_error', 1);
      }).finally(() => statusReplies.delete(id));
      statusReplies.set(id, { origin, done });
    }

    async function retireIdle() {
      for (const [key, w] of workers) {
        if (w !== active && ![...statusReplies.values()].some(item => item.origin === w) && w.delivery.idle()) {
          await w.delivery.close();
          workers.delete(key);
          commands.untrack(key);
        }
      }
    }
    for (const target of commands.targets()) openTarget(target);
    activate(config);
    for (const plan of commands.pending()) applyPlan(plan);
    await retireIdle();
    const quiet = () => {};
    client = new WSClient({
      botId: config.botId, secret: config.secret, maxReconnectAttempts: -1, maxAuthFailureAttempts: 2,
      logger: { debug: quiet, info: quiet, warn: quiet, error: quiet }
    });
    delete config.secret;
    const context = {
      botId: config.botId, ownerId: config.ownerId,
      saveMedia: createMediaStore(client, path.join(stateDir, botKey, 'media'), details => log('media_save_failed', details))
    };
    if (config.onAuthenticated) {
      client.once('authenticated', config.onAuthenticated);
      delete config.onAuthenticated;
    }
    client.on('authenticated', () => {
      connection = 'authenticated';
      log('authenticated');
    });
    client.on('message', frame => {
      if (connection !== 'authenticated' || stopping) return;
      // Keep messages in arrival order while the SDK downloads their attachments.
      receiving = receiving.then(async () => {
        const message = await formatIncoming(frame.body, context);
        if (!message) return;
        const route = message.route;
        const binding = route && commands.binding(route);
        let targetError, next = active, sources;
        try {
          if (binding) checkWorkingDir(binding.workingDir);
          const target = binding || await resolveTarget(backend);
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
        if (targetError && !repairingBinding && !['help', 'status', 'retry'].includes(cmd?.name)) {
          if (route) origin.delivery.enqueue(message.id, targetError,
            message.chatType, route, requestId, frame.body.from.userid, true);
          commands.finish(message.id);
          return;
        }
        if (cmd && route) {
          let target, reply, unbind = false;
          if (cmd.name === 'help') reply = cmd.arg ? '用法：/help' : helpText;
          else if (!owner) reply = '此指令仅限机器人绑定的本人使用。';
          else if (cmd.name === 'status' || cmd.name === 'retry') {
            const last = commands.lastTask(route);
            if (cmd.arg) reply = '用法：/' + cmd.name;
            else if (cmd.name === 'retry') {
              reply = last ? openQueue(last.target).delivery.retryTask(message.id, last.id, route, last.target.workingDir) : '本会话尚无任务。';
            } else {
              let previous;
              if (last) {
                const queue = openQueue(last.target);
                previous = { ...last.target, threadId: last.target.threadId ?? queue.threadId, media: last.media,
                  state: queue.delivery.taskState(last.id, route) };
              }
              sendStatus(message.id, origin, route, requestId, {
                target: targetRecord(next), sources, error: targetError, last: previous,
              });
              await retireIdle();
              return;
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
          else if (cmd.name === 'threads') {
            if (cmd.arg) reply = '用法：/threads';
            else {
              try {
                const threads = await backend.listThreads(origin.workingDir);
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
                const workingDir = checkWorkingDir(await backend.getWorkingDir(threadId));
                target = { threadId, workingDir };
                reply = '已切换聊天 ' + threadId + '\n工作目录：' + workingDir;
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
      }).catch(() => {
        log('receive_error');
        void stop('receive_error', 1);
      });
    });
    client.on('disconnected', reason => {
      if (stopping) return;
      connection = 'disconnected';
      log('disconnected');
      if (/new connection|disconnected_event/i.test(String(reason))) void stop('another_connection', 1);
    });
    client.on('reconnecting', attempt => {
      connection = 'reconnecting';
      log('reconnecting', { attempt });
    });
    client.on('error', error => {
      const code = String(error.message).match(/\bcode\s*[:=]\s*(-?\d+)/i)?.[1];
      log('connection_error', { code: code || null });
      if (error.name === 'WSAuthFailureError') void stop('authentication_failed', 1);
    });
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
    log('starting');
    client.connect();
  } catch (error) {
    if (control) await stop('startup_error', 1);
    throw error;
  }
}

module.exports = { checkWorkingDir, loadTarget, resolveTarget, runBridge };
