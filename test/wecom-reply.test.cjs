'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWecomSender, MAX_REPLY_BYTES } = require('../src/wecom-reply.cjs');

function fixture({ sessions = [], send = { exitCode: 0, stdout: '{"success":true}' }, identity, list } = {}) {
  const calls = [];
  const sender = createWecomSender({
    botId: 'fixture-bot', ownerId: 'fixture-owner',
    resolveCli: async () => ({ file: 'fixture-cli', prefix: [] }),
    identity: identity || (async () => ({ botId: 'fixture-bot', ownerId: 'fixture-owner' })),
    invoke: async (_cli, args) => {
      calls.push(args);
      if (args.includes('sessions')) return list || { exitCode: 0, stdout: JSON.stringify({ sessions }) };
      if (send instanceof Error) throw send;
      return send;
    },
  });
  return { sender, calls };
}
const group = { chatType: 'group', chatId: 'fixture-group', senderId: 'fixture-sender' };
const owner = { chatType: 'single', chatId: 'fixture-owner', senderId: 'fixture-owner' };

test('owner uses freshly verified identity; user text is one literal JSON argument', async () => {
  const { sender, calls } = fixture();
  const text = 'literal " $(ignored) & \n正文';
  assert.deepEqual(await sender(owner, text), { success: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 4), ['message', 'aibot', 'send', '--json']);
  assert.equal(JSON.parse(calls[0][4]).markdown.content, text);
});

test('group must match a unique fresh CLI identifier and type', async () => {
  const good = fixture({ sessions: [{ chat_id: group.chatId, chat_type: 'group' }] });
  await good.sender(group, 'fixture');
  assert.equal(good.calls[0][2], 'sessions');
  for (const sessions of [[], [{ chat_id: 'opaque-other', chat_type: 'group', chat_name: 'same-name' }],
    [{ chat_id: group.chatId, chat_type: 'single' }],
    [{ chat_id: group.chatId, chat_type: 'group' }, { chat_id: group.chatId, chat_type: 'group' }]]) {
    const bad = fixture({ sessions });
    await assert.rejects(bad.sender(group, 'fixture'), { code: 'REPLY_ROUTE_UNMAPPED', outcome: 'not_sent', definitelyUnsent: true, temporary: true });
    assert.equal(bad.calls.length, 1);
  }
});

test('identity changes and invalid routes never invoke send', async () => {
  const changed = fixture({ identity: async () => ({ botId: 'changed', ownerId: 'fixture-owner' }) });
  await assert.rejects(changed.sender(owner, 'fixture'), { code: 'REPLY_IDENTITY_CHANGED', outcome: 'not_sent', definitelyUnsent: true, temporary: false });
  assert.equal(changed.calls.length, 0);
  const invalid = fixture();
  await assert.rejects(invalid.sender({ ...owner, chatId: 'different' }, 'fixture'), { code: 'REPLY_ROUTE_INVALID' });
  assert.equal(invalid.calls.length, 0);
});

test('UTF-8 byte and Windows escaping budgets reject without sending', async () => {
  const { sender, calls } = fixture();
  await assert.rejects(sender(owner, '中'.repeat(Math.floor(MAX_REPLY_BYTES / 3) + 1)), { code: 'REPLY_TEXT_TOO_LONG' });
  await assert.rejects(sender(owner, '\x00'.repeat(MAX_REPLY_BYTES)), { code: 'REPLY_TEXT_TOO_LONG' });
  assert.equal(calls.length, 0);
});

test('explicit backend rejection is not_sent; timeouts and ambiguous success are uncertain', async () => {
  const rejected = fixture({ send: { exitCode: 1, stdout: '{"errcode":850003,"errmsg":"private detail"}' } });
  await assert.rejects(rejected.sender(owner, 'fixture'), error => error.outcome === 'not_sent' && error.businessCode === 850003 && !error.message.includes('private detail'));
  for (const send of [{ exitCode: null, stdout: '' }, { exitCode: 0, stdout: '{}' },
    { exitCode: 1, stdout: '{"success":true}' }, new Error('private command and body')]) {
    const ambiguous = fixture({ send });
    await assert.rejects(ambiguous.sender(owner, 'fixture'), error => error.outcome === 'uncertain' && error.uncertain && !error.definitelyUnsent && !error.temporary && !error.message.includes('private'));
    assert.equal(ambiguous.calls.length, 1);
  }
});

test('preflight failures and an executable that never starts are not_sent', async () => {
  const denied = fixture({ list: { exitCode: 1, stdout: '{"errcode":850003}' } });
  await assert.rejects(denied.sender(group, 'fixture'), { outcome: 'not_sent', businessCode: 850003, definitelyUnsent: true, temporary: true });
  assert.equal(denied.calls.length, 1);
  const missing = fixture({ send: { exitCode: null, stdout: '', spawnError: 'ENOENT' } });
  await assert.rejects(missing.sender(owner, 'fixture'), { outcome: 'not_sent', code: 'REPLY_CLI_UNAVAILABLE' });
});

test('authorization expiry requires an explicit WeCom error message', async () => {
  for (const [errmsg, authorizationIssue] of [
    ['Authorization expired (callid: secret-reference)', 'expired'],
    ['授权已过期', 'expired'],
    ['no authority', 'rejected'],
    ['authorization expired status is unknown', 'rejected'],
    [undefined, 'rejected'],
  ]) {
    const { sender } = fixture({ send: { exitCode: 1, stdout: JSON.stringify({ errcode: 850003, errmsg }) } });
    await assert.rejects(sender(owner, 'fixture'), error =>
      error.code === 'REPLY_REJECTED' && error.businessCode === 850003 && error.temporary &&
      error.authorizationIssue === authorizationIssue && error.operation === 'send' && !error.message.includes('secret-reference'));
  }
  const preflight = fixture({ list: { exitCode: 1, stdout: '{"errcode":850003,"errmsg":"authorization expired"}' } });
  await assert.rejects(preflight.sender(group, 'fixture'), { authorizationIssue: 'expired', operation: 'list_sessions' });
});
