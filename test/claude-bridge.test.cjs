'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { createClaudeBackend } = require('../src/backends/claude.cjs');

const sessionA = '01234567-89ab-4def-8123-0123456789ab';
const sessionB = '11234567-89ab-4def-8123-0123456789ab';
const sessionC = '21234567-89ab-4def-8123-0123456789ab';

test('Claude bridge routes replies, resumes after restart and isolates Codex state and external senders', { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-claude-bridge-'));
  const src = path.join(root, 'src');
  fs.cpSync(path.join(__dirname, '..', 'src'), src, { recursive: true });
  const sdk = path.join(root, 'node_modules', '@wecom', 'aibot-node-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'index.js'), '');
  const messages = new EventEmitter();
  let socket, stop, failReply = false;
  function inject(file, exports) {
    const id = require.resolve(file);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  inject(sdk, { WSClient: class extends EventEmitter {
    constructor() { super(); socket = this; }
    connect() { this.emit('authenticated'); }
    disconnect() {}
  } });
  inject(path.join(src, 'control.cjs'), { listenControl: async (_, end) => { stop = end; return { close() {} }; } });
  inject(path.join(src, 'wecom-reply.cjs'), { createWecomSender: () => async (route, text) => {
    if (failReply && text === '恢复答复') {
      failReply = false;
      messages.emit('send-failed');
      throw Object.assign(new Error('fixture rejected send'), { definitelyUnsent: true });
    }
    messages.emit('sent', route, text);
  } });
  t.after(async () => {
    await stop?.('test');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(root, '.state'));
  const codexTarget = JSON.stringify({ threadId: sessionA, workingDir: root });
  fs.writeFileSync(path.join(root, '.state', 'last-target.json'), codexTarget);
  fs.writeFileSync(path.join(root, '.config.local.json'), JSON.stringify({ backend: 'claude', threadId: sessionA,
    workingDir: root, backends: { claude: { workingDir: project } } }));
  const calls = [];
  let created = 0, inFlight = 0, maxInFlight = 0;
  const sessionDirs = new Map([[sessionB, root]]);
  const backend = createClaudeBackend({ claudePath: 'fixture', loadSessions: async () => ({
    getSessionInfo: async id => sessionDirs.has(id) ? { sessionId: id, cwd: sessionDirs.get(id), summary: 'Claude 会话' } : undefined,
    listSessions: async ({ dir }) => [...sessionDirs].filter(([, cwd]) => cwd === dir).map(([sessionId, cwd]) => ({ sessionId, cwd, summary: 'Claude 会话' })),
  }), execute(file, args, options) {
    const resumed = args.indexOf('--resume');
    const session = resumed >= 0 ? args[resumed + 1] : [sessionA, sessionC][created++];
    sessionDirs.set(session, options.cwd);
    const call = { session, resumed: resumed >= 0, cwd: options.cwd };
    calls.push(call);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    const child = spawn(process.execPath, ['-e', `
      let prompt = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', value => { prompt += value; });
      process.stdin.on('end', () => {
        const session = process.env.FIXTURE_SESSION;
        process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: session }) + '\\n');
        require('node:fs').writeFileSync(process.env.FIXTURE_PROMPT, prompt);
        if (prompt.includes('HANG-CANCEL')) { setInterval(() => {}, 1000); return; }
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: session,
          result: prompt.includes('保存失败回执') ? '恢复答复' : '收到' }) + '\\n');
      });
    `], { ...options, env: { ...options.env, FIXTURE_SESSION: session, FIXTURE_PROMPT: path.join(root, 'prompt-' + calls.length) } });
    // Capture using this turn's index, independently of following submissions.
    const index = calls.length;
    child.once('close', () => { inFlight--; call.prompt = fs.readFileSync(path.join(root, 'prompt-' + index), 'utf8'); });
    return child;
  } });
  const submit = backend.submit;
  backend.submit = turn => submit({ ...turn, onStarted() { turn.onStarted(); messages.emit('started'); } });
  const main = require(path.join(src, 'main.cjs'));
  const start = async () => main.runBridge({ backend, ...await main.resolveTarget(backend), botId: 'bot', ownerId: 'me', secret: 'fixture' });
  let serial = 0;
  function wait(event, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { messages.off(event, listen); reject(new Error('Timed out waiting for ' + event)); }, 4000);
      function listen(...args) {
        if (!predicate(...args)) return;
        clearTimeout(timer);
        messages.off(event, listen);
        resolve(args);
      }
      messages.on(event, listen);
    });
  }
  function emit(text, { group = false, sender = 'me', id = String(++serial) } = {}) {
    socket.emit('message', { headers: { req_id: 'req-' + id }, body: { msgid: id, chattype: group ? 'group' : 'single',
      chatid: group ? 'team' : sender, from: { userid: sender }, msgtype: 'text', text: { content: text } } });
    return id;
  }
  async function send(text, options = {}) {
    const reply = wait('sent', route => route.chatId === (options.group ? 'team' : options.sender || 'me'));
    emit(text, options);
    return (await reply)[1];
  }
  await start();
  assert.equal(await send('first', { group: true }), '收到');
  assert.equal(calls[0].resumed, false);
  assert.equal(calls[0].cwd, project);
  assert.match(await send('/threads', { group: true }), new RegExp(sessionA));
  assert.match(await send('/status', { group: true }), /后端：Claude Code[\s\S]*回复：已回发/);
  assert.match(await send('/threads'), new RegExp(sessionA));
  assert.match(await send('/memory 回复语言 = 中文'), /已记住/);
  const pair = wait('sent', route => route.chatId === 'me');
  const duplicate = emit('second');
  emit('duplicate must not execute', { id: duplicate });
  await pair;
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /回复语言：中文/);
  await stop('restart');
  await start();
  assert.equal(await send('after restart'), '收到');
  assert.equal(calls[2].session, sessionA);
  assert.equal(calls[2].resumed, true);
  assert.match(await send('/thread ' + sessionB), /已切换聊天/);
  assert.equal(await send('switched'), '收到');
  assert.equal(calls[3].cwd, root);
  assert.equal(calls[3].session, sessionB);
  assert.match(await send('/bind ' + project, { group: true }), /已绑定/);
  assert.equal(await send('bound new', { group: true }), '收到');
  assert.equal(calls[4].session, sessionC);
  assert.equal(calls[4].resumed, false);
  const beforeExternal = calls.length;
  assert.match(await send('guest task', { group: true, sender: 'guest' }), /暂不支持其他人的任务[\s\S]*未执行/);
  assert.equal(calls.length, beforeExternal);
  failReply = true;
  const failed = wait('send-failed');
  emit('保存失败回执', { group: true });
  await failed;
  await stop('restart');
  await start();
  const beforeRetry = calls.length;
  const restored = wait('sent', (_, text) => text === '恢复答复');
  const retry = wait('sent', (_, text) => text.includes('未发出的分段'));
  emit('/retry', { group: true });
  await Promise.all([restored, retry]);
  assert.equal(calls.length, beforeRetry);
  let received = 0;
  const drained = wait('sent', (route, text) => route.chatId === 'team' && text === '收到' && ++received === 2);
  const queued = emit('queued first', { group: true });
  emit('duplicate replacement', { group: true, id: queued });
  emit('queued second', { group: true });
  await drained;
  assert.equal(calls.length, beforeRetry + 2);
  assert.ok(calls.at(-2).prompt.includes('queued first'));
  assert.ok(calls.at(-1).prompt.includes('queued second'));
  assert.equal(maxInFlight, 1);
  assert.equal(fs.readFileSync(path.join(root, '.state', 'last-target.json'), 'utf8'), codexTarget);
  const last = JSON.parse(fs.readFileSync(path.join(root, '.state', 'backends', 'claude', 'last-target.json'), 'utf8'));
  assert.equal(last.threadId, sessionB);

  const started = wait('started');
  emit('HANG-CANCEL', { group: true });
  await started;
  assert.match(await send('/cancel', { group: true, sender: 'guest' }), /仅限.*本人/);
  assert.match(await send('/cancel'), /没有可取消/);
  assert.match(await send('/cancel extra', { group: true }), /用法/);
  const cancelled = wait('sent', (route, text) => route.chatId === 'team' && text.includes('本地执行'));
  const acknowledged = wait('sent', (route, text) => route.chatId === 'team' && text.includes('已请求取消'));
  emit('@机器人 /cancel', { group: true });
  await Promise.all([cancelled, acknowledged]);
  assert.match(await send('/status', { group: true }), /已取消/);
  assert.match(await send('/retry', { group: true }), /没有可安全重试/);
  const beforeNext = calls.length;
  assert.equal(await send('after cancellation', { group: true }), '收到');
  assert.equal(calls.length, beforeNext + 1);
});
