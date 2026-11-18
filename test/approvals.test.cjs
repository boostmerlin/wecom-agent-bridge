'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApprovals } = require('../src/approvals.cjs');
const { parseCommand } = require('../src/commands.cjs');
const route = { chatType: 'group', chatId: 'team', senderId: 'owner' };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const sent = [], logs = [];
  const approvals = createApprovals({ ownerId: 'owner', sendReply: async (route, text) => sent.push({ route, text }),
    log: (event, details) => logs.push({ event, ...details }), ...options });
  t.after(() => approvals.close());
  const request = overrides => approvals.request({ route, backend: 'claude', workingDir: 'D:/project', threadId: 'thread',
    toolName: 'Bash', input: { command: 'git push origin main' }, ...overrides });
  const id = () => sent.map(x => x.text).join('\n').match(/审批 ([a-f0-9]{12})/)[1];
  return { approvals, sent, logs, request, id };
}

test('only the owner in the original conversation can approve a pending tool exactly once', async t => {
  const f = fixture(t);
  const pending = f.request();
  await tick();
  assert.deepEqual(f.sent[0].route, route);
  assert.match(f.sent[0].text, /git push origin main/);
  assert.match(f.approvals.respond({ ...route, senderId: 'guest' }, 'approve', f.id()), /本人/);
  assert.match(f.approvals.respond({ ...route, chatId: 'other' }, 'approve', f.id()), /没有|不存在|失效/);
  assert.match(f.approvals.respond(route, 'approve', f.id()), /已允许/);
  assert.deepEqual(await pending, { behavior: 'allow' });
  assert.match(f.approvals.respond(route, 'approve', f.id()), /没有|不存在|失效/);
  assert.ok(f.logs.some(x => x.event === 'approval_resolved' && x.decision === 'allow'));
  assert.ok(!JSON.stringify(f.logs).includes('git push'));
});

test('bare decisions require a unique request and numbered denials do not affect other requests', async t => {
  const f = fixture(t);
  const first = f.request(), second = f.request();
  await tick();
  assert.match(f.approvals.respond(route, 'approve', ''), /多条|编号/);
  f.approvals.respond(route, 'deny', f.id());
  assert.equal((await first).behavior, 'deny');
  f.approvals.respond(route, 'approve', '');
  assert.equal((await second).behavior, 'allow');
});

test('timeout, cancellation, close and send failures cannot grant approval', async t => {
  const f = fixture(t, { timeoutMs: 30 });
  const timed = f.request();
  assert.equal((await timed).behavior, 'deny');
  const controller = new AbortController();
  const cancelled = f.request({ signal: controller.signal });
  await tick();
  controller.abort();
  assert.equal((await cancelled).behavior, 'deny');
  const closed = f.request();
  f.approvals.close();
  assert.equal((await closed).behavior, 'deny');
  assert.equal((await f.request()).behavior, 'deny');
  const failed = fixture(t, { sendReply: async () => { throw new Error('not sent'); } });
  assert.equal((await failed.request()).behavior, 'deny');
});

test('approval requires all details delivered, secrets are masked and oversized requests fail closed', async t => {
  let delivered;
  const f = fixture(t, { sendReply: () => new Promise(resolve => { delivered = resolve; }) });
  const pending = f.request();
  await tick();
  assert.match(f.approvals.respond(route, 'approve', ''), /发送|尚未/);
  delivered();
  await tick();
  f.approvals.respond(route, 'deny', '');
  assert.equal((await pending).behavior, 'deny');
  const masked = fixture(t);
  const sensitive = masked.request({ input: { api_key: 'private-value', command: 'echo safe' } });
  await tick();
  assert.ok(!JSON.stringify(masked.sent).includes('private-value'));
  masked.approvals.respond(route, 'deny', '');
  await sensitive;
  assert.equal((await masked.request({ input: { content: 'x'.repeat(70000) } })).behavior, 'deny');
  assert.ok(masked.sent.every(x => Buffer.byteLength(x.text) <= 6144));
});

test('approval commands accept mention prefixes and explicit decisions without matching prose', () => {
  const parse = content => parseCommand({ msgtype: 'text', chattype: 'group', text: { content } });
  assert.deepEqual(parse('@机器人 允许 abc123'), { name: 'approve', arg: 'abc123' });
  assert.deepEqual(parse('拒绝'), { name: 'deny', arg: '' });
  assert.deepEqual(parse('/approve abc123'), { name: 'approve', arg: 'abc123' });
  assert.deepEqual(parse('/拒绝 abc123'), { name: 'deny', arg: 'abc123' });
  assert.deepEqual(parse('/approve wrong-id'), { name: 'approve', arg: 'wrong-id' });
  assert.equal(parse('请允许执行这个任务'), null);
});

test('approval commands and diffs are literal JSON, unable to hide links or break the code block', async t => {
  const f = fixture(t);
  const input = { command: 'echo [safe](https://example.test/hidden) **bold** `code` ```',
    changes: [{ diff: '+[label](https://example.test/file)\n+```\n+<font color="warning">text</font>' }] };
  const pending = f.request({ input });
  await tick();
  const text = f.sent[0].text;
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.equal(blocks.length, 1);
  assert.deepEqual(JSON.parse(blocks[0][1]).参数, input);
  assert.equal((text.match(/```/g) || []).length, 2);
  assert.ok(Buffer.byteLength(text) <= 6144);
  f.approvals.respond(route, 'deny', '');
  await pending;
});
