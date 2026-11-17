'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createDelivery } = require('../src/delivery.cjs');
const { createClaudeBackend } = require('../src/backends/claude.cjs');
const { createCodexBackend } = require('../src/backends/codex.cjs');

const threadId = '01234567-89ab-4def-8123-0123456789ab';
const route = { chatId: 'owner', chatType: 'single', senderId: 'owner' };

function fixture(t, timeoutMs = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cancel-'));
  const events = new EventEmitter(), calls = [], children = [], replies = [];
  const backend = createClaudeBackend({ claudePath: 'fixture', execute(_, args, options) {
    calls.push(args);
    const child = spawn(process.execPath, ['-e', `
      let text = '';
      process.stdin.on('data', chunk => text += chunk);
      process.stdin.on('end', () => {
        const session_id = '${threadId}';
        console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id, cwd: process.cwd() }));
        if (text.includes('hang')) setInterval(() => {}, 1000);
        else console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id, result: 'done' }));
      });
    `], options);
    children.push(child);
    return child;
  } });
  const delivery = createDelivery({ backend, ownerId: 'owner', threadId, workingDir: root, stateDir: root, taskTimeoutMs: timeoutMs,
    log: (event, details) => events.emit(event, details),
    sendReply: async (destination, text) => { replies.push({ destination, text }); events.emit('sent', text); },
  });
  t.after(async () => {
    for (const child of children) child.kill();
    await delivery.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, calls, replies, children, delivery,
    wait: event => once(events, event, { signal: AbortSignal.timeout(5000) }),
    enqueue: (id, text) => delivery.enqueue(id, text, 'single', route),
  };
}

test('cancel is scoped, idempotent, and never replays running or queued tasks', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const started = f.wait('delivery_submitted');
  f.enqueue('first', 'hang');
  await started;
  f.enqueue('second', 'must not run');
  assert.match(f.delivery.cancelTask('wrong', 'first', { ...route, chatId: 'other' }), /没有可取消/);
  assert.match(f.delivery.cancelTask('cancel-second', 'second', route), /已取消/);
  assert.equal(f.delivery.taskState('second', route).failureReason, 'task_cancelled');
  const stopped = f.wait('delivery_uncertain');
  const answer = f.delivery.cancelTask('cancel-first', 'first', route);
  assert.match(answer, /已请求取消/);
  await stopped;
  assert.equal(f.delivery.taskState('first', route).failureReason, 'task_cancelled');
  assert.match(f.delivery.retryTask('retry', 'first', route), /没有可安全重试/);
  const next = f.wait('delivery_completed');
  f.enqueue('third', 'success');
  assert.equal(f.delivery.cancelTask('cancel-first', 'third', route), answer);
  await next;
  assert.equal(f.calls.length, 2);
});

test('timeout returns a failure notice and releases the queue for the next task', { timeout: 15000 }, async t => {
  const f = fixture(t, 1000);
  const stopped = f.wait('delivery_uncertain');
  f.enqueue('first', 'hang');
  f.enqueue('second', 'success');
  assert.equal((await stopped)[0].reason, 'task_timeout');
  await f.wait('delivery_completed');
  assert.equal(f.calls.length, 2);
  assert.equal(f.delivery.taskState('first', route).failureReason, 'task_timeout');
  assert.ok(f.replies.some(reply => /超时/.test(reply.text)));
});

test('closing a delivery aborts its active CLI and preserves queued tasks for restart', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const started = f.wait('delivery_submitted');
  f.enqueue('first', 'hang');
  await started;
  f.enqueue('second', 'success');
  const stopped = f.wait('delivery_uncertain');
  await f.delivery.close();
  assert.equal((await stopped)[0].reason, 'bridge_stopped');
  assert.equal(f.calls.length, 1);
  const file = fs.readdirSync(f.root).find(name => name.startsWith('delivery-') && name.endsWith('.sqlite') && !name.endsWith('.lock.sqlite'));
  const db = new DatabaseSync(path.join(f.root, file));
  try {
    assert.equal(db.prepare('SELECT state FROM messages WHERE msg_id=?').get('second').state, 'queued');
    assert.equal(db.prepare('SELECT state FROM messages WHERE msg_id=?').get('first').state, 'uncertain');
  } finally { db.close(); }
});

test('Codex local execution also observes cancellation without desktop enqueue fallback', { timeout: 10000 }, async t => {
  const controller = new AbortController();
  let child;
  const backend = createCodexBackend({ codexPath: 'fixture', execute(_, args, options) {
    child = spawn(process.execPath, ['-e', `
      process.stdin.resume();
      console.log(JSON.stringify({type:'thread.started',thread_id:'${threadId}'}));
      console.log(JSON.stringify({type:'turn.started'}));
      setInterval(() => {}, 1000);
    `], options);
    return child;
  }, enqueue() { assert.fail('must not enqueue an aborted task'); } });
  t.after(() => child?.kill());
  const result = await backend.submit({ threadId, workingDir: process.cwd(), prompt: 'test',
    signal: controller.signal, onStarted: () => controller.abort('task_cancelled') });
  assert.deepEqual(result, { state: 'uncertain', reason: 'task_cancelled' });
});
