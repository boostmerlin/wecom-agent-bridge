'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiagnostics } = require('../src/backends/cli-diagnostics.cjs');

test('CLI summaries redact credentials, URLs and the incoming text, and stay bounded', t => {
  const original = process.env.WECOM_BOT_SECRET;
  process.env.WECOM_BOT_SECRET = 'private-bot-credential';
  t.after(() => {
    if (original === undefined) delete process.env.WECOM_BOT_SECRET;
    else process.env.WECOM_BOT_SECRET = original;
  });
  const events = [];
  const diagnostics = createDiagnostics('exec', 'private incoming request', event => events.push(event));
  diagnostics.capture('\x1b[31mError: token="private token with spaces" Authorization: Bearer abc-secret\x1b[0m\n');
  diagnostics.capture('private incoming request private-bot-credential https://host.test/path?key=abc glpat-example-key\n');
  diagnostics.report(2, null);
  assert.equal(events[0].exitCode, 2);
  assert.match(events[0].errorSummary, /Error/);
  for (const text of ['private token', 'abc-secret', 'private incoming request', 'private-bot-credential', 'host.test', 'glpat-example-key', '\x1b'])
    assert.ok(!events[0].errorSummary.includes(text), text);
  diagnostics.capture('x'.repeat(20000));
  diagnostics.report(null, 'SIGTERM');
  assert.equal(events[1].signal, 'SIGTERM');
  assert.equal(events[1].exitCode, null);
  assert.ok(events[1].errorSummary.length <= 1200);
});

test('structured errors take precedence over stderr and logging cannot break delivery', () => {
  const events = [];
  const diagnostics = createDiagnostics('exec', 'test', event => events.push(event));
  diagnostics.capture('incidental warning');
  diagnostics.error('authentication failed api_key="hidden key"');
  diagnostics.report(1);
  assert.match(events[0].errorSummary, /authentication failed/);
  assert.ok(!events[0].errorSummary.includes('hidden key'));
  const failingLogger = createDiagnostics('queue', 'test', () => { throw new Error('log failed'); });
  assert.doesNotThrow(() => failingLogger.report(null, null, Object.assign(new Error('spawn failed'), { code: 'ENOENT' })));
});
