'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const { createReplies } = require('../src/replies.cjs');

const direct = { chatType: 'single', chatId: 'test-sender', senderId: 'test-sender' };
const group = { chatType: 'group', chatId: 'test-room', senderId: 'test-other' };
async function until(predicate) {
  const timeout = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > timeout) assert.fail('Timed out waiting for the fixture');
    await delay(5);
  }
}
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY)');
  const controllers = [];
  t.after(async () => { for (const controller of controllers) await controller.close(); db.close(); });
  const events = [];
  function open(options = {}) {
    const ctrl = createReplies({ db, readReplies: async () => new Map(), sendReply: async () => {},
      log: (event, data) => events.push({ event, ...data }), pollMs: 8, maxPollMs: 32, retryBaseMs: 20, ...options });
    controllers.push(ctrl);
    return ctrl;
  }
  function add(ctrl, id, route = direct) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO messages(id) VALUES(?)').run(id);
      const token = ctrl.register(id, route);
      db.exec('COMMIT');
      return token;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return { db, events, open, add };
}

test('route and random token commit atomically with inbound insertion; historic entries never acquire replies', async t => {
  const { db, events, open, add } = fixture(t);
  let reads = 0;
  const ctrl = open({ readReplies: async () => { reads++; return new Map(); } });
  db.exec('INSERT INTO messages VALUES(77)');
  assert.equal(ctrl.tokenFor(77), null);
  assert.equal(ctrl.start(77), false);
  assert.equal(ctrl.ready(77, 'historic reply'), false);
  assert.throws(() => ctrl.register(77, direct), /transaction/);
  db.exec('BEGIN; INSERT INTO messages VALUES(1)');
  const reverted = ctrl.register(1, direct);
  db.exec('ROLLBACK');
  assert.equal(ctrl.tokenFor(1), null);
  const committed = add(ctrl, 1);
  assert.match(committed, /^[a-f0-9]{32}$/);
  assert.notEqual(committed, reverted);
  db.exec('BEGIN');
  assert.equal(ctrl.register(1, direct), committed);
  assert.throws(() => ctrl.register(1, group), /immutable/);
  db.exec('ROLLBACK');
  assert.throws(() => add(ctrl, 2, { ...direct, chatId: 'other-person' }), /route/);
  assert.equal(ctrl.tokenFor(2), null);
  await delay(40);
  assert.equal(reads, 0);
  assert.deepEqual(events, []);
});

test('long Markdown keeps emoji and combining text intact, routes stay distinct, duplicate results cannot resend', async t => {
  const { events, open, add } = fixture(t);
  const sent = [];
  const ctrl = open({ sendReply: async (route, text) => { sent.push({ route, text }); } });
  add(ctrl, 1, direct); add(ctrl, 2, group);
  const grapheme = '👩‍🔬';
  const message = 'x'.repeat(6140) + grapheme.repeat(1200) + '中文e\u0301\n尾';
  assert.equal(ctrl.ready(1, message), true);
  assert.equal(ctrl.ready(1, 'wrong overwrite'), false);
  ctrl.ready(2, 'group response');
  await until(() => events.filter(e => e.event === 'reply_sent').length === 2);
  const directChunks = sent.filter(item => item.route.chatType === 'single');
  assert.ok(directChunks.length > 1);
  assert.equal(directChunks.map(item => item.text).join(''), message);
  assert.equal(directChunks[0].text, 'x'.repeat(6140));
  for (const item of directChunks) {
    assert.deepEqual(item.route, direct);
    assert.ok(item.text.isWellFormed() && Buffer.byteLength(item.text) <= 6144);
  }
  assert.deepEqual(sent.at(-1), { route: group, text: 'group response' });
  assert.equal(ctrl.ready(1, message), false);
  assert.ok(!JSON.stringify(events).includes('group response'));
});

test('desktop reader batches matching tokens, releases failures, and expires only the ordering hold', async t => {
  const { events, open, add } = fixture(t);
  const batches = [], deliveries = [], released = [];
  let a, b, c, d, lateReady = false;
  const ctrl = open({ turnHoldMs: 45, onTurnResolved: (entry, reason) => released.push([entry, reason]),
    readReplies: async tokens => {
      batches.push(tokens);
      const results = new Map([[a, 'A'], ['unknown-token', 'must not forward']]);
      results.unresolved = new Map([[b, 'ambiguous_turn'], [c, 'turn_failed']]);
      if (lateReady) results.set(d, 'late');
      return results;
    }, sendReply: async (route, text) => deliveries.push(text) });
  a = add(ctrl, 1); b = add(ctrl, 2); c = add(ctrl, 3); d = add(ctrl, 4);
  ctrl.start(1);
  ctrl.start(2, { blocking: false });
  ctrl.start(3);
  ctrl.start(4);
  assert.equal(ctrl.hasPendingTurn(), true);
  await until(() => released.some(([id, reason]) => id === 4 && reason === 'hold_expired'));
  assert.equal(ctrl.hasPendingTurn(), false);
  assert.deepEqual(batches[0], [a, b, c, d]);
  assert.ok(released.some(([id, reason]) => id === 2 && reason === 'ambiguous_turn'));
  assert.ok(released.some(([id, reason]) => id === 3 && reason === 'turn_failed'));
  lateReady = true;
  await until(() => events.filter(e => e.event === 'reply_sent').length === 4);
  assert.equal(deliveries[0], 'A');
  assert.match(deliveries[1], /任务可能已开始/);
  assert.match(deliveries[2], /任务失败/);
  assert.equal(deliveries[3], 'late');
});

test('a confirmed interruption releases the delivery hold and replies to the original conversation', async t => {
  const { open, add } = fixture(t);
  const released = [], sent = [];
  let token;
  const ctrl = open({
    onTurnResolved: (entry, reason) => released.push([entry, reason]),
    readReplies: async () => Object.assign(new Map(), { unresolved: new Map([[token, 'turn_interrupted']]) }),
    sendReply: async (route, text) => sent.push({ route, text }),
  });
  token = add(ctrl, 1, group);
  ctrl.start(1);
  assert.equal(ctrl.hasPendingTurn(), true);
  await until(() => sent.length === 1);
  assert.equal(ctrl.hasPendingTurn(), false);
  assert.deepEqual(released, [[1, 'turn_interrupted']]);
  assert.deepEqual(sent[0].route, group);
  assert.match(sent[0].text, /Codex.*中断/);
});

test('a confirmed temporary failure resumes from the unsent part on restart, with persisted backoff', async t => {
  const { events, open, add } = fixture(t);
  const attempts = [];
  const options = { chunkBytes: 4, retryBaseMs: 100, sendReply: async (_route, text) => {
    attempts.push({ text, time: Date.now() });
    if (attempts.length === 2) throw Object.assign(Error('transport diagnostic'), { definitelyUnsent: true, temporary: true });
  } };
  const first = open(options);
  add(first, 1);
  first.ready(1, 'AAAABBBBCCCC');
  await until(() => events.some(e => e.event === 'reply_deferred'));
  await first.close();
  open(options);
  await until(() => events.some(e => e.event === 'reply_sent'));
  assert.deepEqual(attempts.map(a => a.text), ['AAAA', 'BBBB', 'BBBB', 'CCCC']);
  assert.ok(attempts[2].time >= attempts[1].time + 100);
});

test('permanent rejection, ambiguous response and interrupted send cannot replay or send later parts', async t => {
  const { db, events, open, add } = fixture(t);
  const calls = [];
  const options = { chunkBytes: 4, sendReply: async (_route, text) => {
    calls.push(text);
    if (text === '1111') throw Object.assign(Error('do not log this'), { definitelyUnsent: true, temporary: false });
    throw Error('may have been sent');
  } };
  const first = open(options);
  for (let id = 1; id <= 3; id++) { add(first, id); first.ready(id, String(id).repeat(8)); }
  // Durable state left by a process killed after reserving a part.
  db.exec("UPDATE bridge_replies SET state='sending' WHERE entry=3");
  await until(() => events.some(e => e.event === 'reply_uncertain' && e.entry === 2));
  await first.close();
  const second = open(options);
  await delay(40);
  assert.deepEqual(calls, ['1111', '2222']);
  assert.ok(events.some(e => e.event === 'reply_failed' && e.entry === 1));
  assert.ok(events.some(e => e.event === 'reply_uncertain' && e.entry === 3 && e.reason === 'interrupted_send'));
  assert.equal(second.ready(3, 'resend'), false);
});

test('an unmapped route has a bounded number of attempts and only known diagnostic fields enter logs', async t => {
  const { open, events, add } = fixture(t);
  let calls = 0;
  const first = open({ retryBaseMs: 8, sendReply: async () => {
    calls++;
    throw Object.assign(Error('sensitive adapter detail'), {
      code: 'REPLY_ROUTE_UNMAPPED', businessCode: 851008, definitelyUnsent: true, temporary: true,
    });
  } });
  add(first, 1, group);
  first.ready(1, 'private reply');
  await until(() => events.some(e => e.event === 'reply_failed'));
  assert.equal(calls, 3);
  assert.equal(events.filter(e => e.event === 'reply_deferred').length, 2);
  const result = events.find(e => e.event === 'reply_failed');
  assert.equal(result.reason, 'route_unmapped');
  assert.equal(result.code, 'REPLY_ROUTE_UNMAPPED');
  assert.equal(result.businessCode, 851008);
  assert.doesNotMatch(JSON.stringify(events), /private reply|sensitive adapter detail/);
  await first.close();
  open({ sendReply: async () => { calls++; } });
  await delay(30);
  assert.equal(calls, 3);
});

test('upgrade rechecks legacy match failures once, without reopening sent, rejected or uncertain sends', async t => {
  const { db, events, open } = fixture(t);
  // Legacy schema: a failure before a final was staged has zero parts; a send
  // rejection or partial delivery always has a positive total.
  db.exec(`CREATE TABLE bridge_replies (
    entry INTEGER PRIMARY KEY REFERENCES messages(id), token TEXT UNIQUE NOT NULL, chat_type TEXT NOT NULL,
    chat_id TEXT NOT NULL, sender_id TEXT NOT NULL, state TEXT NOT NULL, block_until INTEGER,
    part INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0);`);
  const oldStates = [
    ['failed', 0, 0], ['failed', 0, 0], ['failed', 0, 1], ['sent', 1, 1],
    ['uncertain', 0, 1], ['sending', 0, 1], ['failed', 1, 2], ['registered', 0, 0],
  ];
  const tokens = oldStates.map((_, i) => String(i + 1).padStart(32, '0'));
  const insert = db.prepare("INSERT INTO bridge_replies(entry,token,chat_type,chat_id,sender_id,state,part,total) VALUES(?,?,'group',?,?, ?,?,?)");
  for (const [i, row] of oldStates.entries()) {
    db.prepare('INSERT INTO messages VALUES(?)').run(i + 1);
    insert.run(i + 1, tokens[i], group.chatId, group.senderId, ...row);
  }
  const reads = [], sent = [];
  const opts = {
    readReplies: async batch => {
      reads.push(batch);
      const finals = new Map([[tokens[0], 'verified fixture final']]);
      finals.unresolved = new Map([[tokens[1], 'turn_failed']]);
      return finals;
    }, sendReply: async (route, text) => sent.push({ route, text }),
  };
  const upgraded = open(opts);
  assert.equal(upgraded.hasPendingTurn(), false);
  const waiting = db.prepare("SELECT entry,block_until FROM bridge_replies WHERE state='waiting' ORDER BY entry").all();
  assert.deepEqual(waiting.map(row => [row.entry, row.block_until]), [[1, null], [2, null]]);
  await until(() => events.some(e => e.entry === 2 && e.event === 'reply_sent'));
  await upgraded.close();
  const restarted = open(opts);
  await delay(40);
  await restarted.close();
  assert.deepEqual(reads, [tokens.slice(0, 2)]);
  assert.deepEqual(sent[0], { route: group, text: 'verified fixture final' });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].route, group);
  assert.match(sent[1].text, /任务失败/);
  const states = db.prepare('SELECT state FROM bridge_replies ORDER BY entry').all().map(row => row.state);
  assert.deepEqual(states, ['sent', 'sent', 'failed', 'sent', 'uncertain', 'uncertain', 'failed', 'registered']);
});

test('failure notices survive restart and cannot be staged or sent twice', async t => {
  const { open, add, events, db } = fixture(t);
  const sent = [];
  const options = { sendReply: async (route, text) => sent.push({ route, text }) };
  const first = open(options);
  const token = add(first, 1, group);
  assert.equal(first.unmatched(1), true);
  assert.equal(first.unmatched(1), false);
  await first.close();
  assert.equal(sent.length, 0);
  const second = open(options);
  await until(() => events.some(e => e.entry === 1 && e.event === 'reply_sent'));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].route, group);
  assert.ok(sent[0].text.includes(token));
  assert.equal(second.ready(1, 'unrelated final'), false);
  assert.equal(db.prepare('SELECT failure_reason FROM bridge_replies WHERE entry=1').get().failure_reason, 'missing_backend_receipt');
  await second.close();
  const third = open(options);
  await delay(20);
  await third.close();
  assert.equal(sent.length, 1);
});

test('progress deadline checks for a final even when history polling is backed off', async t => {
  const { open, add, events } = fixture(t);
  const sent = [];
  let token, reads = 0;
  const ctrl = open({ pollMs: 1000, maxPollMs: 2000, progressAfterMs: 20,
    readReplies: async () => ++reads === 1 ? new Map() : new Map([[token, 'finished already']]),
    sendReply: async (_, text) => sent.push(text) });
  token = add(ctrl, 1, direct);
  ctrl.trackProgress(1, false);
  ctrl.start(1);
  await until(() => events.some(e => e.event === 'reply_sent'));
  assert.deepEqual(sent, ['finished already']);
  assert.equal(events.some(e => e.event === 'progress_sent'), false);
});

test('long tasks receive a single progress notice across restart, fast tasks only their final', async t => {
  const { open, add } = fixture(t);
  const sent = [];
  const options = { progressAfterMs: 15, sendReply: async (route, text) => sent.push([route, text]),
    progressText: async () => '已投递到 Alpha' };
  const first = open(options);
  add(first, 1, group);
  first.trackProgress(1, false);
  first.start(1);
  await until(() => sent.length === 1);
  await first.close();
  const second = open(options);
  second.trackProgress(1, true);
  add(second, 2, direct);
  second.trackProgress(2, true);
  second.ready(2, '快速答复');
  await delay(50);
  second.ready(1, '长任务答复');
  await until(() => sent.length >= 3);
  assert.deepEqual(sent, [[group, '已投递到 Alpha'], [direct, '快速答复'], [group, '长任务答复']]);
});
