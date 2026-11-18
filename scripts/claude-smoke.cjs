'use strict';

// Opt-in only: uses the local Claude login and makes real model requests.
// The reply transport is local; no WeCom credentials or production state are used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createClaudeBackend } = require('../src/backends/claude.cjs');
const { resolveClaude } = require('../src/launcher-tools.cjs');
const { createDelivery } = require('../src/delivery.cjs');
const { createApprovals } = require('../src/approvals.cjs');

test('real Claude creates a session, resumes context, denies a tool and returns finals to the original routes',
  { timeout: 420000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-claude-smoke-'));
    const workingDir = path.join(root, 'project');
    fs.mkdirSync(workingDir);
    fs.writeFileSync(path.join(workingDir, 'blocked.txt'), 'This file must not be read by the smoke test.');
    const settings = path.join(root, 'settings.json');
    const smokeSettings = { permissions: { allow: ['Read'], deny: ['Read(./blocked.txt)'],
      ask: ['Edit(./approval-allowed.txt)', 'Edit(./approval-denied.txt)'] } };
    fs.writeFileSync(settings, JSON.stringify(smokeSettings));
    let delivery, pending, threadId, approvals, decision = 'deny', approvalCount = 0;
    t.after(async () => {
      await delivery?.close();
      approvals?.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const cli = await resolveClaude();
    const prefix = [...cli.prefix, '--settings', settings,
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--tools', 'Read,Write'];
    if (process.env.CLAUDE_SMOKE_MODEL) prefix.push('--model', process.env.CLAUDE_SMOKE_MODEL);
    const backend = createClaudeBackend({ claudePath: { ...cli, prefix }, execute(file, args, options) {
      // Combine the test's isolated rules with the per-turn hook in one --settings value.
      const index = args.lastIndexOf('--settings');
      if (args[index + 1] !== settings) {
        const hooks = JSON.parse(args[index + 1]);
        args = [...args];
        args[index + 1] = JSON.stringify({ ...smokeSettings, ...hooks });
      }
      return spawn(file, args, options);
    } });
    approvals = createApprovals({ ownerId: 'smoke-owner', sendReply: async (route, text) => {
      assert.equal(route.senderId, 'smoke-owner');
      const id = text.match(/审批 ([a-f0-9]{12})/)[1];
      approvalCount++;
      setTimeout(() => approvals.respond(route, decision, id), 20);
    } });
    const diagnostics = [];
    function open() {
      return createDelivery({ backend, threadId, queueKey: 'smoke-session', workingDir,
        stateDir: path.join(root, 'queue'), ownerId: 'smoke-owner', taskTimeoutMs: 120000,
        requestApproval: request => approvals.request(request),
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
    await t.test('owner can write without a tool approval rule', async () => {
      const reply = await send('使用 Write 工具在当前目录创建 autonomous.txt，内容为 ' + nonce + '。完成后只回复 WRITTEN。', single);
      assert.equal(reply.text.trim(), 'WRITTEN');
      assert.deepEqual(reply.route, single);
      assert.equal(fs.readFileSync(path.join(workingDir, 'autonomous.txt'), 'utf8').trim(), nonce);
      assert.equal(diagnostics.at(-1)?.permissionDenials?.count || 0, 0);
    });
    await t.test('denied tool has a recorded denial and a final reply', async () => {
      const reply = await send('必须尝试调用 Read 工具读取当前目录的 blocked.txt，不要猜测内容。若工具拒绝读取，只回复 DENIED。', single);
      assert.equal(reply.text.trim(), 'DENIED');
      assert.deepEqual(reply.route, single);
      assert.ok(diagnostics.at(-1)?.permissionDenials?.count > 0, 'No real permission denial recorded');
    });
    await t.test('owner bypass permissions allow writing outside the working directory', async () => {
      const output = path.join(root, 'owner-outside.txt');
      const before = approvalCount;
      const reply = await send('使用 Write 工具写入 ' + JSON.stringify(output) +
        '，内容为 ' + nonce + '。不要操作其他文件，完成后只回复 WRITTEN。', single);
      assert.equal(reply.text.trim(), 'WRITTEN');
      assert.equal(fs.readFileSync(output, 'utf8').trim(), nonce);
      assert.equal(approvalCount, before);
    });
    await t.test('non-owner auto task executes independently and preserves policy denials', async () => {
      const guest = { ...group, senderId: 'smoke-guest' };
      const before = approvalCount, ownerThread = threadId;
      const reply = await send('用 Read 读取 autonomous.txt，只回复文件内容。', guest);
      assert.equal(reply.text.trim(), nonce);
      assert.deepEqual(reply.route, guest);
      const blocked = await send('尝试用 Read 读取 blocked.txt。如果权限拒绝，不得换工具或重试，只回复 DENIED。', guest);
      assert.equal(blocked.text.trim(), 'DENIED');
      assert.ok(diagnostics.at(-1)?.permissionDenials?.count > 0);
      assert.equal(approvalCount, before);
      assert.equal(threadId, ownerThread);
    });
    await t.test('approval resumes the same real CLI and rejection prevents the write', async () => {
      decision = 'approve';
      const before = approvalCount;
      const allowed = await send('使用 Write 工具创建 approval-allowed.txt，内容为 ' + nonce + '。不要调用其他工具，成功后只回复 APPROVED。', group);
      assert.equal(allowed.text.trim(), 'APPROVED');
      assert.deepEqual(allowed.route, group);
      assert.equal(fs.readFileSync(path.join(workingDir, 'approval-allowed.txt'), 'utf8').trim(), nonce);
      assert.ok(approvalCount > before, 'No real permission request received');
      decision = 'deny';
      const deniedBefore = approvalCount;
      const rejected = await send('尝试用 Write 工具创建 approval-denied.txt，内容为 test。如果审批拒绝，不要重试或换工具，只回复 REJECTED。', single);
      assert.equal(rejected.text.trim(), 'REJECTED');
      assert.ok(!fs.existsSync(path.join(workingDir, 'approval-denied.txt')));
      assert.ok(approvalCount > deniedBefore, 'No real denial request received');
    });
  });
