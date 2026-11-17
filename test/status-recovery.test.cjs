'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

test('a status reply storage failure stays pending and redelivery after restart sends exactly one reply', { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-status-recovery-'));
  const src = path.join(root, 'src');
  fs.cpSync(path.join(__dirname, '..', 'src'), src, { recursive: true });
  const sdk = path.join(root, 'node_modules', '@wecom', 'aibot-node-sdk');
  fs.mkdirSync(sdk, { recursive: true }); fs.writeFileSync(path.join(sdk, 'index.js'), '');
  const events = new EventEmitter(), replies = [];
  let socket, stop, failStatus = true;
  function inject(file, exports) {
    const id = require.resolve(file);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  inject(sdk, { WSClient: class extends EventEmitter {
    constructor() { super(); socket = this; }
    connect() { this.emit('authenticated'); }
    disconnect() {}
  } });
  inject(path.join(src, 'control.cjs'), { listenControl: async (_, end) => {
    stop = end; return { close() { events.emit('closed'); } };
  } });
  inject(path.join(src, 'wecom-reply.cjs'), { createWecomSender: () => async (_, text) => {
    replies.push(text); events.emit('reply', text);
  } });
  const commandFile = path.join(src, 'commands.cjs');
  const original = require(commandFile);
  inject(commandFile, { ...original, createCommandStore(...args) {
    const store = original.createCommandStore(...args), plan = store.plan;
    store.plan = (id, ...rest) => {
      if (failStatus && id === 'status-request') throw Error('simulated status storage failure');
      return plan(id, ...rest);
    };
    return store;
  } });
  const previousExitCode = process.exitCode;
  t.after(async () => {
    await stop?.(); process.exitCode = previousExitCode;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const main = require(path.join(src, 'main.cjs'));
  const backend = { id: 'codex', name: 'Codex', parseThreadId: value => value,
    submit: async () => assert.fail('a command must never execute a model task') };
  const start = () => main.runBridge({ backend, workingDir: root, botId: 'bot', ownerId: 'owner', secret: 'fake' });
  const emit = (id = 'status-request', content = '/status') => socket.emit('message', {
    body: { msgid: id, chattype: 'single', from: { userid: 'owner' }, msgtype: 'text', text: { content } },
  });
  const wait = event => once(events, event, { signal: AbortSignal.timeout(4000) });
  const key = createHash('sha256').update('bot').digest('hex').slice(0, 16);
  function recorded(directory, file, table) {
    const db = new DatabaseSync(path.join(root, '.state', directory, key, file), { readOnly: true });
    try { return db.prepare('SELECT done FROM ' + table + ' WHERE id=?').get('status-request').done; }
    finally { db.close(); }
  }
  await start();
  const closed = wait('closed'); emit(); await closed;
  process.exitCode = previousExitCode;
  assert.equal(replies.length, 0);
  assert.equal(recorded('routing', 'messages.sqlite', 'routes'), 0);
  assert.equal(recorded('memory', 'commands.sqlite', 'received'), 0);
  failStatus = false;
  await start();
  const recovered = wait('reply'); emit();
  assert.match((await recovered)[0], /下一条消息/);
  // A following command is a barrier for both the retry and duplicate callback.
  emit();
  const barrier = wait('reply'); emit('barrier', '/help'); await barrier;
  assert.equal(replies.filter(text => text.includes('下一条消息 →')).length, 1);
  assert.equal(recorded('routing', 'messages.sqlite', 'routes'), 1);
  assert.equal(recorded('memory', 'commands.sqlite', 'received'), 1);
});
