'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { secretStore } = require('../src/secret-store.cjs');

test('reopens and replaces a plaintext per-bot Secret', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-secret-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = secretStore('test-bot', dir);
  const sample = 'test-only-secret-中文-&';
  assert.equal(store.read(), null);
  store.save(sample);
  const [name] = fs.readdirSync(path.join(dir, '.state'));
  const file = path.join('.state', name);
  assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), sample);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, file)).mode & 0o077, 0);
  assert.equal(secretStore('test-bot', dir).read(), sample);
  assert.equal(secretStore('second-bot', dir).read(), null);
  const other = secretStore('second-bot', dir);
  const hash = require('node:crypto').createHash('sha256').update('second-bot').digest('hex');
  const old = path.join(dir, '.state', 'bot-' + hash + '.secret');
  fs.writeFileSync(old, 'old-secret');
  assert.equal(other.read(), 'old-secret');
  assert.equal(fs.existsSync(old), true);
  store.save('replacement');
  assert.equal(other.read(), 'old-secret');
  assert.equal(store.read(), 'replacement');
});
