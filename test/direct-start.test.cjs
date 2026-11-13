'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const threadId = '01234567-89ab-4def-8123-0123456789ab';
const chatLink = 'codex://threads/' + threadId;
const markdownLink = '[配置真实运行场景](' + chatLink + ')';

test('thread configuration accepts only UUIDs and links to a single Codex thread', () => {
  const { parseThreadId } = require('../src/backends/codex.cjs');
  for (const value of [threadId, chatLink, markdownLink]) assert.equal(parseThreadId(value), threadId);
  for (const value of [null, '', '  ', 'https://threads/' + threadId, 'codex://other/' + threadId,
    chatLink + '/extra', '[标题](https://threads/' + threadId + ')']) {
    assert.throws(() => parseThreadId(value), Error);
  }
});

test('Node runs one foreground service and requires an explicit secret for unattended startup', { timeout: 25_000 }, async (t) => {
  // control.cjs derives its pipe name from its own directory, so the real control code
  // in this temporary copy cannot query or stop a bridge running in the installation.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom direct start-'));
  const src = path.join(root, 'src');
  const sdk = path.join(root, 'node_modules', '@wecom', 'aibot-node-sdk');
  const start = path.join(root, 'start.cjs');
  const control = path.join(src, 'control.cjs');
  const trace = path.join(root, 'sdk.jsonl');
  const target = { threadId, workingDir: path.join(root, 'target project') };
  function assertTargetShown(lines) {
    assert.ok(lines.some(line => /^Codex 工作目录\s+/.test(line) && line.endsWith(target.workingDir)), 'show the configured project directory');
    const chatLine = lines.find(line => /^Codex 聊天 ID\s+/.test(line));
    assert.equal(chatLine?.replace(/^Codex 聊天 ID\s+/, ''), target.threadId, 'show the destination as a plain UUID');
  }
  let worker, exited;
  t.after(async () => {
    if (worker && worker.exitCode === null && !worker.signalCode) worker.kill();
    if (exited) await exited;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(src);
  fs.mkdirSync(target.workingDir);
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'start.cjs'), start);
  fs.cpSync(path.join(__dirname, '..', 'src'), src, { recursive: true });
  fs.writeFileSync(path.join(root, '.config.local.json'), JSON.stringify({ ...target, threadId: markdownLink }));
  // These two system adapters are the only substitutes: no real identity, bot, or network.
  fs.writeFileSync(path.join(src, 'launcher-tools.cjs'), `
    exports.resolveCodex = () => process.execPath;
    exports.readIdentity = () => {
      if (process.env.NO_IDENTITY) throw Error('fixture identity unavailable');
      return { botId: 'fixture-bot', ownerId: 'fixture-owner' };
    };
  `);
  fs.writeFileSync(path.join(sdk, 'index.js'), `
    const { EventEmitter } = require('node:events');
    const fs = require('node:fs');
    module.exports.WSClient = class extends EventEmitter {
      constructor(options) {
        super();
        if (options.secret !== 'fixture-secret' || options.botId !== 'fixture-bot') throw Error('Wrong credentials source');
        if (process.env.WECOM_BOT_SECRET) throw Error('Secret remained in the environment');
      }
      connect() {
        fs.appendFileSync(process.env.SDK_TRACE, JSON.stringify({ pid: process.pid, event: 'connect' }) + '\\n');
        this.emit('authenticated');
      }
      disconnect() {}
    };
  `);
  const env = { SDK_TRACE: trace };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const options = { cwd: root, env, windowsHide: true, shell: false };
  const run = (args, extra = {}) => spawnSync(process.execPath, args, {
    ...options, timeout: 5000, encoding: 'utf8', ...extra,
  });
  worker = spawn(process.execPath, [start], { ...options, env: { ...env, WECOM_BOT_SECRET: 'fixture-secret' } });
  exited = new Promise(resolve => worker.once('close', resolve));
  let stdout = '', stderr = '';
  worker.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const ready = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('close', code => reject(new Error('Cold start exited with ' + code + ': ' + stderr)));
    worker.stdout.setEncoding('utf8').on('data', text => {
      stdout += text;
      if (stdout.includes('"event":"authenticated"')) resolve();
    });
  });
  worker.stdin.on('error', () => {});
  await ready;
  worker.stdin.end();

  const status = run([control, 'status']);
  assert.equal(status.status, 0, status.stderr);
  const info = JSON.parse(status.stdout);
  assert.equal(info.connection, 'authenticated');
  assert.equal(info.pid, worker.pid);
  assert.equal(info.threadId, target.threadId);

  const again = run([start], { env: { ...env, NO_IDENTITY: '1' }, input: 'invalid stdin' });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already running/i);
  assert.ok(again.stdout.includes(String(worker.pid)));
  assert.equal(run([control, 'stop']).status, 0);
  assert.equal(await exited, 0);

  const lines = stdout.trimEnd().split(/\r?\n/);
  const startingIndex = lines.findIndex(line => line.startsWith('{') && JSON.parse(line).event === 'starting');
  assert.ok(startingIndex >= 0, 'emit a starting event');
  assertTargetShown(lines.slice(0, startingIndex));
  const emitted = lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const saved = fs.readFileSync(path.join(root, '.state', 'events.jsonl'), 'utf8');
  assert.deepEqual(emitted, saved.trimEnd().split(/\r?\n/).map(line => JSON.parse(line)));
  const lifecycle = emitted.filter(row => ['starting', 'authenticated', 'stopped'].includes(row.event));
  assert.deepEqual(lifecycle.map(row => row.event), ['starting', 'authenticated', 'stopped']);
  assert.equal(lifecycle[0].workingDir, target.workingDir);
  assert.equal(lifecycle[0].threadId, target.threadId);
  for (const row of emitted) {
    assert.equal(typeof row.message, 'string');
    assert.ok(row.message.trim() && row.message !== row.event, 'each event needs a readable description');
  }
  assert.match(lifecycle[1].message, /认证|连接|验证|authenticat|connected/i);
  assert.match(lifecycle[2].message, /停止|关闭|退出|结束|stopp?ed|shutdown/i);
  assert.ok(![stdout, stderr, saved].some(output => output.includes('fixture-secret')), 'do not log the connection secret');

  const offline = run([control, 'status', '--if-running']);
  assert.equal(offline.status, 0);
  assert.equal(offline.stdout.trim(), '');

  const noSecret = run([start]);
  assert.equal(noSecret.status, 1, noSecret.stderr);
  assert.match(noSecret.stderr, /WECOM_BOT_SECRET/);
  assertTargetShown(noSecret.stdout.split(/\r?\n/));
  const check = run([start, '--check']);
  assert.equal(check.status, 0, check.stderr);
  assertTargetShown(check.stdout.split(/\r?\n/));
  fs.writeFileSync(path.join(root, '.config.local.json'), '{}');
  assertTargetShown(run([start, '--check']).stdout.split(/\r?\n/));
  const lastFile = path.join(root, '.state', 'last-target.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(lastFile, 'utf8')), { threadId, workingDir: target.workingDir });
  fs.unlinkSync(lastFile);
  // A config containing just the copied deep link must resolve the chat's own
  // project through the read-only adapter, not the launcher's current directory.
  fs.writeFileSync(path.join(src, 'backends', 'codex-history.cjs'), `
    exports.readThreadCwd = async ({threadId}) => {
      if (threadId !== ${JSON.stringify(threadId)}) throw Error('Unexpected chat');
      return ${JSON.stringify(target.workingDir)};
    };
  `);
  for (const config of [{ threadId: markdownLink }, { threadId: chatLink, workingDir: '' }]) {
    fs.writeFileSync(path.join(root, '.config.local.json'), JSON.stringify(config));
    const inferred = run([start, '--check']);
    assert.equal(inferred.status, 0, inferred.stderr);
    assertTargetShown(inferred.stdout.split(/\r?\n/));
  }
  const failedCheck = run([start, '--check'], { env: { ...env, NO_IDENTITY: '1' } });
  assert.equal(failedCheck.status, 1);
  assert.match(failedCheck.stderr, /fixture identity unavailable/);
  assertTargetShown(failedCheck.stdout.split(/\r?\n/));
  const connections = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(connections, [{ pid: worker.pid, event: 'connect' }]);
});

test('target fields default independently, with remembered values first', t => {
  const { loadTarget } = require('../src/main.cjs');
  const { createCodexBackend } = require('../src/backends/codex.cjs');
  const backend = createCodexBackend({ codexPath: 'fixture' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-target-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(loadTarget(backend, root).threadId, undefined);
  assert.equal(loadTarget(backend, root).workingDir, undefined);
  const local = path.join(root, '.config.local.json');
  fs.writeFileSync(local, JSON.stringify({ workingDir: root }));
  assert.equal(loadTarget(backend, root).workingDir, root);
  fs.mkdirSync(path.join(root, '.state'));
  const last = path.join(root, '.state', 'last-target.json');
  fs.writeFileSync(last, JSON.stringify({ projectDir: os.tmpdir() }));
  assert.equal(loadTarget(backend, root).workingDir, root);
  fs.writeFileSync(local, JSON.stringify({ projectDir: root }));
  assert.equal(loadTarget(backend, root).workingDir, undefined);
  fs.writeFileSync(local, JSON.stringify({ workingDir: root }));
  fs.writeFileSync(last, JSON.stringify({ threadId }));
  assert.equal(loadTarget(backend, root).threadId, threadId);
  assert.equal(loadTarget(backend, root).workingDir, root);
  fs.writeFileSync(last, JSON.stringify({ threadId, workingDir: os.tmpdir() }));
  fs.writeFileSync(local, JSON.stringify({ threadId: 'different-invalid', workingDir: 'different-invalid' }));
  assert.equal(loadTarget(backend, root).workingDir, os.tmpdir());
  assert.equal(loadTarget(backend, root).threadId, threadId);
});
