'use strict';

const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { realpathSync } = require('node:fs');
const { approvalTimeoutMs } = require('../approvals.cjs');

// A per-turn HTTP hook keeps the CLI's ordinary permission checks and transport.
// Its capability expires with the process; no hook or permission is written to disk.
async function createPermissionHook({ workingDir, sessionId, onApproval, signal }) {
  const token = 'Bearer ' + randomBytes(32).toString('hex');
  const canonical = value => {
    const dir = realpathSync(value);
    return process.platform === 'win32' ? dir.toLowerCase() : dir;
  };
  const directory = canonical(workingDir);
  const requests = new Set();
  const server = http.createServer((req, res) => {
    const finish = (status, data) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); } };
    if (req.method !== 'POST' || req.url !== '/approval' || req.headers.authorization !== token) {
      finish(403, {}); return;
    }
    const controller = new AbortController();
    requests.add(controller);
    res.once('close', () => { controller.abort(); requests.delete(controller); });
    void (async () => {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 128000) { finish(413, {}); return; }
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (input.hook_event_name !== 'PermissionRequest' || !sessionId() || input.session_id !== sessionId() ||
          canonical(input.cwd) !== directory || typeof input.tool_name !== 'string' || !input.tool_name ||
          !input.tool_input || typeof input.tool_input !== 'object' || Array.isArray(input.tool_input)) {
        finish(400, {}); return;
      }
      let decision = { behavior: 'deny', message: '审批不可用，本次操作未执行。' };
      // A yes/no approval cannot supply answers to an interactive questionnaire.
      if (input.tool_name !== 'AskUserQuestion' && !controller.signal.aborted) {
        const answer = await onApproval({ toolName: input.tool_name, input: input.tool_input,
          signal: controller.signal, workingDir, threadId: sessionId() });
        if (!controller.signal.aborted && answer?.behavior === 'allow') decision = { behavior: 'allow' };
        else if (answer?.behavior === 'deny') decision = { behavior: 'deny', message: answer.message || '用户拒绝了本次操作。' };
      }
      finish(200, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
    })().catch(() => finish(400, {}));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', close);
    for (const controller of requests) controller.abort();
    server.close();
    server.closeAllConnections();
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/approval';
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  return { close, settings: { hooks: { PermissionRequest: [{ hooks: [{ type: 'http', url,
    headers: { Authorization: token }, timeout: approvalTimeoutMs / 1000 + 10 }] }] } } };
}

module.exports = { createPermissionHook };
