'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { createReplyReader, readThreadCwd, queueMessage } = require('../src/backends/codex-history.cjs');
const { createCodexBackend } = require('../src/backends/codex.cjs');
const { chatTitle, describeStatus } = require('../src/task-status.cjs');

const { buildWecomPrompt } = require('../src/delivery.cjs');

const threadId = '01a1a553-da24-79f1-830b-7547c8efc9c6';
const token = n => n.toString(16).padStart(32, '0');
const user = text => ({ type: 'userMessage', content: [{ type: 'text', text }] });
const marked = n => user('[wecom-request:' + token(n) + ']\n来自聊天的正文');
const answer = text => ({ type: 'agentMessage', phase: 'final_answer', text });
const turn = (id, items, status = 'completed') => ({ id, status, items, itemsView: 'full' });

function fixture(pages, timeoutMs = 1000, lookup = false, queueHandler) {
  const methods = [];
  const children = [];
  function execute(command, args, options) {
    assert.equal(command, 'codex.exe');
    assert.deepEqual(args, ['app-server', '--stdio']);
    assert.equal(options.shell, false);
    assert.equal(options.cwd, lookup ? undefined : __dirname);
    const child = new EventEmitter();
    children.push(child);
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => {
      child.stdout.end();
      child.emit('close', 0);
      child.stopped = true;
    };
    createInterface({ input: child.stdin }).on('line', line => {
      const { id, method, params } = JSON.parse(line);
      methods.push(method);
      if (method === 'initialized') return;
      let response;
      if (method === 'initialize') response = { result: {} };
      else if (method === 'thread/queue/add') response = queueHandler(params);
      else if (method === 'thread/read') {
        assert.deepEqual(params, { threadId, includeTurns: false });
        response = pages.get('thread/read') ?? (queueHandler && { result: { thread: { id: threadId, cwd: __dirname } } });
      } else {
        assert.equal(method, 'thread/turns/list');
        assert.equal(params.threadId, threadId);
        assert.equal(params.itemsView, 'full');
        assert.equal(params.sortDirection, 'desc');
        response = pages.get(params.cursor);
      }
      if (response) child.stdout.write(JSON.stringify({ id, ...response }) + '\n');
    });
    return child;
  }
  return { methods, children, execute, queue: extra => queueMessage({ threadId, codexPath: 'codex.exe', execute, timeoutMs,
      workingDir: __dirname, prompt: 'a queued request', replyToken: token(12), ...extra }),
    cwd: () => readThreadCwd({ threadId, codexPath: 'codex.exe', execute, timeoutMs }),
    read: createReplyReader({ threadId, codexPath: 'codex.exe',
    workingDir: __dirname, execute, timeoutMs }) };
}

test('queue submission uses a persistent client ID distinct from the queue receipt and matches its final', async () => {
  const pages = new Map([[undefined, { result: { data: [
    turn('actual-turn', [{ ...user('a queued request'), clientId: token(12) }, answer('correct final')]),
    turn('unrelated-turn', [{ ...user('a queued request'), clientId: 'other-client' }, answer('unrelated final')]),
  ], nextCursor: null } }]]);
  const f = fixture(pages, 1000, false, params => {
    assert.deepEqual(params, { threadId, clientUserMessageId: token(12), input: [{ type: 'text', text: 'a queued request' }] });
    return { result: { queuedSubmission: { id: 'different-queue-receipt', clientUserMessageId: params.clientUserMessageId, input: params.input } } };
  });
  const submitted = await f.queue();
  assert.equal(submitted.state, 'accepted');
  assert.equal(submitted.queueId, 'different-queue-receipt');
  assert.equal(submitted.replyId, token(12));
  const result = await f.read(['client:' + submitted.replyId, 'client:' + submitted.queueId]);
  assert.deepEqual([...result], [['client:' + token(12), 'correct final']]);
  // A crash before saving the receipt can still recover via the persisted token.
  assert.equal((await f.read([token(12)])).get(token(12)), 'correct final');
  assert.ok(f.children.every(child => child.stopped));
});

test('ambiguous queue outcomes never retry a submission or claim a verified receipt', async () => {
  for (const response of [undefined, { error: { message: 'disconnected' } },
    { result: { queuedSubmission: { id: 'queue', clientUserMessageId: 'unexpected-client' } } }]) {
    const f = fixture(new Map(), 20, false, () => response);
    assert.deepEqual(await f.queue(), { state: 'uncertain', reason: 'queue_outcome_unknown' });
    assert.equal(f.methods.filter(method => method === 'thread/queue/add').length, 1);
    assert.ok(f.children.every(child => child.stopped));
  }
});

test('desktop queue refuses a mismatched working directory before submitting', async () => {
  const pages = new Map([['thread/read', { result: { thread: { id: threadId, cwd: path.dirname(__dirname) } } }]]);
  const f = fixture(pages, 1000, false, () => assert.fail('must not enqueue into another project'));
  const result = await f.queue({ onDetached: () => assert.fail('must not detach before validating target') });
  assert.deepEqual(result, { state: 'rejected', reason: 'desktop_working_dir_mismatch' });
  assert.deepEqual(f.methods, ['initialize', 'initialized', 'thread/read']);
});

test('cancelling a pending desktop lookup closes it before the RPC timeout and never submits', async () => {
  const controller = new AbortController();
  const pages = new Map();
  pages.get = () => { controller.abort('task_cancelled'); };
  const f = fixture(pages, 1000);
  const result = await Promise.race([f.queue({ signal: controller.signal }), delay(250, 'lookup stayed open', { ref: false })]);
  assert.deepEqual(result, { state: 'uncertain', reason: 'desktop_queue_cancelled' });
  assert.deepEqual(f.methods, ['initialize', 'initialized', 'thread/read']);
  assert.ok(f.children[0].stopped);
});

test('reads every cursor for the target, selects only completed explicit finals and exact bridge headers', async () => {
  const pages = new Map([
    [undefined, { result: { data: [
      turn('1', [user('来自企业微信：\r\n[wecom-request:' + token(1) + ']\r\n正文'),
        { ...answer('progress'), phase: 'commentary' }, answer('结果一')]),
      turn('2', [user('引用\n[wecom-request:' + token(2) + ']\n正文'), answer('unrelated')]),
      turn('3', [marked(3), answer('unfinished')], 'inProgress'),
      turn('4', [user('unrelated'), answer('[wecom-request:' + token(4) + ']')]),
    ], nextCursor: 'second' } }],
    ['second', { result: { data: [
      turn('5', [{ ...user(buildWecomPrompt('企微单聊 · 本人\n\n正文')), clientId: 'queue-5' }, answer('结果五')]),
      turn('6', [marked(6), user('manual steer'), answer('mixed')]),
      turn('7', [marked(7), { ...answer('intermediate'), phase: null }]),
      { ...turn('8', [marked(8)], 'failed'), completedAt: 100, error: { message: 'quota exhausted', codexErrorInfo: 'usageLimitExceeded' } },
      turn('9', [marked(9), answer('first'), answer('second')]),
    ], nextCursor: null } }],
  ]);
  const f = fixture(pages);
  const r = await f.read(Array.from({ length: 9 }, (_, i) => i === 4 ? 'client:queue-5' : token(i + 1)));
  assert.deepEqual([...r], [[token(1), '结果一'], ['client:queue-5', '结果五']]);
  assert.deepEqual([...r.unresolved], [[token(6), 'ambiguous_turn'], [token(7), 'ambiguous_turn'],
    [token(8), 'turn_failed'], [token(9), 'ambiguous_turn']]);
  assert.deepEqual(f.methods, ['initialize', 'initialized', 'thread/turns/list', 'thread/turns/list']);
  assert.equal(f.children[0].stopped, true);
});

test('keeps a desktop turn pending while a second process sees only an inferred interruption or failure', async () => {
  const pages = new Map();
  const f = fixture(pages);
  for (const status of ['interrupted', 'failed']) {
    pages.set(undefined, { result: { data: [turn('same', [marked(1)], status)], nextCursor: null } });
    const pending = await f.read([token(1)]);
    assert.equal(pending.has(token(1)), false);
    assert.equal(pending.unresolved.has(token(1)), false);
  }
  pages.set(undefined, { result: { data: [turn('same', [marked(1), answer('now completed')])], nextCursor: null } });
  assert.equal((await f.read([token(1)])).get(token(1)), 'now completed');
});

test('reports a recorded interruption for its exact queue client ID even without an error', async () => {
  const f = fixture(new Map([[undefined, { result: { data: [
    { ...turn('aborted', [{ ...user('queued work'), clientId: token(12) }], 'interrupted'), completedAt: 100, error: null },
  ], nextCursor: null } }]]));
  const result = await f.read(['client:' + token(12), 'client:' + token(13)]);
  assert.deepEqual([...result.unresolved], [['client:' + token(12), 'turn_interrupted']]);
  assert.deepEqual([...result.started], ['client:' + token(12)]);
});

test('resolves only the requested thread directory without a preset cwd or loading its turns', async () => {
  const known = path.resolve('example-project');
  const pages = new Map([['thread/read', { result: { thread: { id: threadId, cwd: known } } }]]);
  const f = fixture(pages, 1000, true);
  assert.equal(await f.cwd(), known);
  for (const thread of [{ id: threadId, cwd: 'relative' }, { id: 'different', cwd: known }]) {
    pages.set('thread/read', { result: { thread } });
    await assert.rejects(f.cwd(), thread.id === threadId ? /absolute directory/ : /thread ID/);
  }
  assert.equal(f.children.every(child => child.stopped), true);
});

test('Codex status shows the saved title or a short preview with only the last UUID segment', async () => {
  const pages = new Map();
  const f = fixture(pages, 1000, true);
  const backend = createCodexBackend({ codexPath: 'codex.exe', execute: f.execute });
  const target = { threadId, workingDir: __dirname };
  const snapshot = { target, sources: { thread: '.state', directory: '.state' }, last: { ...target, media: { total: 0 } } };
  const preview = '企微单聊 · 本人\n\n**正文**\n\n检查构建结果\n第二行\n\n**约定**\n- 一条例外';
  for (const [name, text, title] of [
    ['已命名的聊天', preview, '已命名的聊天'],
    [null, preview, '检查构建结果'],
    [null, '企微单聊 · 本人 **正文** 检查构建结果 &nbsp; **约定**（以正文为准，仅本次适用） • 一条例外', '检查构建结果'],
    ['', '企微单聊 · 本人\r\n\r\n查看构建日志\r\n\r\n本条适用的本人约定', '查看构建日志'],
    [null, '企微群聊 · 外部用户\n\n权限说明\n\n**正文**\n\n> 定位构建失败\n> 补充信息', '定位构建失败'],
    [null, '长'.repeat(81), '长'.repeat(80) + '…'],
    [null, '', '暂无标题'],
  ]) {
    pages.set('thread/read', { result: { thread: { id: threadId, name, preview: text } } });
    const lines = (await describeStatus(backend, snapshot)).split('\n');
    assert.equal(lines[0], '下一条消息 → ' + title + ' · …7547c8efc9c6（.state）');
    assert.equal(lines[2], '上一条任务 → ' + title + ' · …7547c8efc9c6');
    assert.equal(lines.length, 6);
  }
  pages.set('thread/read', { result: { thread: { id: threadId, name: null, preview } } });
  assert.equal(await chatTitle(backend, threadId), threadId);
  const groupStatus = await describeStatus(backend, snapshot, { allowPreview: false });
  assert.match(groupStatus, /暂无标题 · …7547c8efc9c6/);
  assert.doesNotMatch(groupStatus, /检查构建结果/);
});

test('withholds two terminal turns sharing a token and deduplicates repeated pages of the same turn', async () => {
  const t1 = turn('1', [marked(1), answer('a')]);
  const t2 = turn('2', [marked(2), answer('b')]);
  const f = fixture(new Map([
    [undefined, { result: { data: [t1, t2], nextCursor: 'p' } }],
    ['p', { result: { data: [t1, turn('3', [marked(2), answer('foreign use')])], nextCursor: null } }],
  ]));
  const r = await f.read([token(1), token(2)]);
  assert.deepEqual([...r], [[token(1), 'a']]);
  assert.deepEqual([...r.unresolved], [[token(2), 'ambiguous_turn']]);
});

test('empty reads skip startup and interrupted or invalid reads never publish partial results', async () => {
  const bad = fixture(new Map([
    [undefined, { result: { data: [turn('1', [marked(1), answer('partial')])], nextCursor: 'p' } }],
    ['p', { error: { code: -32600, message: 'failure' } }],
  ]));
  assert.equal((await bad.read([])).size, 0);
  assert.equal(bad.children.length, 0);
  await assert.rejects(bad.read([token(1)]), /request failed/);
  assert.equal(bad.children[0].stopped, true);
  const stalled = fixture(new Map(), 20);
  await assert.rejects(stalled.read([token(1)]), /timed out/);
  assert.equal(stalled.children[0].stopped, true);
});
