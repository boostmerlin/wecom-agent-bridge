'use strict';

const { createInterface } = require('node:readline');
const { createDiagnostics } = require('./cli-diagnostics.cjs');
const { createCodexApprovals } = require('./codex-permissions.cjs');
const { processOptions, watchProcess, taskTimeout } = require('../process-lifecycle.cjs');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// This connection owns execution and approvals. Never hand its task to a desktop queue.
function runCodexSession(execute, codexPath, turn, env) {
  const { workingDir, prompt, signal, onApproval, onDiagnostic } = turn;
  const timeoutMs = taskTimeout(turn.timeoutMs);
  if (signal?.aborted) return Promise.resolve({ state: 'uncertain', reason: 'task_cancelled' });
  const diagnostics = createDiagnostics('app-server', prompt, onDiagnostic);
  const startedAt = performance.now();
  const policy = { approvalPolicy: 'on-request', approvalsReviewer: 'user' };
  const args = ['app-server', '--stdio', '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="user"',
    '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true'];
  if (process.platform === 'win32') args.push('-c', 'windows.sandbox="elevated"');
  return new Promise(resolve => {
    let child, lifecycle, approvals, threadId = turn.threadId, turnId, result, launchError;
    let closed = false, submitted = false, sequence = 0, cleanupTimer;
    const waiting = new Map(), early = [], finals = new Map();
    const cleanup = new AbortController();
    const abort = () => approvals?.close();
    function write(message) {
      if (closed || child.stdin.destroyed || child.stdin.writableEnded) return;
      child.stdin.write(JSON.stringify(message) + '\n');
    }
    function finish(outcome) {
      if (result || closed) return;
      result = outcome;
      approvals?.close();
      child.stdin.end();
      // EOF normally exits app-server; stop its whole process tree if it does not.
      cleanupTimer = setTimeout(() => cleanup.abort(), 1000);
      cleanupTimer.unref();
    }
    function request(method, params) {
      return new Promise((resolve, reject) => {
        const id = 'bridge-' + ++sequence;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(method + ' response timed out'));
        }, 30000);
        waiting.set(id, { resolve, reject, timer });
        write({ id, method, params });
      });
    }
    function event(message) {
      const p = message.params;
      if (message.id != null) {
        if (!approvals?.request(message)) {
          // Interactive questions, dynamic tools and unknown protocol requests cannot be
          // represented by a binary WeCom approval. Return an error instead of granting them.
          write({ id: message.id, error: { code: -32601, message: 'Unsupported bridge request' } });
          turn.onWarning?.({ reason: 'unsupported_codex_request', method: message.method });
        }
        return;
      }
      approvals?.observe(message);
      if (p?.threadId !== threadId || (p.turnId ?? p.turn?.id) !== turnId) return;
      const remember = item => {
        if (item?.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string' && item.text.trim()) finals.set(item.id, item.text);
      };
      if (message.method === 'item/completed') remember(p.item);
      if (message.method === 'turn/completed') {
        for (const item of p.turn.items || []) remember(item);
        if (p.turn.status === 'completed' && finals.size === 1) finish({ state: 'completed', text: [...finals.values()][0] });
        else {
          diagnostics.error(p.turn.error?.message);
          finish({ state: 'uncertain', reason: p.turn.status === 'completed' ? 'missing_final_answer' : 'turn_failed' });
        }
      }
    }
    try {
      child = execute(codexPath, args, { ...processOptions, shell: false, windowsHide: true, cwd: workingDir,
        env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      diagnostics.report(null, null, error);
      resolve({ state: 'rejected', reason: 'cli_launch_failed' });
      return;
    }
    lifecycle = watchProcess(child, { signal: signal ? AbortSignal.any([signal, cleanup.signal]) : cleanup.signal,
      timeoutMs, onStop: () => approvals?.close() });
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', error => { launchError = error; });
    child.stdin.on('error', error => { diagnostics.error(error.message); cleanup.abort(); });
    child.stderr.on('data', chunk => diagnostics.capture(chunk.toString('utf8')));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== 'object' || result || closed) return;
      if (!message.method) {
        const pending = waiting.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        waiting.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message), { rpc: true }));
        else pending.resolve(message.result);
        return;
      }
      if (submitted && !turnId) {
        if (early.length >= 1024) finish({ state: 'uncertain', reason: 'invalid_codex_events' });
        else early.push(message);
      } else event(message);
    });
    child.once('close', (code, exitSignal) => {
      closed = true;
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', abort);
      approvals?.close();
      for (const pending of waiting.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Codex connection closed'));
      }
      waiting.clear();
      const stopReason = lifecycle.reason && !result ? lifecycle.reason : undefined;
      diagnostics.report(code, exitSignal, launchError, { elapsedMs: Math.round(performance.now() - startedAt), ...(stopReason && { stopReason }) });
      resolve(result || { state: submitted ? 'uncertain' : 'rejected', reason: stopReason || 'cli_connection_closed' });
    });
    void (async () => {
      try {
        await request('initialize', { clientInfo: { name: 'wecom-agent-bridge', version: '1.0.0' },
          capabilities: { experimentalApi: true, requiredHumanApproval: true } });
        if (closed || lifecycle.reason) return;
        write({ method: 'initialized', params: {} });
        const target = await request(threadId ? 'thread/resume' : 'thread/start', {
          ...(threadId ? { threadId, excludeTurns: true } : {}), cwd: workingDir, ...policy, sandbox: 'workspace-write',
        });
        if (!uuid.test(target?.thread?.id) || (threadId && target.thread.id !== threadId)) throw new Error('Unexpected Codex thread');
        if (!threadId) { threadId = target.thread.id; turn.onCreated?.(threadId); }
        if (closed || signal?.aborted || lifecycle.reason) return;
        submitted = true;
        const started = await request('turn/start', { threadId, cwd: workingDir, ...policy,
          clientUserMessageId: turn.replyToken,
          sandboxPolicy: { type: 'workspaceWrite', writableRoots: [workingDir], networkAccess: true,
            excludeTmpdirEnvVar: true, excludeSlashTmp: true }, input: [{ type: 'text', text: prompt }] });
        if (closed || signal?.aborted || lifecycle.reason) return;
        if (!started?.turn?.id || typeof started.turn.id !== 'string') throw new Error('Missing Codex turn');
        turnId = started.turn.id;
        approvals = createCodexApprovals({ threadId, turnId, workingDir, onApproval,
          respond: (id, response) => { if (!signal?.aborted && !lifecycle.reason) write({ id, result: response }); } });
        turn.onStarted?.();
        for (const message of early) { if (!result && !closed) event(message); }
        early.length = 0;
      } catch (error) {
        diagnostics.error(error.message);
        finish({ state: submitted ? 'uncertain' : 'rejected',
          reason: !submitted && error.rpc && /already has an active writer/i.test(error.message) ? 'thread_busy' :
            submitted ? 'turn_outcome_unknown' : 'codex_session_failed' });
      }
    })();
  });
}

module.exports = { runCodexSession };
