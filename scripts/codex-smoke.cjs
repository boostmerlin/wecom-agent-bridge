'use strict';

// Opt-in: real Codex, isolated temporary files and a local HTTP endpoint. No WeCom sends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createCodexBackend } = require('../src/backends/codex.cjs');
const { resolveCodex } = require('../src/launcher-tools.cjs');

test('real owner Codex has full access on new and resumed threads and releases the writer', { timeout: 240000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-codex-smoke-'));
  const workingDir = path.join(root, 'project');
  fs.mkdirSync(workingDir);
  const nonce = randomUUID(), source = path.join(root, 'source.txt');
  fs.writeFileSync(source, nonce);
  let requests = 0, threadId, approvalCount = 0;
  const server = http.createServer((_req, res) => { requests++; res.end('NETWORK_OK'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const backend = createCodexBackend({ codexPath: await resolveCodex() });
  const submit = prompt => backend.submit({ workingDir, threadId, prompt, signal: controller.signal, timeoutMs: 100000,
    onCreated: id => { threadId = id; },
    onDiagnostic: d => t.diagnostic(JSON.stringify({ exitCode: d.exitCode, elapsedMs: d.elapsedMs, stopReason: d.stopReason })),
    onApproval: async () => { approvalCount++; return { behavior: 'deny' }; } });
  await t.test('new owner thread reads and writes outside cwd and reaches HTTP without approval', async () => {
    const output = path.join(root, 'created.txt');
    const result = await submit('这是临时目录中的权限测试。读取 ' + JSON.stringify(source) +
      '，记住文件中的校验码，并将原文写入 ' + JSON.stringify(output) +
      '。用本机命令请求 http://127.0.0.1:' + server.address().port +
      '/test 并确认响应 NETWORK_OK。不要请求提权，不要操作其他文件。全部完成后只回复 READY。');
    assert.equal(result.state, 'completed');
    assert.equal(result.text?.trim(), 'READY');
    assert.equal(fs.readFileSync(output, 'utf8').trim(), nonce);
    assert.ok(requests > 0);
    assert.equal(approvalCount, 0);
  });
  await t.test('next process resumes the released thread with full access and preserved context', async () => {
    assert.ok(threadId);
    const output = path.join(root, 'resumed.txt');
    const result = await submit('将上一条记住的校验码写入 ' + JSON.stringify(output) +
      '，不要重读源文件，不要请求提权。只回复校验码。');
    assert.equal(result.state, 'completed');
    assert.equal(result.text?.trim(), nonce);
    assert.equal(fs.readFileSync(output, 'utf8').trim(), nonce);
    assert.equal(approvalCount, 0);
  });
});

test('real non-owner Codex automatically reviews a sandbox permission request', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-codex-auto-'));
  const workingDir = path.join(root, 'project');
  fs.mkdirSync(workingDir);
  const controller = new AbortController();
  t.after(() => { controller.abort(); fs.rmSync(root, { recursive: true, force: true }); });
  const output = path.join(root, 'reviewed.txt');
  const command = process.platform === 'win32'
    ? "Set-Content -LiteralPath '" + output.replaceAll("'", "''") + "' -Value 'auto-review-ok'"
    : "printf auto-review-ok > '" + output.replaceAll("'", "'\\''") + "'";
  const backend = createCodexBackend({ codexPath: await resolveCodex() });
  const result = await backend.submitExternal({ workingDir, stateDir: root, replyToken: 'auto-test',
    signal: controller.signal, timeoutMs: 90000, onStarted() {},
    onDiagnostic: d => t.diagnostic(JSON.stringify({ exitCode: d.exitCode, elapsedMs: d.elapsedMs, stopReason: d.stopReason })),
    prompt: '这是临时文件权限联调。仅使用 exec_command 一次，sandbox_permissions=require_escalated，' +
      'justification 为测试临时文件写入，执行命令：' + command +
      '。如果被拒绝不要重试，只回复 DENIED；成功则只回复 WRITTEN。' });
  assert.equal(result.state, 'completed');
  assert.equal(result.text?.trim(), 'WRITTEN');
  assert.equal(fs.readFileSync(output, 'utf8').trim(), 'auto-review-ok');
});
