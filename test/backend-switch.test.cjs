'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');

test('backend switches preserve in-flight work, isolate state, deduplicate globally and use startup defaults', { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-switch-'));
  const src = path.join(root, 'src');
  fs.cpSync(path.join(__dirname, '..', 'src'), src, { recursive: true });
  const sdk = path.join(root, 'node_modules', '@wecom', 'aibot-node-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'index.js'), '');
  const events = new EventEmitter();
  let socket, stop, status, connections = 0;
  function inject(file, exports) {
    const id = require.resolve(file);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  inject(sdk, { WSClient: class extends EventEmitter {
    constructor() { super(); socket = this; connections++; }
    connect() { this.emit('authenticated'); }
    disconnect() {}
  } });
  inject(path.join(src, 'control.cjs'), { listenControl: async (get, end) => {
    status = get; stop = end; return { close() {} };
  } });
  inject(path.join(src, 'wecom-reply.cjs'), { createWecomSender: () => async (route, text) => events.emit('sent', route, text) });
  let release;
  t.after(async () => { release?.(); await stop?.(); fs.rmSync(root, { recursive: true, force: true }); });
  const codexDir = path.join(root, 'codex-project'), claudeDir = path.join(root, 'claude-project');
  fs.mkdirSync(codexDir); fs.mkdirSync(claudeDir);
  const initial = { backend: 'codex', backends: {
    codex: { workingDir: codexDir }, claude: { workingDir: claudeDir },
  } };
  const configFile = path.join(root, '.config.local.json');
  fs.writeFileSync(configFile, JSON.stringify(initial));
  const calls = [], loaded = [];
  const ids = { codex: '11111111-1111-4111-8111-111111111111', claude: '22222222-2222-4222-8222-222222222222' };
  function backend(id) {
    return { id, name: id, parseThreadId: value => value, getWorkingDir: async () => id === 'codex' ? codexDir : claudeDir,
      getThreadTitle: async () => id + ' title', listThreads: async () => [],
      async submit(turn) {
        calls.push({ id, ...turn });
        if (!turn.threadId) turn.onCreated(ids[id]);
        turn.onStarted();
        if (turn.prompt.includes('HOLD')) { events.emit('held'); await new Promise(resolve => { release = resolve; }); }
        return { state: 'completed', text: id + ' result' };
      },
    };
  }
  let failLoad = true;
  const { createCommandStore } = require(path.join(src, 'commands.cjs'));
  const legacyKey = createHash('sha256').update('bot').digest('hex').slice(0, 16);
  const legacy = createCommandStore(path.join(root, '.state', 'memory', legacyKey));
  legacy.claim('legacy-message', ids.codex);
  legacy.finish('legacy-message');
  legacy.close();
  const main = require(path.join(src, 'main.cjs'));
  const start = async () => {
    const selected = backend(main.readBackend());
    await main.runBridge({ backend: selected, ...await main.resolveTarget(selected), botId: 'bot', ownerId: 'owner', secret: 'fake',
      loadBackend: async id => { loaded.push(id); if (failLoad) throw Error('secret provider error'); return backend(id); },
    });
  };
  let serial = 0;
  function emit(text, { sender = 'owner', group = false, id = String(++serial) } = {}) {
    socket.emit('message', { body: { msgid: id, from: { userid: sender }, chattype: group ? 'group' : 'single',
      chatid: group ? 'team' : sender, msgtype: 'text', text: { content: text } } });
    return id;
  }
  function waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { events.off('sent', listen); reject(Error('reply timeout')); }, 4000);
      function listen(route, text) {
        if (!predicate(route, text)) return;
        clearTimeout(timer); events.off('sent', listen); resolve(text);
      }
      events.on('sent', listen);
    });
  }
  async function send(text, options = {}) {
    const pending = waitFor(route => route.chatId === (options.group ? 'team' : options.sender || 'owner'));
    emit(text, options);
    return pending;
  }
  await start();
  assert.match(await send('/backend'), /codex/);
  assert.equal(calls.length, 0, 'backend commands must not go to the model');
  assert.match(await send('/backend claude', { sender: 'guest' }), /仅限.*本人/);
  assert.equal(loaded.length, 0);
  assert.match(await send('/backend invalid'), /用法/);
  // A callback for another bot or a group without a reply route must not switch.
  socket.emit('message', { body: { msgid: 'foreign-bot', aibotid: 'other', from: { userid: 'owner' },
    chattype: 'single', msgtype: 'text', text: { content: '/backend claude' } } });
  socket.emit('message', { body: { msgid: 'no-route', from: { userid: 'owner' },
    chattype: 'group', msgtype: 'text', text: { content: '/backend claude' } } });
  assert.match(await send('/backend'), /codex/);
  assert.equal(loaded.length, 0);
  assert.match(await send('/backend claude'), /切换失败/);
  assert.equal(status().backend, 'codex');
  failLoad = false;
  assert.match(await send('/bind ' + codexDir, { group: true }), /已绑定/);
  const held = once(events, 'held');
  const heldId = emit('HOLD', { group: true }); await held;
  // Local defaults are a startup snapshot; changing the file cannot redirect the next backend.
  fs.writeFileSync(configFile, JSON.stringify({ backend: 'claude', backends: { claude: { workingDir: root } } }));
  const switched = waitFor((_, text) => text.includes('已切换') && text.includes('claude'));
  const switchId = emit('/backend claude'); await switched;
  assert.equal(status().backend, 'claude');
  assert.equal(connections, 1);
  emit('legacy task redelivery', { id: 'legacy-message' });
  emit('HOLD duplicate', { group: true, id: heldId });
  assert.match(await send('/backend'), /claude/);
  assert.equal(calls.length, 1);
  assert.equal(await send('new task'), 'claude result');
  assert.equal(calls.at(-1).workingDir, claudeDir);
  const claudeHistory = await send('/history');
  assert.ok(claudeHistory.includes(ids.claude));
  assert.ok(claudeHistory.includes(claudeDir));
  assert.ok(!claudeHistory.includes(ids.codex));
  const oldReply = waitFor((route, text) => route.chatId === 'team' && text === 'codex result');
  release(); await oldReply;
  assert.match(await send('/memory answer = concise'), /已记住/);
  assert.match(await send('/backend codex'), /已切换/);
  const codexHistory = await send('/history', { group: true });
  assert.ok(codexHistory.includes('【当前】' + ids.codex));
  assert.ok(!codexHistory.includes(ids.claude));
  assert.match(await send('/status', { group: true }), /会话绑定/);
  emit('/backend claude', { id: switchId });
  assert.match(await send('/backend'), /codex/);
  assert.match(await send('/memory'), /还没有记忆/);
  assert.equal(await send('continued', { group: true }), 'codex result');
  assert.equal(calls.at(-1).threadId, ids.codex);
  assert.match(await send('/backend claude'), /已切换/);
  assert.match(await send('/memory'), /concise/);
  // Deleting state still falls back to the startup snapshot.
  fs.rmSync(path.join(root, '.state', 'backends', 'claude', 'last-target.json'));
  assert.equal(await send('state removed'), 'claude result');
  assert.equal(calls.at(-1).workingDir, claudeDir);
  fs.writeFileSync(configFile, JSON.stringify(initial));
  await stop();
  // Simulate a crash between the local command acknowledgement and the global receipt.
  const key = createHash('sha256').update('bot').digest('hex').slice(0, 16);
  const receipts = new DatabaseSync(path.join(root, '.state', 'routing', key, 'messages.sqlite'));
  receipts.prepare('UPDATE routes SET done=0 WHERE id=?').run(switchId);
  receipts.close();
  await start();
  assert.equal(status().backend, 'codex', 'runtime switches must not replace the startup default');
  assert.ok((await send('/history')).includes(ids.codex));
  emit('/backend claude', { id: switchId });
  assert.match(await send('/backend'), /codex/);
  assert.equal(fs.readFileSync(configFile, 'utf8'), JSON.stringify(initial));
});
