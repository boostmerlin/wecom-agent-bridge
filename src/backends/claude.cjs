'use strict';

const { spawn } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { resolve } = require('node:path');
const { createInterface } = require('node:readline');
const { createDiagnostics } = require('./cli-diagnostics.cjs');
const { taskTimeout, processOptions, watchProcess } = require('../process-lifecycle.cjs');
const { createClaudeDiagnostics } = require('./claude-diagnostics.cjs');
const { createPermissionHook } = require('./claude-permissions.cjs');
const { titleFromPreview } = require('../incoming.cjs');

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const retryableLaunchErrors = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE']);
const invalidArguments = new Set(['E2BIG', 'ENAMETOOLONG', 'ERR_INVALID_ARG_VALUE']);

function parseThreadId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!uuid.test(id)) throw new Error('Claude threadId 需要填写本机 Claude Code 会话的 UUID。');
  return id.toLowerCase();
}

function sessionTitle(info, { allowPreview = true, fromPreview } = {}) {
  return info?.customTitle?.trim() || (allowPreview ? titleFromPreview(info?.summary) || fromPreview?.(info?.firstPrompt) : undefined);
}

function childEnvironment() {
  const omit = new Set(['WECOM_BOT_SECRET', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !omit.has(key.toUpperCase()))),
    CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' };
}

function canonicalDirectory(directory) {
  const value = realpathSync(resolve(directory));
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function launchFailure(child, error) {
  if (!child?.pid && retryableLaunchErrors.has(error.code)) return { state: 'queued', reason: error.code };
  if (!child?.pid && invalidArguments.has(error.code)) return { state: 'rejected', reason: error.code };
  return { state: 'uncertain', reason: 'cli_outcome_unknown' };
}

// The SDK is used only for local transcript metadata. Execution uses the user's CLI.
function createClaudeBackend({ claudePath, execute = spawn, loadSessions = () => import('@anthropic-ai/claude-agent-sdk') }) {
  const cli = typeof claudePath === 'string' ? { file: claudePath, prefix: [] } : claudePath;
  if (typeof cli?.file !== 'string' || !cli.file.trim() ||
      (cli.prefix !== undefined && (!Array.isArray(cli.prefix) || cli.prefix.some(value => typeof value !== 'string')))) {
    throw new Error('Missing Claude executable');
  }
  let sessions;
  const metadata = () => sessions ??= Promise.resolve().then(loadSessions);
  async function sessionInfo(id) {
    return (await metadata()).getSessionInfo(parseThreadId(id));
  }
  async function submit({ workingDir, threadId, prompt, onCreated, onStarted, onDiagnostic, onWarning, onApproval, signal, timeoutMs }, external = false) {
    timeoutMs = taskTimeout(timeoutMs);
    if (signal?.aborted) return { state: 'uncertain', reason: 'task_cancelled' };
    if (threadId) threadId = parseThreadId(threadId);
    const expectedDirectory = canonicalDirectory(workingDir);
    const args = [...(cli.prefix || []), '--print', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', external ? 'auto' : 'bypassPermissions', '--permission-prompts', 'none'];
    if (external) args.push('--no-session-persistence');
    const hook = onApproval && await createPermissionHook({ workingDir, sessionId: () => threadId, onApproval, signal });
    if (hook) args.push('--settings', JSON.stringify(hook.settings));
    if (threadId) args.push('--resume', threadId);
    const diagnostics = createDiagnostics('print', prompt, onDiagnostic);
    const telemetry = createClaudeDiagnostics(onWarning);
    const startedAt = performance.now();
    return new Promise(resolveResult => {
      let child, launchError, inputFailed = false, initialized = false, result, protocolError;
      function invalid(reason) {
        protocolError ||= reason;
        child.kill();
      }
      try {
        child = execute(cli.file, args, { ...processOptions, shell: false, windowsHide: true, cwd: workingDir,
          env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        diagnostics.report(null, null, error);
        return resolveResult(launchFailure(child, error));
      }
      child.on('error', error => { launchError = error; });
      child.stdin.on('error', error => { inputFailed = true; diagnostics.error(error.message); });
      const lifecycle = watchProcess(child, { signal, timeoutMs, onStop: () => hook?.close() });
      child.stderr.on('data', chunk => diagnostics.capture(chunk.toString('utf8')));
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
        if (!line.trim() || protocolError) return;
        let event;
        try { event = JSON.parse(line); }
        catch { invalid('invalid_claude_output'); return; }
        if (!event || typeof event !== 'object') { invalid('invalid_claude_output'); return; }
        // Do not publish subagent replies or progress as the final answer.
        if (event.parent_tool_use_id) return;
        telemetry.observe(event);
        if (event.type === 'system' && event.subtype === 'init') {
          let id;
          try {
            id = parseThreadId(event.session_id);
            if (typeof event.cwd !== 'string' || canonicalDirectory(event.cwd) !== expectedDirectory) {
              invalid('unexpected_working_directory'); return;
            }
          } catch { invalid('invalid_claude_session'); return; }
          if (initialized || (threadId && id !== threadId)) { invalid('unexpected_thread'); return; }
          initialized = true;
          if (!threadId) {
            threadId = id;
            try { onCreated(id); }
            catch { invalid('session_binding_failed'); return; }
          }
          try { onStarted(); }
          catch { invalid('session_start_failed'); }
        } else if (event.type === 'result') {
          if (result) { invalid('multiple_claude_results'); return; }
          if (!initialized && !event.startup_failure_reason) { invalid('missing_claude_init'); return; }
          result = event;
          if (event.is_error || event.subtype !== 'success') {
            diagnostics.error(Array.isArray(event.errors) ? event.errors.join('\n') : event.result);
          }
          if (initialized && event.session_id !== threadId) invalid('unexpected_thread');
        }
      });
      child.once('close', (code, signal) => {
        diagnostics.report(code, signal, launchError, { elapsedMs: Math.round(performance.now() - startedAt),
          ...telemetry.stats, ...(lifecycle.reason && { stopReason: lifecycle.reason }) });
        if (lifecycle.reason) return resolveResult({ state: 'uncertain', reason: lifecycle.reason });
        if (launchError) return resolveResult(launchFailure(child, launchError));
        if (protocolError) return resolveResult({ state: 'uncertain', reason: protocolError });
        // A structured pre-session startup failure confirms no turn was accepted.
        if (!initialized && !inputFailed && result?.is_error === true && result.num_turns === 0 &&
            typeof result.startup_failure_reason === 'string' && result.startup_failure_reason) {
          return resolveResult({ state: 'rejected', reason: 'claude_startup_failed' });
        }
        if (code === 0 && !signal && initialized && !inputFailed && result?.subtype === 'success' &&
            result.is_error === false && result.session_id === threadId &&
            typeof result.result === 'string' && result.result.trim()) {
          return resolveResult({ state: 'completed', text: result.result });
        }
        resolveResult({ state: 'uncertain', reason: result?.is_error || (typeof result?.subtype === 'string' && result.subtype.startsWith('error_'))
          ? 'claude_turn_failed' : 'claude_outcome_unknown' });
      });
      child.stdin.end(prompt, 'utf8');
    }).finally(() => hook?.close());
  }
  return {
    id: 'claude',
    name: 'Claude Code',
    supportsCancellation: true,
    eventMessages: { delivery_rejected: 'Claude Code 未接受任务。' },
    parseThreadId,
    async getWorkingDir(id) {
      const info = await sessionInfo(id);
      if (!info?.cwd) throw new Error('找不到 Claude 会话的工作目录，请选择本机已有会话。');
      return info.cwd;
    },
    async getThreadTitle(id, options) {
      return sessionTitle(await sessionInfo(id), options);
    },
    async listThreads(workingDir, { allowPreview = true } = {}) {
      const rows = await (await metadata()).listSessions({ dir: workingDir, includeWorktrees: false });
      return rows.filter(row => !row.archived && uuid.test(row.sessionId))
        .map(row => ({ id: row.sessionId.toLowerCase(), name: sessionTitle(row, { allowPreview, fromPreview: titleFromPreview }) }));
    },
    submit,
    // External messages never inherit an owner conversation or its approval callback.
    submitExternal: turn => submit({ ...turn, threadId: undefined, onCreated() {}, onApproval: undefined }, true),
  };
}

module.exports = { createClaudeBackend, parseThreadId };
