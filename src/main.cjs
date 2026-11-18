'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { WSClient } = require('@wecom/aibot-node-sdk');
const { listenControl } = require('./control.cjs');
const { createWecomSender } = require('./wecom-reply.cjs');
const { parseCommand } = require('./commands.cjs');
const { isIncoming } = require('./incoming.cjs');
const { createBackendRuntime } = require('./backend-runtime.cjs');
const { createMessageRouting } = require('./message-routing.cjs');
const { taskTimeout } = require('./process-lifecycle.cjs');
const { createApprovals } = require('./approvals.cjs');
const targets = require('./target-config.cjs');

async function runBridge(config) {
  if (!config.botId || !config.secret || !config.ownerId || !config.backend) throw new Error('Invalid launcher settings');
  // Local config supplies startup defaults. Only each backend's last-target file is hot-loaded.
  const defaults = targets.readSettings(path.join(targets.root, '.config.local.json'));
  config.taskTimeoutMs = taskTimeout(config.taskTimeoutMs === undefined ? defaults.taskTimeoutMs : config.taskTimeoutMs);
  const runtimes = new Map();
  let active, client, control, routing, approvals, stopping = false;
  let connection = 'connecting', receiving = Promise.resolve();
  const log = (event, details) => active?.log(event, details);
  const onError = () => { log('receive_error'); void stop('receive_error', 1); };
  const onInterrupt = () => void stop('SIGINT');
  const onTerminate = () => void stop('SIGTERM');

  async function stop(reason, code = 0) {
    if (stopping) return;
    stopping = true;
    connection = 'stopping';
    client?.disconnect();
    approvals?.close();
    try {
      await receiving;
      await Promise.all([...runtimes.values()].map(runtime => runtime.close()));
      routing?.close();
      log('stopped', { reason });
    } finally {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      control?.close();
      process.exitCode = code;
    }
  }

  try {
    control = await listenControl(() => ({ pid: process.pid, connection, replyToOrigin: true,
      ...(active?.status() || { backend: config.backend.id, backendName: config.backend.name }),
    }), () => stop('requested'));
    const quiet = () => {};
    client = new WSClient({ botId: config.botId, secret: config.secret, maxReconnectAttempts: -1, maxAuthFailureAttempts: 2,
      logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    });
    delete config.secret;
    const sendReply = createWecomSender({ botId: config.botId, ownerId: config.ownerId });
    approvals = createApprovals({ ownerId: config.ownerId, sendReply,
      log: (event, details) => runtimes.get(details.backend)?.log(event, details, details) });
    const botKey = createHash('sha256').update(config.botId).digest('hex').slice(0, 16);
    const legacySources = [...new Set(['codex', 'claude', config.backend.id])].map(id => ({
      backend: id,
      file: path.join(targets.stateDirectory(targets.root, { id }), 'memory', botKey, 'commands.sqlite'),
    }));
    routing = createMessageRouting(path.join(targets.root, '.state', 'routing', botKey), legacySources);
    async function open(backend, initialTarget) {
      const runtime = await createBackendRuntime({ config, backend, initialTarget, defaults, client, sendReply, onError,
        requestApproval: details => approvals.request(details) });
      runtimes.set(backend.id, runtime);
      return runtime;
    }
    async function getRuntime(id) {
      if (runtimes.has(id)) return runtimes.get(id);
      const load = config.loadBackend || require('./backends/load.cjs').loadBackend;
      const backend = await load(id);
      if (backend.id !== id) throw new Error('Unexpected backend');
      return open(backend, await targets.resolveTarget(backend, defaults));
    }
    active = await open(config.backend, config);
    if (config.onAuthenticated) {
      client.once('authenticated', config.onAuthenticated);
      delete config.onAuthenticated;
    }
    client.on('authenticated', () => { connection = 'authenticated'; log('authenticated'); });
    client.on('message', frame => {
      if (connection !== 'authenticated' || stopping || !isIncoming(frame.body, config.botId)) return;
      // Serialize routing decisions, not backend execution. Existing workers retain their backend.
      receiving = receiving.then(async () => {
        const body = frame.body;
        const receipt = routing.claim(body.msgid, active.backend.id);
        if (receipt.done) return;
        const origin = await getRuntime(receipt.backend);
        // Recover a crash after a local acknowledgement committed but before routing did.
        if (origin.handled(body.msgid)) { routing.finish(body.msgid); return; }
        const cmd = parseCommand(body);
        const hasRoute = body.chattype === 'single' || (typeof body.chatid === 'string' && body.chatid.trim());
        let reply, selected;
        if (['approve', 'deny'].includes(cmd?.name) && hasRoute) {
          reply = approvals.respond({ chatType: body.chattype,
            chatId: body.chattype === 'group' ? body.chatid : body.from.userid,
            senderId: body.from.userid }, cmd.name, cmd.arg);
        }
        if (cmd?.name === 'backend' && hasRoute) {
          const requested = cmd.arg.toLowerCase();
          if (body.from.userid !== config.ownerId) reply = '此指令仅限机器人绑定的本人使用。';
          else if (!requested) reply = '当前后端：' + active.backend.name + ' (' + active.backend.id + ')。可用 /backend codex 或 /backend claude 切换。';
          else if (!['codex', 'claude'].includes(requested)) reply = '用法：/backend、/backend codex 或 /backend claude';
          else if (requested === active.backend.id) reply = '当前已使用 ' + active.backend.name + ' (' + requested + ')。';
          else {
            try {
              selected = await getRuntime(requested);
              reply = '已切换为 ' + selected.backend.name + ' (' + requested + ')。对整个机器人生效，原后端的任务继续处理；重启后使用配置中的默认后端。';
            } catch {
              log('backend_switch_failed', { requestedBackend: requested });
              reply = '后端切换失败，继续使用 ' + active.backend.name + '。请检查目标 CLI 的安装、登录状态及默认目录。';
            }
          }
        }
        const previous = active;
        if (selected) active = selected;
        let completion;
        try { completion = await origin.handle(frame, reply); }
        catch (error) { active = previous; throw error; }
        const finish = () => {
          // Async status handling may have failed and stopped the runtime without saving a reply.
          if (origin.handled(body.msgid)) routing.finish(body.msgid);
        };
        if (completion?.done) void completion.done.then(finish).catch(onError);
        else finish();
        if (selected) {
          log('backend_switched', { previousBackend: previous.backend.id });
        }
      }).catch(onError);
    });
    client.on('disconnected', reason => {
      if (stopping) return;
      connection = 'disconnected'; log('disconnected');
      if (/new connection|disconnected_event/i.test(String(reason))) void stop('another_connection', 1);
    });
    client.on('reconnecting', attempt => { connection = 'reconnecting'; log('reconnecting', { attempt }); });
    client.on('error', error => {
      const code = String(error.message).match(/\bcode\s*[:=]\s*(-?\d+)/i)?.[1];
      log('connection_error', { code: code || null });
      if (error.name === 'WSAuthFailureError') void stop('authentication_failed', 1);
    });
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    log('starting');
    client.connect();
  } catch (error) {
    if (control) await stop('startup_error', 1);
    throw error;
  }
}

module.exports = { ...targets, runBridge };
