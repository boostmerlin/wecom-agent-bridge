'use strict';

// Opt-in only: uses the local Claude login and makes real model requests.
// The reply transport is local; no WeCom credentials or production state are used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createClaudeBackend } = require('../src/backends/claude.cjs');
const { resolveClaude } = require('../src/launcher-tools.cjs');
const { createDelivery } = require('../src/delivery.cjs');

test('real Claude creates a session, resumes context, denies a tool and returns finals to the original routes',
  { timeout: 420000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-claude-smoke-'));
    const workingDir = path.join(root, 'project');
    fs.mkdirSync(workingDir);
    fs.writeFileSync(path.join(workingDir, 'blocked.txt'), 'This file must not be read by the smoke test.');
    const settings = path.join(root, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ disableAllHooks: true,
      permissions: { allow: ['Read'], deny: ['Read(./blocked.txt)'] } }));
    let delivery, pending, threadId;
    t.after(async () => {
      await delivery?.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const cli = await resolveClaude();
    const prefix = [...cli.prefix, '--settings', settings, '--permission-mode', 'default',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--tools', 'Read'];
    if (process.env.CLAUDE_SMOKE_MODEL) prefix.push('--model', process.env.CLAUDE_SMOKE_MODEL);
    const backend = createClaudeBackend({ claudePath: { ...cli, prefix } });
    const diagnostics = [];
    function open() {
      return createDelivery({ backend, threadId, queueKey: 'smoke-session', workingDir,
        stateDir: path.join(root, 'queue'), ownerId: 'smoke-owner', taskTimeoutMs: 120000,
        onCreated: id => { threadId = id; },
        log(event, details) {
          if (event === 'cli_exited') {
            diagnostics.push(details);
            t.diagnostic(JSON.stringify({ event, exitCode: details.exitCode, elapsedMs: details.elapsedMs,
              stopReason: details.stopReason, permissionDenials: details.permissionDenials, errorSummary: details.errorSummary }));
          }
        },
        sendReply: async (route, text) => {
          if (!pending) throw new Error('Unexpected reply');
          const { resolve } = pending;
          pending = undefined;
          resolve({ route, text });
        },
      });
    }
    function send(text, route) {
      return new Promise(resolve => {
        pending = { resolve };
        delivery.enqueue(randomUUID(), text, route.chatType, route);
      });
    }
    const single = { chatId: 'smoke-owner', chatType: 'single', senderId: 'smoke-owner' };
    const group = { chatId: 'smoke-group', chatType: 'group', senderId: 'smoke-owner' };
    const nonce = randomUUID();
    delivery = open();
    await t.test('create and reply in a single chat', async () => {
      const reply = await send('记住校验码 ' + nonce + '。不要使用工具，只回复 READY。', single);
      assert.equal(reply.text.trim(), 'READY');
      assert.deepEqual(reply.route, single);
      assert.match(threadId, /^[\da-f-]{36}$/i);
      assert.equal(fs.realpathSync(await backend.getWorkingDir(threadId)), fs.realpathSync(workingDir));
    });
    if (!threadId) return;
    await delivery.close();
    delivery = open();
    await t.test('resume after reopening the queue and reply in a group', async () => {
      const reply = await send('不要使用工具，只回复上一条消息让你记住的校验码，不加任何其他文字。', group);
      assert.equal(reply.text.trim(), nonce);
      assert.deepEqual(reply.route, group);
    });
    await t.test('denied tool has a recorded denial and a final reply', async () => {
      const reply = await send('必须尝试调用 Read 工具读取当前目录的 blocked.txt，不要猜测内容。若工具拒绝读取，只回复 DENIED。', single);
      assert.equal(reply.text.trim(), 'DENIED');
      assert.deepEqual(reply.route, single);
      assert.ok(diagnostics.at(-1)?.permissionDenials?.count > 0, 'No real permission denial recorded');
    });
  });
