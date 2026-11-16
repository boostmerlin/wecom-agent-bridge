'use strict';

const { spawn } = require('node:child_process');
const { isAbsolute } = require('node:path');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
const { createDiagnostics } = require('./cli-diagnostics.cjs');

const header = /^(?:来自企业微信：\r?\n)?\[wecom-request:([0-9a-f]{32})\](?=\r?\n|$)/;

const footer = /桥接自动回发，请勿代发或复述标记。\r?\n\[wecom-request:([0-9a-f]{32})\]$/;

function openReader(codexPath, workingDir, execute, timeoutMs, diagnosticOptions) {
  const diagnostics = diagnosticOptions && createDiagnostics('app-server', diagnosticOptions.prompt, diagnosticOptions.onDiagnostic);
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.toUpperCase() !== 'WECOM_BOT_SECRET'));
  const child = execute(codexPath, ['app-server', '--stdio'], {
    cwd: workingDir, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', diagnostics ? 'pipe' : 'ignore'],
  });
  child.stderr?.on('data', chunk => diagnostics?.capture(chunk.toString('utf8')));
  child.on('close', (code, signal) => diagnostics?.report(code, signal));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let nextId = 0, pending, closed = false;
  function disconnected() {
    closed = true;
    pending?.reject(new Error('Codex reply reader disconnected'));
  }
  child.on('error', disconnected);
  child.on('close', disconnected);
  child.stdin.on('error', disconnected);
  child.stdout.on('error', disconnected);
  lines.on('line', line => {
    if (!pending) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== pending.id) return;
    if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
    else {
      diagnostics?.error(message.error?.message);
      pending.reject(new Error('Codex app-server request failed'));
    }
  });

  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  async function request(method, params) {
    if (closed) throw new Error('Codex reply reader disconnected');
    const id = ++nextId;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending = { id, resolve, reject };
        timer = setTimeout(() => reject(new Error('Codex reply read timed out')), timeoutMs);
        send({ id, method, params });
      });
    } finally {
      clearTimeout(timer);
      pending = null;
    }
  }
  return {
    async initialize() {
      await request('initialize', {
        clientInfo: { name: 'wecom-codex-bridge', version: '1.0' },
        capabilities: { experimentalApi: true },
      });
      send({ method: 'initialized' });
    },
    request,
    close() { lines.close(); child.stdin.end(); child.kill(); },
  };
}

function inspectTurn(turn, wanted, observations) {
  if (turn.itemsView !== 'full' || !Array.isArray(turn.items) || !turn.id) {
    throw new Error('Codex returned incomplete history');
  }
  const users = turn.items.filter(item => item.type === 'userMessage');
  const tokens = new Set();
  for (const user of users) {
    const clientKey = 'client:' + user.clientId;
    if (user.clientId && wanted.has(clientKey)) tokens.add(clientKey);
    if (user.clientId && wanted.has(user.clientId)) tokens.add(user.clientId);
    // Earlier releases embedded the correlation token in the prompt.
    const first = user.content?.[0];
    const token = first?.type === 'text' && typeof first.text === 'string' &&
      (header.exec(first.text) ?? footer.exec(first.text))?.[1];
    if (wanted.has(token)) tokens.add(token);
  }
  if (!tokens.size) return;

  let verdict = {};
  if (turn.status === 'failed' || turn.status === 'interrupted') {
    // A separate app-server may infer "interrupted" for an unfinished desktop turn.
    // Only an ended turn with a recorded structured error is evidence of failure.
    if (Number.isFinite(turn.completedAt) && turn.error?.codexErrorInfo != null &&
        typeof turn.error.message === 'string' && turn.error.message.trim()) {
      verdict = { reason: 'turn_failed' };
    }
  } else if (turn.status === 'completed') {
    const finals = turn.items.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer'
      && item.delivery !== 'async');
    if (users.length === 1 && users[0].content.length === 1 && finals.length === 1 &&
        turn.items.indexOf(finals[0]) > turn.items.indexOf(users[0]) &&
        typeof finals[0].text === 'string' && finals[0].text.trim()) {
      verdict = { text: finals[0].text };
    } else {
      verdict = { reason: 'ambiguous_turn' };
    }
  }
  for (const token of tokens) {
    if (!observations.has(token)) observations.set(token, new Map());
    observations.get(token).set(turn.id, verdict);
  }
}

function createReplyReader({ codexPath, threadId, workingDir, execute = spawn, timeoutMs = 30_000 }) {
  return async function readReplies(tokens) {
    const wanted = new Set(tokens);
    const replies = new Map();
    replies.unresolved = new Map();
    if (!wanted.size) return replies;
    const reader = openReader(codexPath, workingDir, execute, timeoutMs);
    const observations = new Map();
    try {
      await reader.initialize();
      let cursor;
      const visited = new Set();
      do {
        const page = await reader.request('thread/turns/list', {
          threadId, itemsView: 'full', sortDirection: 'desc', limit: 8, ...(cursor && { cursor }),
        });
        if (!Array.isArray(page?.data)) throw new Error('Invalid Codex reply history page');
        for (const turn of page.data) inspectTurn(turn, wanted, observations);
        cursor = page.nextCursor;
        if (cursor != null && (typeof cursor !== 'string' || !cursor || visited.has(cursor))) {
          throw new Error('Invalid Codex reply history cursor');
        }
        visited.add(cursor);
      } while (cursor);
    } finally {
      reader.close();
    }
    for (const [token, matches] of observations) {
      const results = [...matches.values()];
      if (results.some(result => !result.reason && !result.text)) continue;
      if (results.length > 1) replies.unresolved.set(token, 'ambiguous_turn');
      else if (results[0].reason) replies.unresolved.set(token, results[0].reason);
      else replies.set(token, results[0].text);
    }
    return replies;
  };
}

async function listThreads({ codexPath, workingDir, execute = spawn, timeoutMs = 30_000 }) {
  const reader = openReader(codexPath, workingDir, execute, timeoutMs);
  const threads = new Map();
  const visited = new Set();
  try {
    await reader.initialize();
    let cursor;
    do {
      const page = await reader.request('thread/list', {
        cwd: workingDir, archived: false, sortKey: 'updated_at', sortDirection: 'desc',
        limit: 50, ...(cursor && { cursor }),
      });
      if (!Array.isArray(page?.data)) throw new Error('Invalid Codex thread list');
      for (const { id, name } of page.data) threads.set(id, { id, name });
      cursor = page.nextCursor;
      if (cursor != null && (typeof cursor !== 'string' || !cursor || visited.has(cursor))) {
        throw new Error('Invalid Codex thread list cursor');
      }
      visited.add(cursor);
    } while (cursor);
    return [...threads.values()];
  } finally {
    reader.close();
  }
}

async function readThread({ codexPath, threadId, execute = spawn, timeoutMs = 30_000 }) {
  const reader = openReader(codexPath, undefined, execute, timeoutMs);
  try {
    await reader.initialize();
    const { thread } = await reader.request('thread/read', { threadId, includeTurns: false });
    if (thread?.id?.toLowerCase() !== threadId.toLowerCase()) throw new Error('Unexpected Codex thread ID');
    return thread;
  } finally {
    reader.close();
  }
}

async function readThreadCwd(options) {
  const { cwd } = await readThread(options);
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Codex did not return an absolute directory');
  return cwd;
}

async function queueMessage({ codexPath, workingDir, threadId, prompt, replyToken,
  execute = spawn, timeoutMs = 30_000, onDiagnostic }) {
  let reader;
  const clientId = replyToken || randomUUID();
  try {
    reader = openReader(codexPath, workingDir, execute, timeoutMs, { prompt, onDiagnostic });
    await reader.initialize();
    const { queuedSubmission } = await reader.request('thread/queue/add', {
      threadId, clientUserMessageId: clientId, input: [{ type: 'text', text: prompt }],
    });
    if (typeof queuedSubmission?.id !== 'string' || !queuedSubmission.id.trim() || queuedSubmission.clientUserMessageId !== clientId) {
      throw new Error('Unexpected queue receipt');
    }
    return { state: 'accepted', queueId: queuedSubmission.id, replyId: clientId, wakeConfirmed: false };
  } catch {
    // The add may have committed before the connection broke. Never submit again.
    return { state: 'uncertain', reason: 'queue_outcome_unknown' };
  } finally {
    reader?.close();
  }
}

module.exports = { createReplyReader, readThread, readThreadCwd, listThreads, queueMessage };
