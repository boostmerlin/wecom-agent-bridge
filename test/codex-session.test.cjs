'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createCodexBackend } = require('../src/backends/codex.cjs');
const { createApprovals } = require('../src/approvals.cjs');
const threadId = '01234567-89ab-4def-8123-0123456789ab';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

// A real child with bidirectional JSON-RPC, including events arriving before the start response.
function server(mode, threadId) {
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const context = { threadId, turnId: 'turn', itemId: 'command' };
  const done = text => {
    send({ method: 'item/completed', params: { ...context, item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'do not send this' } } });
    send({ method: 'item/completed', params: { ...context, item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'completed' } } });
  };
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ id: m.id, result: {} });
    if (['thread/start', 'thread/resume'].includes(m.method)) {
      if (mode === 'busy') return send({ id: m.id, error: { code: -32600, message: 'thread ' + threadId + ' already has an active writer' } });
      send({ id: m.id, result: { thread: { id: threadId }, approvalPolicy: 'on-request' } });
    }
    if (m.method === 'turn/start') {
      send({ method: 'turn/started', params: { threadId, turn: { id: 'turn' } } });
      send({ id: 91, method: 'item/commandExecution/requestApproval', params: { ...context, command: 'echo test', cwd: process.cwd() } });
      send({ id: m.id, result: { turn: { id: 'turn' } } });
    }
    if (m.id === 91 && m.result) {
      if (mode === 'crash') return process.exit(7);
      done(m.result.decision);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

function fixture(t, mode = 'normal') {
  const calls = [], rpc = [], diagnostics = [];
  let child;
  const backend = createCodexBackend({ codexPath: 'fixture', enqueue: () => assert.fail('cannot queue approvals to desktop'),
    execute(file, args, options) {
      calls.push({ args, options });
      child = spawn(process.execPath, ['-e', '(' + server.toString() + ')(' + JSON.stringify(mode) + ',' + JSON.stringify(threadId) + ')'], options);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => { rpc.push(JSON.parse(chunk.toString())); return write(chunk, ...rest); };
      return child;
    } });
  t.after(() => child?.kill());
  const turn = { workingDir: process.cwd(), prompt: 'test', threadId, timeoutMs: 5000,
    onStarted() {}, onCreated() {}, onDiagnostic: item => diagnostics.push(item), onApproval: async () => ({ behavior: 'allow' }) };
  return { backend, turn, calls, rpc, diagnostics };
}

test('owner Codex uses an app-server human approval and returns only this turn final answer', async t => {
  const f = fixture(t);
  const result = await f.backend.submit(f.turn);
  assert.deepEqual(result, { state: 'completed', text: 'accept' });
  assert.ok(f.calls[0].args.includes('app-server'));
  const start = f.rpc.find(x => x.method === 'turn/start').params;
  assert.equal(start.approvalPolicy, 'on-request');
  assert.equal(start.approvalsReviewer, 'user');
  assert.equal(start.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(start.sandboxPolicy.networkAccess, true);
  assert.equal(f.diagnostics[0].command, 'app-server');
});

test('Codex approvals require the owner in the originating WeCom conversation', async t => {
  const f = fixture(t), sent = [];
  const route = { senderId: 'owner', chatType: 'single', chatId: 'owner' };
  const approvals = createApprovals({ ownerId: 'owner', sendReply: async (route, text) => sent.push({ route, text }) });
  t.after(() => approvals.close());
  const result = f.backend.submit({ ...f.turn, onApproval: details => approvals.request({ ...details, backend: 'codex', route }) });
  while (!sent.length) await tick();
  assert.match(sent[0].text, /^Codex 审批/);
  assert.match(approvals.respond({ ...route, senderId: 'other' }, 'approve', ''), /本人/);
  assert.match(approvals.respond({ ...route, chatType: 'group', chatId: 'group' }, 'approve', ''), /没有/);
  assert.ok(!f.rpc.some(x => x.id === 91 && x.result));
  approvals.respond(route, 'deny', '');
  assert.equal((await result).text, 'decline');
});

test('Codex creates a thread before submitting and never retries an ambiguous execution', async t => {
  const f = fixture(t, 'crash');
  const created = [];
  const result = await f.backend.submit({ ...f.turn, threadId: undefined, onCreated: id => created.push(id) });
  assert.deepEqual(created, [threadId]);
  assert.equal(result.state, 'uncertain');
  assert.equal(f.calls.length, 1);
  assert.equal(f.diagnostics[0].exitCode, 7);
});

test('a busy desktop thread is rejected without silently losing WeCom approval control', async t => {
  const f = fixture(t, 'busy');
  const result = await f.backend.submit(f.turn);
  assert.deepEqual(result, { state: 'rejected', reason: 'thread_busy' });
  assert.ok(!f.rpc.some(x => x.method === 'turn/start'));
});

test('cancellation invalidates pending human approval and terminates Codex', async t => {
  const f = fixture(t), controller = new AbortController();
  let pending;
  const result = f.backend.submit({ ...f.turn, signal: controller.signal, onApproval: details => {
    pending = details;
    return new Promise(resolve => details.signal.addEventListener('abort', () => resolve({ behavior: 'deny' }), { once: true }));
  } });
  while (!pending) await tick();
  controller.abort();
  assert.equal((await result).reason, 'task_cancelled');
  assert.equal(pending.signal.aborted, true);
  assert.ok(!f.rpc.some(x => x.id === 91 && x.result?.decision === 'accept'));
});

test('task timeout expires pending approval before a late allow can reach Codex', { timeout: 10000 }, async t => {
  const f = fixture(t);
  let pending;
  const result = await f.backend.submit({ ...f.turn, timeoutMs: 1500, onApproval: details => {
    pending = details;
    return new Promise(resolve => details.signal.addEventListener('abort', () => resolve({ behavior: 'allow' }), { once: true }));
  } });
  assert.equal(result.reason, 'task_timeout');
  assert.equal(pending.signal.aborted, true);
  assert.ok(!f.rpc.some(x => x.id === 91 && x.result?.decision === 'accept'));
});
