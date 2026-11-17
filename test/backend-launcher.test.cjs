'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { promisify } = require('node:util');
const { spawnSync } = require('node:child_process');
const { readBackend, loadTarget, readTaskTimeout } = require('../src/main.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge backend spaces-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
const backend = id => ({ id, parseThreadId: value => value });

test('task timeout defaults to 30 minutes, accepts zero, and rejects invalid durations', t => {
  const root = fixture(t);
  const file = path.join(root, '.config.local.json');
  assert.equal(readTaskTimeout(root), 1800000);
  for (const value of [0, 60000]) {
    write(file, { taskTimeoutMs: value });
    assert.equal(readTaskTimeout(root), value);
  }
  for (const value of [-1, 0.5, null, '60000', 2147483648]) {
    write(file, { taskTimeoutMs: value });
    assert.throws(() => readTaskTimeout(root), /taskTimeoutMs/);
  }
});

test('backend selection defaults to Codex and rejects unsupported selections', t => {
  const root = fixture(t);
  const config = path.join(root, '.config.local.json');
  assert.equal(readBackend(root), 'codex');
  for (const value of ['codex', 'claude']) {
    write(config, { backend: value });
    assert.equal(readBackend(root), value);
  }
  for (const value of ['', null, 1, 'fixture']) {
    write(config, { backend: value });
    assert.throws(() => readBackend(root), /backend/);
  }
  write(config, '{');
  assert.throws(() => readBackend(root), /config.local.json/);
});

test('backend targets remain isolated and Codex keeps legacy per-field fallback', t => {
  const root = fixture(t);
  const second = path.join(root, 'second project');
  fs.mkdirSync(second);
  const file = path.join(root, '.config.local.json');
  const config = {
    threadId: 'legacy-codex', workingDir: root,
    backends: { claude: { threadId: 'claude-chat', workingDir: second }, codex: { threadId: 'scoped-codex' } },
  };
  write(file, config);
  assert.equal(loadTarget(backend('codex'), root).threadId, 'scoped-codex');
  assert.equal(loadTarget(backend('codex'), root).workingDir, root);
  assert.equal(loadTarget(backend('claude'), root).threadId, 'claude-chat');
  assert.equal(loadTarget(backend('claude'), root).workingDir, second);
  assert.equal(loadTarget(backend('fixture'), root).workingDir, undefined);
  config.backends.codex = { threadId: '', workingDir: '' };
  write(file, config);
  assert.equal(loadTarget(backend('codex'), root).threadId, undefined);
  assert.equal(loadTarget(backend('codex'), root).workingDir, undefined);
  delete config.backends;
  write(file, config);
  assert.equal(loadTarget(backend('codex'), root).threadId, 'legacy-codex');
  assert.equal(loadTarget(backend('fixture'), root).threadId, 'legacy-codex');
  assert.equal(loadTarget(backend('claude'), root).threadId, undefined);
  assert.equal(loadTarget(backend('claude'), root).workingDir, undefined);
  write(file, { threadId: 'invalid legacy', workingDir: 'not absolute', backends: {} });
  assert.equal(loadTarget(backend('claude'), root).workingDir, undefined);
});

test('malformed backend target configuration fails instead of silently using the launch directory', t => {
  const root = fixture(t);
  const file = path.join(root, '.config.local.json');
  for (const backends of [null, [], 'claude']) {
    write(file, { backends });
    assert.throws(() => loadTarget(backend('claude'), root), /backends/);
  }
  for (const scoped of [null, [], 'target']) {
    write(file, { backends: { claude: scoped } });
    assert.throws(() => loadTarget(backend('claude'), root), /backends.claude/);
  }
});

test('remembered backend targets retain field and local queue priority', t => {
  const root = fixture(t);
  const file = path.join(root, '.config.local.json');
  const last = path.join(root, '.state', 'backends', 'claude', 'last-target.json');
  write(file, { backends: { claude: { threadId: 'configured', workingDir: root } } });
  write(path.join(root, '.state', 'last-target.json'), { threadId: 'codex-only', workingDir: root });
  assert.equal(loadTarget(backend('claude'), root).threadId, 'configured');
  write(last, { threadId: 'remembered' });
  let target = loadTarget(backend('claude'), root);
  assert.equal(target.threadId, 'remembered');
  assert.equal(target.workingDir, root);
  assert.deepEqual(target.sources, { thread: '.state', directory: '.config.local.json' });
  const queueKey = '01234567-89ab-4def-8123-0123456789ab';
  write(last, { queueKey, workingDir: root });
  target = loadTarget(backend('claude'), root);
  assert.equal(target.threadId, undefined);
  assert.equal(target.queueKey, queueKey);
  write(last, { threadId: 'remembered', workingDir: root });
  write(file, '{');
  assert.equal(loadTarget(backend('claude'), root).threadId, 'remembered');
});

// Evaluate only the launcher's dependency boundary, with real filesystem fixtures
// and an isolated process/environment. No installed CLI or service is contacted.
function launcher(env, reply, platform = process.platform) {
  const calls = [];
  const execFile = () => { throw Error('use promisified execution'); };
  execFile[promisify.custom] = async (file, args, options) => {
    assert.equal(options.shell, false);
    calls.push({ file, args });
    return reply(file, args);
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'launcher-tools.cjs'), 'utf8'), {
    module, process: { env, platform, execPath: process.execPath },
    require: name => name === 'node:child_process' ? { execFile } : require(name),
  });
  return { ...module.exports, calls };
}
const help = '--print --output-format <format> --verbose --resume [id] --permission-prompts <mode>';
function success(_file, args) {
  return { stdout: args.at(-1) === '--help' ? help : '{"loggedIn":true}', stderr: '' };
}

test('Claude absolute paths with spaces run only help and auth status', async t => {
  const root = fixture(t);
  const native = path.join(root, 'claude.exe');
  write(native, 'fixture');
  const tools = launcher({ CLAUDE_CLI_PATH: '"' + native + '"' }, success);
  const cli = await tools.resolveClaude();
  assert.equal(cli.file, native);
  assert.equal(cli.prefix.length, 0);
  assert.deepEqual(tools.calls.map(call => Array.from(call.args)), [['--help'], ['auth', 'status']]);
  assert.equal(tools.calls[0].file, native);
  await assert.rejects(launcher({ CLAUDE_CLI_PATH: 'claude.exe' }, success).resolveClaude(), /绝对/);
  await assert.rejects(launcher({ CLAUDE_CLI_PATH: path.join(root, 'missing') }, success).resolveClaude(), /绝对/);
});

test('Claude discovers native PATH executables and Windows npm JS entries', async t => {
  const root = fixture(t);
  const native = path.join(root, 'claude.exe');
  write(native, 'fixture');
  let tools = launcher({ PATH: '"' + root + '"' }, success, 'win32');
  assert.equal((await tools.resolveClaude()).file, native);
  fs.unlinkSync(native);
  const shim = path.join(root, 'claude.cmd');
  const packageRoot = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code');
  const entry = path.join(packageRoot, 'cli.js');
  write(shim, 'must never execute this shell shim');
  write(path.join(packageRoot, 'package.json'), { name: '@anthropic-ai/claude-code', bin: { claude: 'cli.js' } });
  write(entry, 'fixture');
  for (const env of [{ PATH: root }, { CLAUDE_CLI_PATH: shim }, { CLAUDE_CLI_PATH: entry }]) {
    tools = launcher(env, success, 'win32');
    const cli = await tools.resolveClaude();
    assert.equal(cli.file, process.execPath);
    assert.deepEqual(Array.from(cli.prefix), [entry]);
    assert.deepEqual(tools.calls.map(call => Array.from(call.args)), [[entry, '--help'], [entry, 'auth', 'status']]);
  }
  write(path.join(packageRoot, 'package.json'), { name: 'wrong-package', bin: 'cli.js' });
  await assert.rejects(launcher({ PATH: root }, success, 'win32').resolveClaude(), /未找到/);
  write(path.join(root, 'claude'), 'fixture');
  assert.equal((await launcher({ PATH: root }, success, 'linux').resolveClaude()).file, path.join(root, 'claude'));
});

test('Claude checks required flags, login JSON and status exit failures without model requests', async t => {
  const root = fixture(t);
  const file = path.join(root, 'claude.exe');
  write(file, 'fixture');
  const env = { CLAUDE_CLI_PATH: file };
  for (const flag of help.match(/--[\w-]+/g)) {
    const tools = launcher(env, () => ({ stdout: help.replace(flag, flag + '-unsupported'), stderr: '' }));
    await assert.rejects(tools.resolveClaude(), /缺少/);
    assert.equal(tools.calls.length, 1);
  }
  for (const stdout of ['{"loggedIn":false}', '{}', 'invalid JSON']) {
    const tools = launcher(env, (_file, args) => args[0] === '--help' ? success(_file, args) : { stdout, stderr: '' });
    await assert.rejects(tools.resolveClaude(), /授权/);
  }
  const tools = launcher(env, (_file, args) => {
    if (args[0] === '--help') return success(_file, args);
    throw Object.assign(new Error('exit 1'), { code: 1, stdout: '{"loggedIn":true}' });
  });
  await assert.rejects(tools.resolveClaude(), /授权/);
  await assert.rejects(launcher(env, () => { throw Error('help failed'); }).resolveClaude(), /--help/);
});

test('start lazily loads only the selected adapter and preserves check/replace arguments', t => {
  const root = fixture(t);
  const start = path.join(root, 'start.cjs');
  const src = path.join(root, 'src');
  fs.copyFileSync(path.join(__dirname, '..', 'start.cjs'), start);
  write(path.join(root, '.config.local.json'), { backend: 'claude', backends: { claude: { workingDir: root } } });
  write(path.join(src, 'main.cjs'), `
    const main = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'main.cjs'))});
    exports.readBackend = () => main.readBackend(${JSON.stringify(root)});
    exports.readTaskTimeout = () => main.readTaskTimeout(${JSON.stringify(root)});
    exports.resolveTarget = async backend => main.loadTarget(backend, ${JSON.stringify(root)});
    exports.runBridge = async config => {
      if (config.secret !== 'fixture-secret') throw Error('wrong secret');
      config.onAuthenticated?.();
      console.log('fixture bridge started');
    };
  `);
  write(path.join(src, 'launcher-tools.cjs'), `
    exports.resolveCodex = () => { throw Error('unselected resolver'); };
    exports.resolveClaude = async () => ({ file: ${JSON.stringify(process.execPath)}, prefix: ['fixture cli.js'] });
    exports.readIdentity = async () => ({ botId: 'bot', ownerId: 'owner' });
  `);
  write(path.join(src, 'backends', 'claude.cjs'), `
    exports.createClaudeBackend = ({claudePath}) => {
      if (claudePath.prefix[0] !== 'fixture cli.js') throw Error('wrong CLI descriptor');
      return {id:'claude', name:'Claude', parseThreadId: value => value};
    };
  `);
  // There is deliberately no Codex module in this fixture.
  write(path.join(src, 'control.cjs'), '');
  write(path.join(src, 'secret-input.cjs'), "exports.promptSecret = async () => 'fixture-secret';");
  write(path.join(src, 'secret-store.cjs'), `exports.secretStore = () => ({
    read() { throw Error('replace must skip stored secret'); }, save() { console.log('fixture saved'); }
  });`);
  const env = { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const run = args => spawnSync(process.execPath, [start, ...args], { cwd: root, env, encoding: 'utf8', timeout: 5000, shell: false });
  let result = run(['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude 工作目录/);
  assert.match(result.stdout, /检查通过/);
  assert.doesNotMatch(result.stdout, /fixture bridge started|fixture saved/);
  result = run(['--replace-secret']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixture bridge started/);
  assert.match(result.stdout, /fixture saved/);
  result = run(['--check', '--replace-secret']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /用法/);
});
