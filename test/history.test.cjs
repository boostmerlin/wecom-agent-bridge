'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createCommandStore } = require('../src/commands.cjs');

test('history records task targets by recency, resolves created threads and survives retirement and restart', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-history-'));
  let store = createCommandStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const route = { chatType: 'single', chatId: 'owner', senderId: 'owner' };
  const first = { queueKey: 'first', workingDir: dir, threadId: 'thread-1' };
  const pending = { queueKey: 'pending', workingDir: dir };
  const other = { queueKey: 'other', workingDir: path.join(dir, 'other'), threadId: 'thread-1' };
  for (const target of [first, pending, other]) store.track(target);
  assert.deepEqual(store.history(), [], 'opening queues is not task usage');
  store.recordTask(route, '1', first, []);
  store.recordTask(route, '2', pending, []);
  assert.equal(store.history()[0].threadId, null);
  store.track({ ...pending, threadId: 'thread-2' });
  store.recordTask(route, '3', other, []);
  store.recordTask(route, '4', first, []);
  for (const target of [first, pending, other]) store.untrack(target.queueKey);
  store.close();
  store = createCommandStore(dir);
  assert.deepEqual(store.history().map(r => [r.threadId, r.workingDir]), [
    ['thread-1', dir], ['thread-1', other.workingDir], ['thread-2', dir],
  ]);
  assert.equal(store.history(2).length, 2);
  const duplicate = { ...first, queueKey: 'new-queue' };
  store.track(duplicate);
  store.recordTask(route, '5', duplicate, []);
  assert.equal(store.history().length, 3, 'same thread and directory appear once');
  assert.equal(store.history()[0].queueKey, 'new-queue');
});

test('history seeds the last task retained by old versions without changing later recency', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-history-old-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, 'commands.sqlite'));
  db.exec('CREATE TABLE last_tasks (chat TEXT PRIMARY KEY, msg_id TEXT NOT NULL, target TEXT NOT NULL, media TEXT NOT NULL)');
  db.prepare('INSERT INTO last_tasks VALUES(?,?,?,?)').run('old-chat', 'old-message',
    JSON.stringify({ queueKey: 'old', workingDir: dir, threadId: 'old-thread' }), '[]');
  db.close();
  const store = createCommandStore(dir);
  try { assert.equal(store.history()[0].threadId, 'old-thread'); }
  finally { store.close(); }
});
