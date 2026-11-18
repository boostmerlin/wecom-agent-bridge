'use strict';

// Opt-in: real local Codex and model requests, isolated files and simulated WeCom replies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCodexBackend } = require('../src/backends/codex.cjs');
const { resolveCodex } = require('../src/launcher-tools.cjs');
const { createApprovals } = require('../src/approvals.cjs');

test('real Codex resumes context and obeys WeCom allow/deny decisions', { timeout: 360000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-codex-smoke-'));
  const workingDir = path.join(root, 'project');
  fs.mkdirSync(workingDir);
  const backend = createCodexBackend({ codexPath: await resolveCodex() });
  const controller = new AbortController();
  let threadId, decision, expectedFile, approvalCount = 0;
  const route = { senderId: 'owner', chatType: 'group', chatId: 'test-group' };
  const approvals = createApprovals({ ownerId: 'owner', sendReply: async (to, text) => {
    assert.deepEqual(to, route);
    assert.match(text, /^Codex 审批/);
    const id = text.match(/审批 ([a-f0-9]{12})/)[1];
    approvalCount++;
    setTimeout(() => approvals.respond(route, decision, id), 20);
  } });
  t.after(() => {
    controller.abort();
    approvals.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const submit = prompt => backend.submit({ workingDir, threadId, prompt, signal: controller.signal, timeoutMs: 100000,
    onCreated: id => { threadId = id; },
    onDiagnostic: d => t.diagnostic(JSON.stringify({ exitCode: d.exitCode, elapsedMs: d.elapsedMs, stopReason: d.stopReason })),
    onApproval: details => {
      assert.ok(expectedFile && details.input.command?.includes(path.basename(expectedFile)), 'Only the requested harmless smoke command may be approved');
      return approvals.request({ ...details, backend: 'codex', route });
    } });
  const nonce = randomUUID();
  await t.test('create and resume', async () => {
    assert.equal((await submit('不要调用工具。记住校验码 ' + nonce + '，只回复 READY。')).text?.trim(), 'READY');
    assert.equal((await submit('不要调用工具。只回复上一条校验码。')).text?.trim(), nonce);
  });
  for (const allow of [true, false]) await t.test(allow ? 'allowed command writes its file' : 'denied command never writes its file', async () => {
    decision = allow ? 'approve' : 'deny';
    expectedFile = path.join(root, allow ? 'allowed.txt' : 'denied.txt');
    const command = process.platform === 'win32'
      ? "Set-Content -LiteralPath '" + expectedFile.replaceAll("'", "''") + "' -Value 'approval-smoke'"
      : "printf approval-smoke > '" + expectedFile.replaceAll("'", "'\\''") + "'";
    const before = approvalCount;
    const result = await submit('这是审批联调。仅调用 exec_command 一次，sandbox_permissions 必须是 require_escalated，' +
      'justification 写为“测试一次性写入授权”。执行命令：' + command +
      '。若被拒绝，禁止重试或改用其他工具。最后只回复 WRITTEN 或 DENIED。');
    assert.equal(result.state, 'completed');
    assert.ok(approvalCount > before, 'A real Codex approval must reach the simulated WeCom chat');
    assert.equal(fs.existsSync(expectedFile), allow);
    if (allow) assert.equal(fs.readFileSync(expectedFile, 'utf8').trim(), 'approval-smoke');
    assert.equal(result.text.trim(), allow ? 'WRITTEN' : 'DENIED');
  });
});
