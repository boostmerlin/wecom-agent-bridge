'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { EventEmitter, once } = require('node:events');
const { buildWecomPrompt, createDelivery } = require('../src/delivery.cjs');

const { createCodexBackend } = require('../src/backends/codex.cjs');

const threadId = '01234567-89ab-49ab-8567-0123456789ab';
const workingDir = 'D:\\project with space\\测试';
const completed = [
  { type: 'thread.started', thread_id: threadId },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: '模拟回复' } },
  { type: 'turn.completed' },
];

function fixture(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'wecom-delivery-'));
  const deliveries = [];
  t.after(async () => {
    await Promise.all(deliveries.map((delivery) => delivery.close()));
    rmSync(stateDir, { recursive: true, force: true });
  });
  return {
    stateDir,
    open(options = {}) {
      const events = new EventEmitter();
      const log = [];
      const delivery = createDelivery({
        backend: createCodexBackend({ codexPath: 'fake-codex',
          wakeDesktop() { throw new Error('Desktop wake requires a test stub'); }, ...options }),
        workingDir, threadId, stateDir, ...options,
        log(event, details) { log.push({ event, details }); events.emit(event, details); },
      });
      deliveries.push(delivery);
      return { delivery, log, event: (name) => once(events, name, { signal: AbortSignal.timeout(8_000) }) };
    },
  };
}

// Real child processes exercise Windows argument handling, UTF-8 stdin, and JSONL event streaming.
function fakeCli(scenario) {
  const childProgram = `
    const expected = JSON.parse(process.env.FAKE_DELIVERY);
    if (JSON.stringify(process.argv.slice(1)) !== JSON.stringify(expected.args)) process.exit(21);
    process.stdin.setEncoding('utf8');
    let body = '';
    process.stdin.on('data', (chunk) => { body += chunk; });
    process.stdin.on('end', () => {
      if (body !== expected.body || 'WECOM_BOT_SECRET' in process.env) process.exit(22);
      for (const event of expected.events) process.stdout.write(JSON.stringify(event) + '\\n');
      if (expected.diagnostic) process.stderr.write(expected.diagnostic + '\\n');
      process.exitCode = expected.exit || 0;
    });
  `;
  return (path, args, options) => {
    assert.equal(path, 'fake-codex');
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    const expected = scenario();
    const fake = { ...expected, args: ['exec', '-C', workingDir, 'resume', '--json', threadId, '-'],
      body: buildWecomPrompt(expected.text) };
    return spawn(process.execPath, ['-e', childProgram, '--', ...args], {
      ...options, env: { ...options.env, FAKE_DELIVERY: JSON.stringify(fake) },
    });
  };
}

test('writes UTF-8 via stdin, serializes turns, and deduplicates across restarts', async (t) => {
  const f = fixture(t);
  const oldSecret = process.env.WECOM_BOT_SECRET;
  process.env.WECOM_BOT_SECRET = 'test-secret-should-stay-in-parent';
  t.after(() => { if (oldSecret === undefined) delete process.env.WECOM_BOT_SECRET; else process.env.WECOM_BOT_SECRET = oldSecret; });
  const messages = ['你好 😀\r\n `%USERNAME% ! & | < > " \\ $()', '第二条'];
  let calls = 0, active = 0, maxActive = 0;
  const fake = fakeCli(() => ({ text: messages[calls++], events: completed }));
  const p = f.open({ execute(...args) {
    const child = fake(...args);
    maxActive = Math.max(maxActive, ++active);
    child.once('close', () => { active--; });
    return child;
  } });
  const first = p.event('delivery_completed');
  assert.equal(p.delivery.enqueue('m1', messages[0]), true);
  assert.equal(p.delivery.enqueue('m1', 'duplicate replacement'), false);
  assert.equal(p.delivery.enqueue('m2', messages[1]), true);
  assert.deepEqual(p.log.map((row) => row.event), ['delivery_queued', 'delivery_queued']);
  await first;
  await p.event('delivery_completed');
  await p.delivery.close();
  assert.equal(maxActive, 1);
  assert.equal(calls, 2);
  assert.deepEqual(p.log.map((row) => row.event), ['delivery_queued', 'delivery_queued',
    'delivery_submitted', 'delivery_completed', 'delivery_submitted', 'delivery_completed']);
  const logs = JSON.stringify(p.log);
  for (const privateText of [...messages, '模拟回复', 'test-secret-should-stay-in-parent']) assert.ok(!logs.includes(privateText));
  const second = f.open({ execute: fake });
  assert.equal(second.delivery.enqueue('m1', messages[0]), false);
  await second.delivery.close();
  assert.equal(calls, 2);
});

test('an executable that is missing defers safely and the next start recovers the pending row', async (t) => {
  const f = fixture(t);
  const p = f.open({ codexPath: join(f.stateDir, 'no-such-cli.exe') });
  const deferred = p.event('delivery_deferred');
  p.delivery.enqueue('missing', '恢复后投递');
  assert.equal((await deferred)[0].reason, 'ENOENT');
  await p.delivery.close();
  const second = f.open({ execute: fakeCli(() => ({ text: '恢复后投递', events: completed })) });
  assert.equal(second.delivery.enqueue('missing', 'do not replace'), false);
  await second.event('delivery_completed');
});

test('wrong thread, absent reply, and nonzero exit after a reply are never replayed', async (t) => {
  const f = fixture(t);
  const cases = [
    { text: 'one', events: [{ type: 'thread.started', thread_id: 'other-thread' }, ...completed.slice(1)] },
    { text: 'two', events: completed.filter((e) => e.type !== 'item.completed') },
    { text: 'three', events: completed, exit: 12 },
    { text: 'four', events: completed.slice(0, 2), exit: 1, diagnostic: 'thread/resume failed: thread ' + threadId + ' already has an active writer' },
    { text: 'five', events: [], exit: 1, diagnostic: 'thread/resume failed: thread another already has an active writer' },
    { text: 'six', events: [], exit: 1, diagnostic: 'unknown error' },
  ];
  let calls = 0;
  const execute = fakeCli(() => cases[calls++]);
  const p = f.open({ execute });
  for (const row of cases) {
    const uncertain = p.event('delivery_uncertain');
    assert.equal(p.delivery.enqueue(row.text, row.text), true);
    assert.ok((await uncertain)[0].reason);
  }
  await p.delivery.close();
  const second = f.open({ execute });
  for (const row of cases) assert.equal(second.delivery.enqueue(row.text, row.text), false);
  await second.delivery.close();
  assert.equal(calls, cases.length);
  assert.ok(!p.log.some((row) => row.event === 'delivery_completed'));
});

test('an active writer before any events falls back once, retaining the queue receipt and clearing the body', async (t) => {
  const f = fixture(t);
  const dbPath = join(f.stateDir, 'delivery-' + createHash('sha256').update(threadId).digest('hex') + '.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, msg_id TEXT UNIQUE, body TEXT,
    state TEXT CHECK(state IN ('queued','submitting','completed','uncertain','rejected')));
    CREATE INDEX by_state ON messages (state,id);
    INSERT INTO messages VALUES (1,'done',NULL,'completed');`);
  old.close();
  const text = '排队 😀 " & | %USERNAME%\n第二行';
  const diagnostic = 'Error: thread/resume failed: thread ' + threadId + ' already has an active writer';
  const firstCli = fakeCli(() => ({ text, events: [], exit: 1, diagnostic }));
  const calls = [];
  const oldSecret = process.env.WECOM_BOT_SECRET;
  process.env.WECOM_BOT_SECRET = 'no-secret-in-fallback';
  t.after(() => { if (oldSecret === undefined) delete process.env.WECOM_BOT_SECRET; else process.env.WECOM_BOT_SECRET = oldSecret; });
  function execute(path, args, options) {
    calls.push(args[0]);
    if (args[0] === 'exec') return firstCli(path, args, options);
    assert.equal(path, 'fake-codex');
    assert.equal(options.shell, false);
    assert.deepEqual(args, ['queue', '--thread', threadId, '--message', buildWecomPrompt(text), '--resume']);
    const fakeQueue = `
      if ('WECOM_BOT_SECRET' in process.env || process.argv[5] !== process.env.FAKE_BODY) process.exit(25);
      if (process.env.FAKE_WARN === '1') process.stderr.write('warning: queued message, could not resume local daemon\\n');
    `;
    return spawn(process.execPath, ['-e', fakeQueue, '--', ...args], {
      ...options, env: { ...options.env, FAKE_BODY: buildWecomPrompt(text),
        FAKE_WARN: calls.filter((command) => command === 'queue').length < 3 ? '1' : '0' },
    });
  }
  const wakeCalls = [];
  const p = f.open({ execute, wakeDesktop(...args) {
    wakeCalls.push(args);
    if (wakeCalls.length === 2) throw new Error('simulated protocol failure');
  } });
  assert.equal(p.delivery.enqueue('done', 'already completed'), false);
  const receipt = p.event('delivery_queued_in_codex');
  const wakeNotice = p.event('desktop_wake_requested');
  p.delivery.enqueue('queued', text);
  assert.equal((await receipt)[0].wakeConfirmed, false);
  await wakeNotice;
  const failedWake = p.event('desktop_wake_failed');
  p.delivery.enqueue('queued-with-wake-failure', text);
  assert.equal((await failedWake)[0].reason, 'protocol_request_failed');
  const noWarning = p.event('delivery_queued_in_codex');
  p.delivery.enqueue('queued-without-warning', text);
  assert.equal((await noWarning)[0].wakeConfirmed, undefined);
  assert.ok(!p.log.some(({ event }) => event === 'delivery_completed'));
  await p.delivery.close();
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT body,state FROM messages WHERE msg_id = 'queued'").get();
  db.close();
  assert.equal(row.state, 'queued_in_codex');
  assert.equal(row.body, null);
  const second = f.open({ execute });
  assert.equal(second.delivery.enqueue('queued', 'redelivery'), false);
  assert.equal(second.delivery.enqueue('queued-with-wake-failure', 'redelivery'), false);
  await second.delivery.close();
  assert.deepEqual(wakeCalls, [[threadId], [threadId]]);
  assert.deepEqual(calls, ['exec', 'queue', 'exec', 'queue', 'exec', 'queue']);
});

test('a crashed in-flight worker is quarantined; a different thread has its own deduplication scope', async (t) => {
  const f = fixture(t);
  const modulePath = require.resolve('../src/delivery.cjs');
  const script = `
    const { createDelivery } = require(process.argv[1]);
    const config = JSON.parse(process.argv[2]);
    const { createCodexBackend } = require(process.argv[3]);
    const backend = createCodexBackend({ ...config, execute() { process.exit(42); } });
    const delivery = createDelivery({ ...config, backend });
    delivery.enqueue('interrupted', 'test');
  `;
  const child = spawnSync(process.execPath, ['-e', script, '--', modulePath,
    JSON.stringify({ codexPath: 'fake-codex', workingDir, threadId, stateDir: f.stateDir }), require.resolve('../src/backends/codex.cjs')], { shell: false, windowsHide: true });
  assert.equal(child.status, 42);
  const second = f.open({ execute() { throw new Error('interrupted message must not be retried'); } });
  assert.ok(second.log.some(({ event, details }) => event === 'delivery_uncertain' && details.reason === 'interrupted_submission'));
  assert.equal(second.delivery.enqueue('interrupted', 'duplicate'), false);
  assert.throws(() => f.open(), /database is locked/);
  const other = f.open({ threadId: 'other-thread' });
  assert.equal(other.delivery.enqueue('interrupted', 'independent'), true);
  await other.delivery.close();
});

test('correlates the group turn queued in Codex, sends only its concise final, and ignores redelivery', async t => {
  const f = fixture(t);
  const route = { chatType: 'group', chatId: 'group-A', senderId: 'member' };
  let marker, prompt;
  const sent = [];
  const p = f.open({
    execute(_exe, args, options) {
      if (args[0] === 'exec') {
        const program = 'process.stdin.resume();process.stdin.on("end",()=>{console.error("thread/resume failed: thread ' + threadId + ' already has an active writer");process.exitCode=1})';
        return spawn(process.execPath, ['-e', program], options);
      }
      assert.equal(args[0], 'queue');
      prompt = args[args.indexOf('--message') + 1];
      const queueId = '01234567-89ab-4def-8123-012345678901';
      marker = 'client:' + queueId;
      return spawn(process.execPath, ['-e', 'console.log(' + JSON.stringify('Queued message ' + queueId + ' for thread ' + threadId + '.') + ')'], options);
    },
    async readReplies(tokens) {
      assert.ok(tokens.includes(marker));
      return new Map([[marker, '核心结论']]);
    },
    async sendReply(origin, text) { sent.push([origin, text]); return { success: true }; },
  });
  const done = p.event('reply_sent');
  // Keep the process alive while awaiting the background reader in this socket-free fixture.
  const hold = setTimeout(() => {}, 9000);
  t.after(() => clearTimeout(hold));
  p.delivery.enqueue('ws-id', '请总结', 'group', route, 'wecom-test-id');
  await done;
  assert.match(prompt, /一至三句话/);
  assert.match(prompt, /先完成正文要求的任务/);
  assert.match(prompt, /正文指定了回复内容或格式，按其要求作答/);
  assert.match(prompt, /桥接会将最终答复发回原企微会话，请勿自行发送这条答复/);
  assert.doesNotMatch(prompt, /wecom-request/);
  assert.ok(prompt.startsWith('请总结\n\n'));
  assert.deepEqual(sent, [[route, '核心结论']]);
  assert.equal(p.delivery.taskState('ws-id', route).delivery, 'completed');
  for (const { details } of p.log.filter(row => row.details?.entry === 1)) {
    assert.match(details.requestId, /^[a-f0-9]{32}$/);
    assert.equal(details.senderId, route.senderId);
    assert.equal(details.wecomRequestId, 'wecom-test-id');
  }
  assert.equal(p.delivery.enqueue('ws-id', '重复', 'group', route), false);
  assert.ok(!JSON.stringify(p.log).includes('核心结论'));
});

test('direct execution sends the final output file to the original conversation', async t => {
  const f = fixture(t);
  const route = { chatType: 'single', chatId: 'owner', senderId: 'owner' };
  const sent = [];
  const p = f.open({
    execute(_exe, args, options) {
      const at = args.indexOf('--output-last-message');
      assert.ok(at > 0);
      const program = 'process.stdin.resume();process.stdin.on("end",()=>{' +
        'require("node:fs").writeFileSync(process.argv[1],"最终结果");' +
        'for(const event of ' + JSON.stringify(completed) + ')console.log(JSON.stringify(event))})';
      return spawn(process.execPath, ['-e', program, args[at + 1]], options);
    },
    async readReplies() { throw new Error('Unexpected history read'); },
    async sendReply(origin, text) { sent.push([origin, text]); },
  });
  const done = p.event('reply_sent');
  p.delivery.enqueue('direct-id', '执行任务', 'single', route);
  await done;
  assert.deepEqual(sent, [[route, '最终结果']]);
});

test('fresh inbox creates one thread and resumes it across messages and a restart', async t => {
  const f = fixture(t);
  const queueKey = '12345678-1234-4123-8123-123456789abc';
  const calls = [], created = [];
  const opts = {
    threadId: undefined, queueKey, onCreated: id => created.push(id),
    execute(_exe, args, options) {
      calls.push(args);
      const script = 'process.stdin.resume();process.stdin.on("end",()=>{' +
        'for(const e of ' + JSON.stringify(completed) + ') console.log(JSON.stringify(e))})';
      return spawn(process.execPath, ['-e', script], options);
    },
  };
  const first = f.open(opts);
  for (const id of ['a', 'b']) {
    const done = first.event('delivery_completed');
    first.delivery.enqueue(id, id);
    await done;
  }
  assert.deepEqual(created, [threadId]);
  await first.delivery.close();
  const second = f.open({ ...opts, threadId });
  assert.equal(second.delivery.enqueue('a', 'duplicate'), false);
  const done = second.event('delivery_completed');
  second.delivery.enqueue('c', 'c');
  await done;
  assert.equal(calls[0].includes('resume'), false);
  for (const args of calls.slice(1)) {
    assert.ok(args.includes('resume'));
    assert.ok(args.includes(threadId));
  }
});

test('local command acknowledgement uses the reply outbox without creating a Codex turn', async t => {
  const f = fixture(t);
  const route = { chatType: 'group', chatId: 'original', senderId: 'owner' };
  const sent = [];
  const p = f.open({
    execute() { assert.fail('Command was sent to Codex'); },
    async readReplies() { assert.fail('Command requested a Codex answer'); },
    async sendReply(origin, text) { sent.push([origin, text]); },
  });
  const done = p.event('reply_sent');
  assert.equal(p.delivery.enqueue('cmd-id', '已记住 #1', 'group', route, 'req-1', 'owner', true), true);
  await done;
  assert.deepEqual(sent, [[route, '已记住 #1']]);
  assert.equal(p.delivery.enqueue('cmd-id', '已记住 #1', 'group', route, 'req-1', 'owner', true), false);
});

test('manual retry resumes unsent reply chunks once and never resubmits a completed turn', async t => {
  const f = fixture(t);
  const route = { chatType: 'group', chatId: 'group-A', senderId: 'owner' };
  let turns = 0, attempts = 0;
  const sent = [];
  const backend = { submit: async () => { turns++; return { state: 'completed', text: 'a'.repeat(6144) + 'tail' }; } };
  const p = f.open({ backend, sendReply: async (origin, text) => {
    assert.deepEqual(origin, route);
    if (++attempts === 2) throw Object.assign(new Error('rejected'), { definitelyUnsent: true });
    sent.push(text);
  } });
  const failed = p.event('reply_failed');
  p.delivery.enqueue('task', 'do once', 'group', route);
  await failed;
  assert.equal(p.delivery.taskState('task', route).part, 1);
  assert.match(p.delivery.retryTask('wrong-chat', 'task', { ...route, chatId: 'other' }), /没有可安全重试/);
  const delivered = p.event('reply_sent');
  const answer = p.delivery.retryTask('retry', 'task', route);
  assert.match(answer, /未发出的分段/);
  await delivered;
  assert.equal(p.delivery.retryTask('retry', 'task', route), answer);
  assert.match(p.delivery.retryTask('next', 'task', route), /没有可安全重试/);
  assert.equal(turns, 1);
  assert.deepEqual(sent, ['a'.repeat(6144), 'tail']);
});

test('only a rejected submission can be manually executed again', async t => {
  const f = fixture(t);
  const route = { chatType: 'single', chatId: 'me', senderId: 'me' };
  let submissions = 0;
  const p = f.open({ backend: { submit: async () => ({ state: ++submissions === 1 ? 'rejected' : 'uncertain' }) },
    sendReply: async () => assert.fail('No final') });
  const rejected = p.event('delivery_rejected');
  p.delivery.enqueue('task', 'run', 'single', route);
  await rejected;
  const uncertain = p.event('delivery_uncertain');
  assert.match(p.delivery.retryTask('retry-1', 'task', route), /投递此前被拒绝/);
  await uncertain;
  assert.match(p.delivery.retryTask('retry-2', 'task', route), /没有可安全重试/);
  assert.equal(submissions, 2);
});

test('progress storage failures leave the turn and its final reply intact', async t => {
  const f = fixture(t);
  const route = { chatType: 'single', chatId: 'me', senderId: 'me' };
  const sent = [];
  const backend = { async submit({ onStarted }) {
    onStarted();
    return { state: 'completed', text: 'done' };
  } };
  const p = f.open({ backend, sendReply: async (_, text) => sent.push(text) });
  const key = createHash('sha256').update(threadId).digest('hex');
  const db = new DatabaseSync(join(f.stateDir, 'delivery-' + key + '.sqlite'));
  try {
    db.exec("CREATE TRIGGER fail_progress BEFORE INSERT ON bridge_progress BEGIN SELECT RAISE(FAIL, 'progress write failed'); END");
  } finally { db.close(); }
  const done = p.event('delivery_completed');
  const replied = p.event('reply_sent');
  p.delivery.enqueue('progress-error', 'test', 'single', route);
  await Promise.all([done, replied]);
  assert.deepEqual(sent, ['done']);
  assert.ok(p.log.some(row => row.event === 'progress_failed'));
});
