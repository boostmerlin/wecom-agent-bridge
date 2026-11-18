'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPermissionHook } = require('../src/backends/claude-permissions.cjs');

test('hook authenticates the local CLI and preserves the approval decision without granting lasting rules', async t => {
  let calls = 0;
  const hook = await createPermissionHook({ workingDir: __dirname, sessionId: () => 'thread', onApproval: async request => {
    calls++;
    assert.equal(request.toolName, 'Bash');
    return { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }] };
  } });
  t.after(() => hook.close());
  const config = hook.settings.hooks.PermissionRequest[0].hooks[0];
  const body = { hook_event_name: 'PermissionRequest', session_id: 'thread', cwd: __dirname, tool_name: 'Bash', tool_input: { command: 'echo hello' } };
  const send = (headers = config.headers, value = body) => fetch(config.url, { method: 'POST', headers, body: JSON.stringify(value) });
  assert.equal((await send({})).status, 403);
  assert.equal((await send(config.headers, { ...body, session_id: 'wrong' })).status, 400);
  assert.equal((await send(config.headers, { ...body, hook_event_name: 'PreToolUse' })).status, 400);
  assert.equal((await send(config.headers, { ...body, cwd: 'Z:/missing' })).status, 400);
  assert.equal(calls, 0);
  assert.deepEqual(await (await send()).json(), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal(calls, 1);
});

test('hook aborts pending approvals when the CLI disconnects or the turn ends', async t => {
  let signal, started;
  const called = new Promise(resolve => { started = resolve; });
  const hook = await createPermissionHook({ workingDir: __dirname, sessionId: () => 'thread', onApproval: request => {
    signal = request.signal; started();
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ behavior: 'deny', message: 'cancelled' }), { once: true }));
  } });
  t.after(() => hook.close());
  const config = hook.settings.hooks.PermissionRequest[0].hooks[0];
  const controller = new AbortController();
  const response = fetch(config.url, { method: 'POST', headers: config.headers, signal: controller.signal,
    body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'thread', cwd: __dirname, tool_name: 'Bash', tool_input: {} }) });
  await called;
  controller.abort();
  await assert.rejects(response);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(signal.aborted, true);
});
