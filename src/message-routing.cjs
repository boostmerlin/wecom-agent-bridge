'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function importLegacy(db, sources) {
  if (!sources.length) return;
  db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)');
  if (db.prepare('SELECT 1 FROM migrations WHERE name=?').get('legacy-receipts-v1')) return;
  const insert = db.prepare(`INSERT INTO routes(id,backend,done) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET done=MAX(routes.done,excluded.done)`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { backend, file } of sources) {
      if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
      const legacy = new DatabaseSync(file, { readOnly: true });
      try {
        if (!legacy.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='received'").get()) continue;
        for (const row of legacy.prepare('SELECT id,done FROM received').iterate()) {
          // An established route stays authoritative; completion must never regress.
          insert.run(row.id, backend, row.done === 1 ? 1 : 0);
        }
      } finally { legacy.close(); }
    }
    db.prepare('INSERT INTO migrations VALUES(?)').run('legacy-receipts-v1');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

// Backend-local receipts cannot deduplicate a callback delivered again after a switch.
function createMessageRouting(directory, legacySources = []) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, 'messages.sqlite'));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, backend TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)');
    importLegacy(db, legacySources);
  } catch (error) { db.close(); throw error; }
  return {
    claim(id, backend) {
      db.prepare('INSERT INTO routes(id,backend) VALUES(?,?) ON CONFLICT DO NOTHING').run(id, backend);
      return db.prepare('SELECT backend,done FROM routes WHERE id=?').get(id);
    },
    finish(id) { db.prepare('UPDATE routes SET done=1 WHERE id=?').run(id); },
    close() { db.close(); },
  };
}

module.exports = { createMessageRouting };
