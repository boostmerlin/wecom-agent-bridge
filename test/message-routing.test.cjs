'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createMessageRouting } = require('../src/message-routing.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-routing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function legacy(backend, rows) {
    const file = path.join(root, backend + '.sqlite');
    const db = new DatabaseSync(file);
    try {
      db.exec('CREATE TABLE received (id TEXT PRIMARY KEY, queue_key TEXT, done INTEGER DEFAULT 0)');
      for (const [id, done] of rows) db.prepare('INSERT INTO received VALUES(?,?,?)').run(id, 'original-queue', done);
    } finally { db.close(); }
    return { backend, file };
  }
  return { root, directory: path.join(root, 'routing'), legacy };
}

test('legacy receipts deduplicate both backends and retain the origin of unfinished messages', t => {
  const f = fixture(t);
  const sources = [f.legacy('codex', [['codex-done', 1], ['pending', 0]]),
    f.legacy('claude', [['claude-done', 1]]), { backend: 'absent', file: path.join(f.root, 'absent.sqlite') }];
  const router = createMessageRouting(f.directory, sources);
  try {
    assert.deepEqual({ ...router.claim('codex-done', 'claude') }, { backend: 'codex', done: 1 });
    assert.deepEqual({ ...router.claim('claude-done', 'codex') }, { backend: 'claude', done: 1 });
    assert.deepEqual({ ...router.claim('pending', 'claude') }, { backend: 'codex', done: 0 });
    assert.equal(fs.existsSync(sources[2].file), false, 'migration must not create a missing legacy database');
  } finally { router.close(); }
});

test('migration repairs missing completion without replacing an established route or clearing completion', t => {
  const f = fixture(t);
  let router = createMessageRouting(f.directory);
  router.claim('already-done', 'claude'); router.finish('already-done');
  router.claim('missing-completion', 'claude');
  router.close();
  router = createMessageRouting(f.directory, [f.legacy('codex', [['already-done', 0], ['missing-completion', 1]])]);
  try {
    assert.deepEqual({ ...router.claim('already-done', 'codex') }, { backend: 'claude', done: 1 });
    assert.deepEqual({ ...router.claim('missing-completion', 'codex') }, { backend: 'claude', done: 1 });
  } finally { router.close(); }
});

test('failed legacy import rolls back and can be retried after the source is repaired', t => {
  const f = fixture(t);
  const first = f.legacy('codex', [['done', 1]]);
  const broken = { backend: 'claude', file: path.join(f.root, 'broken.sqlite') };
  fs.writeFileSync(broken.file, 'not a SQLite database');
  assert.throws(() => createMessageRouting(f.directory, [first, broken]));
  const db = new DatabaseSync(path.join(f.directory, 'messages.sqlite'));
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM routes').get().n, 0); }
  finally { db.close(); }
  fs.rmSync(broken.file);
  const router = createMessageRouting(f.directory, [first, broken]);
  try { assert.equal(router.claim('done', 'claude').done, 1); }
  finally { router.close(); }
});
