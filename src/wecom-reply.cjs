'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveWecom, readIdentity } = require('./launcher-tools.cjs');

const execute = promisify(execFile);
const MAX_REPLY_BYTES = 6144;

class ReplyError extends Error {
  constructor(code, message, outcome = 'not_sent', businessCode) {
    super(message);
    this.name = 'ReplyError';
    this.code = code;
    this.outcome = outcome;
    this.uncertain = outcome === 'uncertain';
    this.definitelyUnsent = outcome === 'not_sent';
    const recoverable = new Set([
      'REPLY_CLI_UNAVAILABLE', 'REPLY_RESPONSE_UNREADABLE', 'REPLY_CLI_FAILED',
      'REPLY_IDENTITY_UNVERIFIED', 'REPLY_SESSIONS_UNAVAILABLE',
      'REPLY_SESSIONS_UNREADABLE', 'REPLY_ROUTE_UNMAPPED',
    ]);
    // Retry policy remains with the persistent queue, including its retry cap.
    // Authorization expiry/ungranted access can recover after user action;
    // corporation-ineligible errors and unknown business rejections are not retried.
    this.temporary = this.definitelyUnsent && (recoverable.has(code) ||
      (code === 'REPLY_REJECTED' && [850003, 851008, 853004, 45009].includes(businessCode)));
    if (businessCode !== undefined) this.businessCode = businessCode;
  }
}

// No shell, console logging, or raw child errors: CLI 1.3.4 accepts JSON only
// as an argument. Keep each message small enough for the Windows command line.
async function runCli(cli, args) {
  try {
    const { stdout } = await execute(cli.file, [...cli.prefix, ...args], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
    });
    return { exitCode: 0, stdout };
  } catch (error) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : null,
      spawnError: typeof error.code === 'string' ? error.code : null,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
    };
  }
}

function parseResult(result, sending) {
  const outcome = sending ? 'uncertain' : 'not_sent';
  if (['ENOENT', 'EACCES', 'ENOEXEC', 'EINVAL', 'E2BIG', 'ENAMETOOLONG'].includes(result.spawnError)) {
    throw new ReplyError('REPLY_CLI_UNAVAILABLE', 'WeCom CLI could not be started. No message was sent.');
  }
  let response;
  try { response = JSON.parse(result.stdout.replace(/^\uFEFF/, '')); }
  catch { throw new ReplyError('REPLY_RESPONSE_UNREADABLE', 'WeCom CLI did not return a verifiable JSON response.', outcome); }
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new ReplyError('REPLY_RESPONSE_UNREADABLE', 'WeCom CLI returned an unexpected response.', outcome);
  }
  // A positive backend error is an explicit rejection. Transport errors or a
  // contradictory success/exit status cannot prove that sending did not occur.
  if (response.success !== true && Number.isInteger(response.errcode) && response.errcode > 0) {
    throw new ReplyError('REPLY_REJECTED', 'WeCom rejected the operation. Check the relevant authorization.', 'not_sent', response.errcode);
  }
  if (result.exitCode !== 0 || response.error) {
    throw new ReplyError('REPLY_CLI_FAILED', 'WeCom CLI did not confirm the operation.', outcome);
  }
  return response;
}

function createWecomSender({ botId, ownerId, resolveCli = resolveWecom, identity = readIdentity, invoke = runCli } = {}) {
  if (typeof botId !== 'string' || !botId || typeof ownerId !== 'string' || !ownerId) {
    throw new ReplyError('REPLY_CONFIG_INVALID', 'The verified WeCom bot and owner are required.');
  }
  return async function sendReply(route, text) {
    if (!route || !['single', 'group'].includes(route.chatType) ||
        typeof route.chatId !== 'string' || !route.chatId ||
        typeof route.senderId !== 'string' || !route.senderId ||
        (route.chatType === 'single' && route.chatId !== route.senderId)) {
      throw new ReplyError('REPLY_ROUTE_INVALID', 'The original WeCom reply route is invalid.');
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new ReplyError('REPLY_TEXT_INVALID', 'The reply must contain text.');
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_REPLY_BYTES) {
      throw new ReplyError('REPLY_TEXT_TOO_LONG', 'Split the reply into chunks of at most 6144 UTF-8 bytes.');
    }

    let cli, current;
    try { cli = await resolveCli(); current = await identity(); }
    catch { throw new ReplyError('REPLY_IDENTITY_UNVERIFIED', 'Could not verify the current WeCom CLI identity. No message was sent.'); }
    if (current.botId !== botId || current.ownerId !== ownerId) {
      throw new ReplyError('REPLY_IDENTITY_CHANGED', 'The current WeCom bot or owner changed. No message was sent.');
    }

    let target;
    if (route.chatType === 'single' && route.senderId === current.ownerId) {
      // Official CLI permits its freshly verified owner as the direct target.
      target = current.ownerId;
    } else {
      let raw;
      try { raw = await invoke(cli, ['message', 'aibot', 'sessions', 'list']); }
      catch { throw new ReplyError('REPLY_SESSIONS_UNAVAILABLE', 'Could not verify the current WeCom sessions. No message was sent.'); }
      const sessions = parseResult(raw, false);
      if (!Array.isArray(sessions.sessions)) {
        throw new ReplyError('REPLY_SESSIONS_UNREADABLE', 'WeCom did not return a verifiable session list.');
      }
      const matches = sessions.sessions.filter(session => session.chat_type === route.chatType && session.chat_id === route.chatId);
      if (matches.length !== 1) {
        throw new ReplyError('REPLY_ROUTE_UNMAPPED', 'The original WebSocket route has no unique matching CLI session. No message was sent.');
      }
      target = matches[0].chat_id;
    }

    const body = JSON.stringify({ chat_id: target, msg_type: 'markdown', markdown: { content: text } });
    // Reserve room for Windows argument quoting, executable and npm entry paths.
    const argumentBudget = 2 * body.length + cli.file.length + cli.prefix.join(' ').length + 512;
    if (argumentBudget > 28000) {
      throw new ReplyError('REPLY_TEXT_TOO_LONG', 'The escaped reply exceeds the Windows argument budget. Split it into smaller chunks.');
    }
    let result;
    try { result = await invoke(cli, ['message', 'aibot', 'send', '--json', body]); }
    catch { throw new ReplyError('REPLY_SEND_UNCONFIRMED', 'Message delivery was not confirmed. Do not automatically resend.', 'uncertain'); }
    const response = parseResult(result, true);
    if (response.success !== true) {
      throw new ReplyError('REPLY_SEND_UNCONFIRMED', 'WeCom did not explicitly confirm message delivery. Do not automatically resend.', 'uncertain');
    }
    return { success: true };
  };
}

module.exports = { createWecomSender, MAX_REPLY_BYTES };
