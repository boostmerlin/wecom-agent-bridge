'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClaudeBackend, parseThreadId } = require('../src/backends/claude.cjs');
const { chatTitle } = require('../src/task-status.cjs');

const id = '01234567-89ab-4def-8123-0123456789ab';
const other = '11234567-89ab-4def-8123-0123456789ab';
const init = cwd => ({ type: 'system', subtype: 'init', session_id: id, cwd });
const final = (text = '最终答复 😀') => ({ type: 'result', subtype: 'success', is_error: false, session_id: id, result: text });

function fixture(t, scenario, cli = 'fixture-claude') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-claude 测试-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], callbacks = [], diagnostics = [];
  const backend = createClaudeBackend({ claudePath: cli, execute(file, args, options) {
    calls.push({ file, args, options });
    const expected = scenario(root);
    const child = spawn(process.execPath, ['-e', `
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', text => { input += text; });
      process.stdin.on('end', () => {
        const f = JSON.parse(process.env.CLAUDE_FIXTURE);
        if (input !== f.prompt) process.exit(29);
        if ('WECOM_BOT_SECRET' in process.env || 'CLAUDECODE' in process.env || 'CLAUDE_CODE_ENTRYPOINT' in process.env) process.exit(30);
        for (const event of f.events) process.stdout.write(typeof event === 'string' ? event + '\\n' : JSON.stringify(event) + '\\n');
        if (f.stderr) process.stderr.write(f.stderr);
        process.exitCode = f.code || 0;
        if (f.hang) setInterval(() => {}, 1000);
      });
    `], { ...options, env: { ...options.env, CLAUDE_FIXTURE: JSON.stringify(expected) } });
    calls.at(-1).child = child;
    t.after(() => child.kill());
    return child;
  } });
  return { root, backend, calls, callbacks, diagnostics, turn: {
    workingDir: root, prompt: '消息 😀 " & %PATH% ` $()\n第二行',
    onCreated: session => callbacks.push(['created', session]),
    onStarted: () => callbacks.push(['started']),
    onDiagnostic: value => diagnostics.push(value),
  } };
}
const prompt = '消息 😀 " & %PATH% ` $()\n第二行';

test('Claude creates and resumes the exact session, sending UTF-8 by stdin and only returning the final result', async t => {
  const previous = Object.fromEntries(['WECOM_BOT_SECRET', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { WECOM_BOT_SECRET: 'private-secret', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' });
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const f = fixture(t, root => ({ prompt, events: [init(root),
    { type: 'assistant', session_id: id, message: { content: [{ type: 'text', text: '中间说明' }] } },
    { ...final('子代理内容'), parent_tool_use_id: 'tool-id' }, final(),
    { type: 'system', subtype: 'status', status: null, session_id: id }] }));
  assert.deepEqual(await f.backend.submit(f.turn), { state: 'completed', text: '最终答复 😀' });
  assert.deepEqual(f.callbacks, [['created', id], ['started']]);
  assert.equal(f.calls[0].file, 'fixture-claude');
  const ownerArgs = ['--print', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions', '--permission-prompts', 'none'];
  assert.deepEqual(f.calls[0].args, ownerArgs);
  assert.equal(f.calls[0].options.cwd, f.root);
  assert.equal(f.calls[0].options.shell, false);
  assert.equal(f.calls[0].options.windowsHide, true);
  assert.equal(f.diagnostics[0].exitCode, 0);
  f.callbacks.length = 0;
  assert.equal((await f.backend.submit({ ...f.turn, threadId: id })).state, 'completed');
  assert.deepEqual(f.calls[1].args, [...ownerArgs, '--resume', id]);
  assert.deepEqual(f.callbacks, [['started']]);
});

test('non-owner Claude tasks use auto in fresh non-persistent sessions without owner approvals', async t => {
  const f = fixture(t, root => ({ prompt, events: [init(root), final()] }));
  const turn = { ...f.turn, threadId: other,
    onCreated: () => assert.fail('External sessions must not replace the owner target'),
    onApproval: () => assert.fail('External tasks must not request owner approval') };
  for (let i = 0; i < 2; i++) assert.deepEqual(await f.backend.submitExternal(turn), { state: 'completed', text: '最终答复 😀' });
  for (const { args, options } of f.calls) {
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
    assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
    assert.ok(args.includes('--no-session-persistence'));
    assert.ok(!args.includes('--resume') && !args.includes('--settings') && !args.includes('bypassPermissions'));
    assert.equal(options.cwd, f.root);
  }
  assert.deepEqual(f.callbacks, [['started'], ['started']]);
});

test('non-owner policy denials still return the final explanation', async t => {
  const f = fixture(t, root => ({ prompt, events: [init(root), { ...final('权限拒绝，未执行。'), permission_denials: [{ tool_name: 'Bash' }] }] }));
  assert.deepEqual(await f.backend.submitExternal(f.turn), { state: 'completed', text: '权限拒绝，未执行。' });
  assert.equal(f.diagnostics[0].permissionDenials.count, 1);
});

test('Claude supports launcher executable prefixes for Windows npm installations', async t => {
  const f = fixture(t, root => ({ prompt, events: [init(root), final()] }), { file: process.execPath, prefix: ['C:/CLI path/cli.js'] });
  assert.equal((await f.backend.submit(f.turn)).state, 'completed');
  assert.equal(f.calls[0].file, process.execPath);
  assert.equal(f.calls[0].args[0], 'C:/CLI path/cli.js');
});

test('Claude pauses a tool for host approval and closes the hook after the turn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-approval-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let hook, asked = 0;
  const backend = createClaudeBackend({ claudePath: 'fixture', execute(file, args, options) {
    const index = args.indexOf('--settings');
    assert.ok(index >= 0, 'CLI must receive a PermissionRequest hook');
    hook = JSON.parse(args[index + 1]).hooks.PermissionRequest[0].hooks[0];
    return spawn(process.execPath, ['-e', `
      process.stdin.resume();
      process.stdin.on('end', async () => {
        const hook = JSON.parse(process.env.FIXTURE_HOOK);
        const session = '${id}';
        console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,cwd:process.cwd()}));
        const response = await fetch(hook.url, {method:'POST',headers:hook.headers,
          body:JSON.stringify({hook_event_name:'PermissionRequest',session_id:session,cwd:process.cwd(),tool_name:'Bash',tool_input:{command:'git push'}})});
        const result = await response.json();
        console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:session,result:result.hookSpecificOutput.decision.behavior}));
      });
    `], { ...options, env: { ...options.env, FIXTURE_HOOK: JSON.stringify(hook) } });
  } });
  const result = await backend.submit({ workingDir: root, prompt: 'test', onCreated() {}, onStarted() {},
    onApproval: async request => {
      asked++;
      assert.equal(request.toolName, 'Bash');
      assert.deepEqual(request.input, { command: 'git push' });
      return { behavior: 'allow' };
    } });
  assert.deepEqual(result, { state: 'completed', text: 'allow' });
  assert.equal(asked, 1);
  await assert.rejects(fetch(hook.url));
});

test('Claude timeout revokes approval while the child is still shutting down', { timeout: 5000 }, async t => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let hook, approval, release, ready;
  const initialized = new Promise(resolve => { ready = resolve; });
  let received;
  const requested = new Promise(resolve => { received = resolve; });
  const backend = createClaudeBackend({ claudePath: 'fixture', execute(_file, args) {
    hook = JSON.parse(args[args.indexOf('--settings') + 1]).hooks.PermissionRequest[0].hooks[0];
    queueMicrotask(() => child.stdout.write(JSON.stringify(init(__dirname)) + '\n'));
    return child;
  } });
  const pending = backend.submit({ workingDir: __dirname, threadId: id, prompt: 'test', timeoutMs: 300,
    onStarted: ready, onApproval: request => {
      approval = request; received();
      return new Promise(resolve => { release = resolve; });
    } });
  t.after(async () => {
    release?.({ behavior: 'deny' });
    child.emit('close', null, 'SIGKILL');
    child.stdout.end(); child.stderr.end();
    await pending;
  });
  await initialized;
  const response = fetch(hook.url, { method: 'POST', headers: hook.headers,
    body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: id, cwd: __dirname,
      tool_name: 'Bash', tool_input: { command: 'echo test' } }) }).then(r => r.json()).catch(() => null);
  await requested;
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(approval.signal.aborted, true, 'Approval survived timeout until process close');
  release({ behavior: 'allow' });
  assert.notEqual((await response)?.hookSpecificOutput?.decision?.behavior, 'allow');
});

test('Claude never retries a missing, failed, mismatched or malformed result after execution may have begun', async t => {
  const scenarios = [
    root => [init(root)],
    root => [init(root), { ...final(), session_id: other }],
    root => [{ ...init(root), session_id: other }, final()],
    root => [init(path.dirname(root)), final()],
    root => [init(root), { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: id, errors: ['failed'] }],
    root => [init(root), { ...final(), is_error: true }],
    root => [init(root), { ...final(), subtype: 99 }],
    root => [init(root), final('   ')],
    root => [init(root), 'invalid JSON', final()],
    root => [init(root), final(), final()],
    () => [final()],
    root => [init(root), { ...final(), subtype: 'error_during_execution', is_error: true, num_turns: 0, startup_failure_reason: 'cwd_unavailable' }],
  ];
  for (const [index, events] of scenarios.entries()) {
    await t.test('invalid outcome ' + index, async sub => {
      const f = fixture(sub, root => ({ prompt, events: events(root) }));
      const result = await f.backend.submit({ ...f.turn, threadId: id });
      assert.equal(result.state, 'uncertain');
      assert.equal(f.calls.length, 1);
    });
  }
  const f = fixture(t, root => ({ prompt, events: [init(root), final()], code: 1 }));
  assert.equal((await f.backend.submit(f.turn)).state, 'uncertain');
});

test('only confirmed pre-session startup failures are rejected and launch failures are safely classified', async t => {
  const f = fixture(t, () => ({ prompt, events: [{ type: 'result', subtype: 'error_during_execution',
    is_error: true, num_turns: 0, startup_failure_reason: 'session_held_by_background', errors: ['held'] }], code: 1 }));
  assert.deepEqual(await f.backend.submit(f.turn), { state: 'rejected', reason: 'claude_startup_failed' });
  assert.deepEqual(f.callbacks, []);
  for (const [code, state] of [['ENOENT', 'queued'], ['E2BIG', 'rejected'], ['UNKNOWN', 'uncertain']]) {
    const backend = createClaudeBackend({ claudePath: 'missing', execute() { throw Object.assign(new Error('failure'), { code }); } });
    assert.equal((await backend.submit(f.turn)).state, state);
  }
});

test('remaining policy denials return Claude final explanation without retrying or waiting for an approval', async t => {
  const f = fixture(t, root => ({ prompt, events: [init(root), { ...final('命令未执行：权限不足。'), permission_denials: [{ tool_name: 'Bash' }] }] }));
  assert.deepEqual(await f.backend.submit(f.turn), { state: 'completed', text: '命令未执行：权限不足。' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('--permission-mode') + 1], 'bypassPermissions');
});

test('session metadata uses the official local SDK with exact directory filtering and archived sessions excluded', async () => {
  let loads = 0;
  const calls = [];
  const backend = createClaudeBackend({ claudePath: 'fixture', loadSessions: async () => {
    loads++;
    return {
      getSessionInfo: async session => { calls.push(session); return session === id ? { sessionId: id, cwd: 'C:/project', summary: 'Summary', customTitle: 'Title' } : undefined; },
      listSessions: async options => { calls.push(options); return [
        { sessionId: id, summary: 'Summary', customTitle: 'Title' },
        { sessionId: other, summary: 'Archived', archived: true }, { sessionId: '../invalid', summary: 'Invalid' },
      ]; },
    };
  } });
  assert.equal(await backend.getWorkingDir(id), 'C:/project');
  assert.equal(await backend.getThreadTitle(id), 'Title');
  assert.deepEqual(await backend.listThreads('C:/project'), [{ id, name: 'Title' }]);
  assert.deepEqual(calls[2], { dir: 'C:/project', includeWorktrees: false });
  assert.equal(loads, 1);
  await assert.rejects(backend.getWorkingDir(other), /工作目录/);
  for (const value of ['', null, '../bad', 'codex://threads/' + id]) assert.throws(() => parseThreadId(value));
  assert.equal(parseThreadId(id.toUpperCase()), id);
});

test('Claude status and thread lists show a title or a short body excerpt, including flattened SDK previews', async () => {
  let info;
  const backend = createClaudeBackend({ claudePath: 'fixture',
    loadSessions: async () => ({ getSessionInfo: async () => info, listSessions: async () => [{ sessionId: id, ...info }] }) });
  for (const [metadata, expected] of [
    [{ customTitle: '发布检查', summary: '旧摘要' }, '发布检查'],
    [{ summary: '检查发布结果', firstPrompt: '之前的请求' }, '检查发布结果'],
    [{ summary: '', firstPrompt: '企微单聊 · 本人\n\n**正文**\n\n查看发布日志\n\n**特殊要求**\n- 简洁' }, '查看发布日志'],
    [{ summary: '企微单聊 · 本人  **正文**  /theads  **特殊要求** - 只回复结果', firstPrompt: '另一条消息' }, '/theads'],
    [{ summary: '企微群聊 · 本人 **正文** 查进度 **约定**（以正文为准） - 一条约定 **特殊要求** - 简洁' }, '查进度'],
    [{ summary: '企微群聊 · 本人  旧格式的任务  本条适用的本人约定 - 一条约定' }, '旧格式的任务'],
    [{ summary: '企微群聊 · 外部用户  权限说明  **正文**  > 处理任务  **引用**  > 引用内容' }, '处理任务'],
    [{ summary: '企微单聊 · 本人  **正文**  **特殊要求** - 只回复结果' }, undefined],
    [undefined, undefined],
  ]) {
    info = metadata;
    assert.deepEqual(await backend.listThreads('C:/project'), [{ id, name: expected }]);
    assert.equal(await chatTitle(backend, id, { compact: true }), (expected || '暂无标题') + ' · …0123456789ab');
    assert.equal(await chatTitle(backend, id, { compact: true, allowPreview: false }),
      (metadata?.customTitle || '暂无标题') + ' · …0123456789ab');
    assert.deepEqual(await backend.listThreads('C:/project', { allowPreview: false }),
      [{ id, name: metadata?.customTitle }]);
  }
});

test('Claude cancellation and timeout terminate execution without returning or retrying a partial result', { timeout: 10000 }, async t => {
  for (const reason of ['task_cancelled', 'task_timeout']) {
    const controller = new AbortController();
    const f = fixture(t, root => ({ prompt, events: [init(root)], hang: true }));
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const pending = f.backend.submit({ ...f.turn, signal: controller.signal,
      timeoutMs: reason === 'task_timeout' ? 200 : 0, onStarted: started });
    if (reason === 'task_cancelled') { await ready; controller.abort('task_cancelled'); }
    let timer;
    const result = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve('did not stop'), 4000); })])
      .finally(() => clearTimeout(timer));
    assert.deepEqual(result, { state: 'uncertain', reason });
    assert.equal(f.calls.length, 1);
    assert.equal(f.diagnostics[0].stopReason, reason);
  }
});

test('already cancelled Claude requests never start a process', async t => {
  const f = fixture(t, root => ({ prompt, events: [init(root), final()] }));
  const signal = AbortSignal.abort('task_cancelled');
  assert.deepEqual(await f.backend.submit({ ...f.turn, signal }), { state: 'uncertain', reason: 'task_cancelled' });
  assert.equal(f.calls.length, 0);
});

test('Claude diagnostics expose bounded metrics and warnings without tool inputs or conversation text', async t => {
  const warnings = [];
  const f = fixture(t, root => ({ prompt, events: [{ ...init(root), model: 'provider/claude-sonnet-4-6' },
    { ...final(), duration_ms: 1200, duration_api_ms: 1000, total_cost_usd: 0.02, num_turns: 2,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10, private: 'secret-input' },
      permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'secret-command' } }] },
    { type: 'system', subtype: 'session_writes_lost', session_id: id, error_code: 'ENOSPC',
      lost: ['transcript'], transcript_session_ids: [id], private: 'secret-warning' }] }));
  assert.equal((await f.backend.submit({ ...f.turn, onWarning: warning => warnings.push(warning) })).state, 'completed');
  const stats = f.diagnostics[0];
  assert.equal(stats.model, 'provider/claude-sonnet-4-6');
  assert.equal(stats.durationMs, 1200);
  assert.equal(stats.costUsd, 0.02);
  assert.deepEqual(stats.permissionDenials, { count: 1, tools: ['Bash'] });
  assert.deepEqual(stats.usage, { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10 });
  assert.deepEqual(warnings, [{ reason: 'session_writes_lost', errorCode: 'ENOSPC', lost: ['transcript'], threadIds: [id] }]);
  assert.ok(!JSON.stringify([stats, warnings]).includes('secret-'));
});
