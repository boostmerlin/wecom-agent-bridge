'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexApprovals } = require('../src/backends/codex-permissions.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const base = { threadId: 'thread', turnId: 'turn', itemId: 'item', cwd: 'D:/project' };

function fixture(t, onApproval = async () => ({ behavior: 'allow' })) {
  const responses = [], requests = [];
  const approvals = createCodexApprovals({ threadId: 'thread', turnId: 'turn', workingDir: 'D:/project',
    respond: (id, result) => responses.push({ id, result }),
    onApproval: details => { requests.push(details); return onApproval(details); } });
  t.after(() => approvals.close());
  const request = (method, params = {}, id = 1) => approvals.request({ id, method: 'item/' + method + '/requestApproval', params: { ...base, ...params } });
  return { approvals, responses, requests, request };
}

test('Codex command approvals grant only this request, not a session or policy amendment', async t => {
  const f = fixture(t);
  f.request('commandExecution', { command: 'git push', reason: 'publish', proposedExecpolicyAmendment: ['git'], availableDecisions: ['accept', 'decline'] });
  await tick();
  assert.deepEqual(f.responses, [{ id: 1, result: { decision: 'accept' } }]);
  assert.equal(f.requests[0].input.command, 'git push');
  assert.equal(f.requests[0].input.reason, 'publish');
  f.request('commandExecution', { command: 'git push' });
  await tick();
  assert.equal(f.responses.length, 1, 'a repeated RPC id must not approve another operation');
});

test('Codex requires matching turn, full details and an available one-time decision', async t => {
  const f = fixture(t);
  f.request('commandExecution', { threadId: 'other', command: 'delete' }, 1);
  f.request('commandExecution', { turnId: 'other', command: 'delete' }, 2);
  f.request('commandExecution', {}, 3);
  f.request('commandExecution', { command: 'delete', availableDecisions: ['acceptForSession', 'decline'] }, 4);
  f.request('fileChange', {}, 5);
  await tick();
  assert.equal(f.requests.length, 0);
  assert.equal(f.responses.length, 5);
  assert.ok(f.responses.every(x => x.result.decision === 'decline'));
});

test('file changes show the matching patch and permission grants last at most one turn', async t => {
  const f = fixture(t);
  const changes = [{ path: 'D:/outside/file.txt', kind: { type: 'add' }, diff: '+test' }];
  f.approvals.observe({ method: 'item/started', params: { ...base, item: { id: 'item', type: 'fileChange', changes } } });
  f.request('fileChange', { reason: 'write outside workspace', grantRoot: 'D:/outside' });
  const permissions = { fileSystem: { write: ['D:/outside'] }, network: { enabled: true } };
  f.request('permissions', { permissions }, 2);
  await tick();
  assert.deepEqual(f.requests[0].input.changes, changes);
  assert.deepEqual(f.responses[0].result, { decision: 'accept' });
  assert.deepEqual(f.responses[1].result, { permissions, scope: 'turn' });
  assert.match(f.requests[1].input.scope, /本轮/);
});

test('denial, exceptions and invalid permissions never grant access', async t => {
  const f = fixture(t, async () => { throw new Error('transport failed'); });
  f.request('commandExecution', { command: 'write' });
  f.request('permissions', { permissions: { fileSystem: { write: ['D:/outside'] } } }, 2);
  f.request('permissions', {}, 3);
  await tick();
  assert.deepEqual(f.responses.find(x => x.id === 1).result, { decision: 'decline' });
  assert.deepEqual(f.responses.find(x => x.id === 2).result, { permissions: {}, scope: 'turn' });
  assert.deepEqual(f.responses.find(x => x.id === 3).result, { permissions: {}, scope: 'turn' });
});

test('server resolution and close invalidate pending approvals, ignoring late allows', async t => {
  let release;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  f.request('commandExecution', { command: 'write' });
  f.approvals.observe({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 1 } });
  assert.equal(f.requests[0].signal.aborted, true);
  release({ behavior: 'allow' });
  await tick();
  assert.equal(f.responses.length, 0);
  f.request('commandExecution', { command: 'write' }, 2);
  f.approvals.close();
  assert.equal(f.requests[1].signal.aborted, true);
  release({ behavior: 'allow' });
  await tick();
  assert.equal(f.responses.length, 0);
});

test('completed items expire approvals even when a server resolution notification is absent', async t => {
  let release;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  f.request('commandExecution', { command: 'write' });
  f.approvals.observe({ method: 'item/completed', params: { ...base, item: { id: 'item', type: 'commandExecution' } } });
  assert.equal(f.requests[0].signal.aborted, true);
  release({ behavior: 'allow' });
  await tick();
  assert.equal(f.responses.length, 0);
});
