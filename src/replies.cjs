'use strict';

const { randomBytes } = require('node:crypto');
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const replyCodes = new Set([
  'REPLY_CLI_FAILED', 'REPLY_CLI_UNAVAILABLE', 'REPLY_CONFIG_INVALID', 'REPLY_IDENTITY_CHANGED',
  'REPLY_IDENTITY_UNVERIFIED', 'REPLY_REJECTED', 'REPLY_RESPONSE_UNREADABLE', 'REPLY_ROUTE_INVALID',
  'REPLY_ROUTE_UNMAPPED', 'REPLY_SEND_UNCONFIRMED', 'REPLY_SESSIONS_UNAVAILABLE', 'REPLY_SESSIONS_UNREADABLE',
  'REPLY_TEXT_INVALID', 'REPLY_TEXT_TOO_LONG',
]);

function* splitMarkdown(text, maxBytes) {
  let chunk = '', size = 0;
  for (const { segment } of graphemes.segment(text)) {
    const bytes = Buffer.byteLength(segment);
    // Keep a grapheme together unless that grapheme alone exceeds the protocol limit.
    if (bytes <= maxBytes) {
      if (size + bytes > maxBytes) { yield chunk; chunk = ''; size = 0; }
      chunk += segment;
      size += bytes;
    } else {
      for (const scalar of segment) {
        const length = Buffer.byteLength(scalar);
        if (size + length > maxBytes) { yield chunk; chunk = ''; size = 0; }
        chunk += scalar;
        size += length;
      }
    }
  }
  if (chunk) yield chunk;
}

// readReplies/ready supply final text that the caller has selected for publication
// to this route. Tokens correlate turns; they do not confer permission to publish.
function createReplies({ db, readReplies, replyKey = id => id, missingReceiptReason = 'missing_backend_receipt', sendReply, log = () => {}, onTurnResolved = () => {},
  progressText = async () => '任务已投递，完成后会在这里回复。', progressAfterMs = 60000,
  chunkBytes = 6144, pollMs = 3000, maxPollMs = 60000, turnHoldMs = 300000, retryBaseMs = 3000 }) {
  if ((readReplies && typeof readReplies !== 'function') || typeof sendReply !== 'function') throw new TypeError('Missing reply adapter');
  if (!Number.isInteger(chunkBytes) || chunkBytes < 4 || chunkBytes > 20480) throw new RangeError('Invalid UTF-8 chunk size');
  for (const value of [pollMs, maxPollMs, turnHoldMs, retryBaseMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid reply worker interval');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS bridge_replies (
      entry INTEGER PRIMARY KEY REFERENCES messages(id), token TEXT UNIQUE NOT NULL,
      chat_type TEXT NOT NULL, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      state TEXT NOT NULL, block_until INTEGER, part INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS bridge_reply_state ON bridge_replies(state,retry_at);
    CREATE TABLE IF NOT EXISTS bridge_progress (
      entry INTEGER PRIMARY KEY, due INTEGER, started INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS pending_progress ON bridge_progress(due);
    CREATE TABLE IF NOT EXISTS bridge_reply_chunks (
      entry INTEGER NOT NULL REFERENCES bridge_replies(entry), part INTEGER NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(entry,part)
    )
  `);
  if (!db.prepare('PRAGMA table_info(bridge_replies)').all().some(column => column.name === 'queue_id')) {
    db.exec('ALTER TABLE bridge_replies ADD COLUMN queue_id TEXT');
  }
  if (!db.prepare('PRAGMA table_info(bridge_replies)').all().some(column => column.name === 'failure_reason')) {
    db.exec('ALTER TABLE bridge_replies ADD COLUMN failure_reason TEXT');
  }
  if (!db.prepare('PRAGMA table_info(bridge_progress)').all().some(column => column.name === 'deferred')) {
    db.exec('ALTER TABLE bridge_progress ADD COLUMN deferred INTEGER NOT NULL DEFAULT 0');
  }
  // Prepare once per literal. This also supports Node 24 releases before createTagStore.
  const statements = new Map();
  const query = method => (strings, ...args) => {
    if (!statements.has(strings)) statements.set(strings, db.prepare(strings.join('?')));
    return statements.get(strings)[method](...args);
  };
  const sql = { get: query('get'), all: query('all'), run: query('run') };
  // Older readers could report an interrupted desktop snapshot before the final
  // appeared. Only matching failures have no staged parts or send attempts.
  db.exec('SAVEPOINT bridge_recover_match_failures');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS bridge_reply_migrations (version INTEGER PRIMARY KEY)');
    if (sql.run`INSERT INTO bridge_reply_migrations(version) VALUES(1) ON CONFLICT DO NOTHING`.changes) {
      sql.run`UPDATE bridge_replies SET state='waiting', block_until=NULL
        WHERE state='failed' AND total=0 AND part=0 AND attempts=0 AND retry_at=0
        AND NOT EXISTS (SELECT 1 FROM bridge_reply_chunks c WHERE c.entry=bridge_replies.entry)`;
    }
    db.exec('RELEASE bridge_recover_match_failures');
  } catch (error) {
    db.exec('ROLLBACK TO bridge_recover_match_failures; RELEASE bridge_recover_match_failures');
    throw error;
  }
  let closed = false, closePromise, worker = null, timer, again = false, nextPoll = 0, pollDelay = pollMs, storageRetryAt = 0;
  const emit = (event, details) => { try { log(event, details); } catch {} };
  function released(entry, reason) {
    queueMicrotask(() => { if (!closed) { try { onTurnResolved(entry, reason); } catch {} } });
  }
  // The delivery instance holds the per-thread SQLite worker lock. A former sender
  // may have delivered the reserved part before crashing; never replay that part.
  const interrupted = sql.all`UPDATE bridge_replies SET state='uncertain' WHERE state='sending' RETURNING entry,part`;
  for (const row of interrupted) emit('reply_uncertain', { entry: row.entry, part: row.part + 1, reason: 'interrupted_send' });

  function bindQueue(entry, id) {
    sql.run`UPDATE bridge_replies SET queue_id=${id} WHERE entry=${entry}`;
  }
  function unmatched(entry, reason = missingReceiptReason, message) {
    const stopped = {
      turn_interrupted: 'Codex 已中断本次任务。任务可能已产生部分改动，请查看目标聊天。',
      desktop_queue_cancelled: '本次任务已在投递前停止，尚未发送到 Codex。',
      task_cancelled: '已取消本次任务的本地执行。已产生的改动不会撤销，桥接不会自动重跑。',
      task_timeout: '本次任务执行超时，已停止本地进程。任务可能已产生部分改动，桥接不会自动重跑。',
      bridge_stopped: '桥接停止时中断了本次任务。任务可能已产生部分改动，重启后不会自动重跑。',
    };
    const description = message || stopped[reason] || (['turn_failed', 'claude_turn_failed'].includes(reason)
      ? '处理程序报告任务失败，任务可能已产生部分改动。请查看目标聊天后决定是否重试。'
      : '桥接无法确认本次任务的结果，暂未取得可回发的答复。任务可能已开始，请查看目标聊天，避免重复执行。');
    const token = tokenFor(entry);
    return ready(entry, description + '\n记录编号：' + token, reason);
  }
  function tokenFor(entry) { return sql.get`SELECT token FROM bridge_replies WHERE entry=${entry}`?.token ?? null; }
  function register(entry, route) {
    if (closed || !db.isTransaction) throw new Error('Register replies inside the incoming message transaction');
    const { chatType, chatId, senderId } = route ?? {};
    if (!['single', 'group'].includes(chatType) || ![chatId, senderId].every(v => typeof v === 'string' && v.trim()) ||
        (chatType === 'single' && chatId !== senderId)) throw new TypeError('Invalid original reply route');
    const prior = sql.get`SELECT token,chat_type,chat_id,sender_id FROM bridge_replies WHERE entry=${entry}`;
    if (prior) {
      if (prior.chat_type !== chatType || prior.chat_id !== chatId || prior.sender_id !== senderId) throw new Error('Reply route is immutable');
      return prior.token;
    }
    const token = randomBytes(16).toString('hex');
    sql.run`INSERT INTO bridge_replies(entry,token,chat_type,chat_id,sender_id,state)
      VALUES(${entry},${token},${chatType},${chatId},${senderId},'registered')`;
    return token;
  }
  function start(entry, { blocking = true } = {}) {
    if (closed) throw new Error('Reply worker is closed');
    const deadline = blocking ? Date.now() + turnHoldMs : null;
    if (!sql.run`UPDATE bridge_replies SET state='waiting',block_until=${deadline} WHERE entry=${entry} AND state='registered'`.changes) return false;
    nextPoll = 0;
    pollDelay = pollMs;
    emit('reply_waiting', { entry });
    wake();
    return true;
  }
  function hasPendingTurn() {
    return !!sql.get`SELECT 1 FROM bridge_replies WHERE state='waiting' AND block_until>${Date.now()} LIMIT 1`;
  }
  function ready(entry, text, failureReason = null) {
    if (closed) throw new Error('Reply worker is closed');
    if (typeof text !== 'string' || !text.trim()) return false;
    const row = sql.get`SELECT state FROM bridge_replies WHERE entry=${entry}`;
    if (!row || !['registered', 'waiting'].includes(row.state)) return false;
    db.exec('SAVEPOINT bridge_stage_reply');
    let count = 0;
    try {
      for (const chunk of splitMarkdown(text, chunkBytes)) {
        sql.run`INSERT INTO bridge_reply_chunks(entry,part,body) VALUES(${entry},${count},${chunk})`;
        count++;
      }
      sql.run`UPDATE bridge_replies SET state='ready',block_until=NULL,total=${count},failure_reason=${failureReason} WHERE entry=${entry}`;
      db.exec('RELEASE bridge_stage_reply');
    } catch (error) {
      db.exec('ROLLBACK TO bridge_stage_reply; RELEASE bridge_stage_reply');
      throw error;
    }
    emit('reply_ready', { entry, parts: count, ...(failureReason && { failureReason }) });
    if (row.state === 'waiting') released(entry, failureReason || 'ready');
    wake();
    return true;
  }
  async function poll(force = false) {
    if (!readReplies) return;
    const waiting = sql.all`SELECT entry,queue_id,token FROM bridge_replies WHERE state='waiting' ORDER BY entry`;
    if (!waiting.length || (!force && nextPoll > Date.now())) return;
    let progress = false;
    try {
      const keys = waiting.map(row => row.queue_id ? replyKey(row.queue_id) : row.token);
      const results = await readReplies(keys);
      if (closed) return;
      if (!(results instanceof Map)) throw new Error('Unexpected reader result');
      for (const [index, { entry }] of waiting.entries()) {
        const token = keys[index];
        const reason = results.unresolved?.get(token);
        if (results.started?.has(token)) {
          const changed = sql.run`INSERT INTO bridge_progress(entry,started) VALUES(${entry},1)
            ON CONFLICT(entry) DO UPDATE SET started=1 WHERE started=0`.changes;
          progress = !!changed || progress;
        }
        if (reason === 'turn_failed' || reason === 'turn_interrupted' || reason === 'ambiguous_turn') {
          progress = unmatched(entry, reason) || progress;
        } else if (results.has(token)) {
          progress = ready(entry, results.get(token)) || progress;
        }
      }
    } catch { emit('reply_read_error', {}); }
    pollDelay = progress ? pollMs : Math.min(maxPollMs, pollDelay * 2);
    nextPoll = Date.now() + pollDelay;
  }
  async function sendNext() {
    const row = sql.get`SELECT r.entry,r.chat_type,r.chat_id,r.sender_id,r.part,r.total,r.attempts,r.failure_reason,c.body
      FROM bridge_replies r JOIN bridge_reply_chunks c ON c.entry=r.entry AND c.part=r.part
      WHERE r.state='ready' AND r.retry_at<=${Date.now()} ORDER BY r.entry LIMIT 1`;
    if (!row) return false;
    const details = { entry: row.entry, part: row.part + 1, parts: row.total,
      ...(row.failure_reason && { failureReason: row.failure_reason }) };
    sql.run`UPDATE bridge_replies SET state='sending' WHERE entry=${row.entry}`;
    try {
      await sendReply({ chatType: row.chat_type, chatId: row.chat_id, senderId: row.sender_id }, row.body);
    } catch (error) {
      if (replyCodes.has(error?.code)) details.code = error.code;
      if (Number.isSafeInteger(error?.businessCode) && error.businessCode >= 0 && error.businessCode <= 2147483647) {
        details.businessCode = error.businessCode;
      }
      const mappingExhausted = error?.code === 'REPLY_ROUTE_UNMAPPED' && row.attempts >= 2;
      if (error?.definitelyUnsent === true && error.temporary === true && !mappingExhausted) {
        const wait = Math.min(300000, retryBaseMs * 2 ** Math.min(row.attempts, 16));
        sql.run`UPDATE bridge_replies SET state='ready',retry_at=${Date.now() + wait},attempts=attempts+1 WHERE entry=${row.entry}`;
        emit('reply_deferred', { ...details, retryMs: wait });
      } else {
        const state = error?.definitelyUnsent === true ? 'failed' : 'uncertain';
        sql.run`UPDATE bridge_replies SET state=${state} WHERE entry=${row.entry}`;
        const reason = mappingExhausted ? 'route_unmapped' : state === 'failed' ? 'send_rejected' : 'send_outcome_unknown';
        emit('reply_' + state, { ...details, reason });
      }
      return true;
    }
    const next = row.part + 1, state = next === row.total ? 'sent' : 'ready';
    db.exec('SAVEPOINT bridge_sent_part');
    try {
      sql.run`UPDATE bridge_replies SET state=${state},part=${next},attempts=0,retry_at=0 WHERE entry=${row.entry}`;
      sql.run`DELETE FROM bridge_reply_chunks WHERE entry=${row.entry} AND part=${row.part}`;
      db.exec('RELEASE bridge_sent_part');
    } catch (error) {
      db.exec('ROLLBACK TO bridge_sent_part; RELEASE bridge_sent_part');
      throw error;
    }
    if (state === 'sent') emit('reply_sent', details);
    return true;
  }
  function trackProgress(entry, started, deferred = false) {
    try {
      if (!tokenFor(entry)) return;
      sql.run`INSERT INTO bridge_progress(entry,due,started,deferred) VALUES(${entry},${Date.now() + (deferred ? 0 : progressAfterMs)},${Number(started)},${Number(deferred)})
        ON CONFLICT(entry) DO UPDATE SET started=MAX(started,excluded.started)`;
      wake();
    } catch { emit('progress_failed', { entry, reason: 'progress_storage_error' }); }
  }
  function finishProgress(entry) {
    try { sql.run`UPDATE bridge_progress SET due=NULL WHERE entry=${entry}`; }
    catch { emit('progress_failed', { entry, reason: 'progress_storage_error' }); }
  }
  async function sendProgress() {
    const row = sql.get`SELECT p.entry,p.deferred, r.state, r.queue_id, r.chat_type, r.chat_id, r.sender_id FROM bridge_progress p
      JOIN bridge_replies r ON r.entry=p.entry WHERE p.due<=${Date.now()}
      AND r.state IN ('registered','waiting') ORDER BY p.due LIMIT 1`;
    if (!row) return;
    const route = { chatType: row.chat_type, chatId: row.chat_id, senderId: row.sender_id };
    try {
      // Check before progress notices even when history polling has backed off.
      if (row.state === 'waiting') await poll(true);
      const awaitingStart = row.queue_id && !sql.get`SELECT started FROM bridge_progress WHERE entry=${row.entry}`?.started;
      const text = row.deferred
        ? '桥接暂时无法启动处理程序，消息已保留，会自动重试。请勿重复发送。'
        : awaitingStart
          ? '消息已进入 Codex 队列，尚未确认开始执行。如果桌面端显示队列暂停，请在目标聊天点「继续」。'
          : await progressText(route);
      // A final may arrive during the title lookup. Reserve before sending so a
      // restart cannot produce a duplicate progress message.
      if (closed || !sql.run`UPDATE bridge_progress SET due=NULL WHERE entry=${row.entry} AND due IS NOT NULL
        AND EXISTS (SELECT 1 FROM bridge_replies WHERE entry=${row.entry} AND state IN ('registered','waiting'))`.changes) return;
      await sendReply(route, text);
      emit('progress_sent', { entry: row.entry });
    } catch {
      finishProgress(row.entry);
      emit('progress_failed', { entry: row.entry });
    }
  }
  async function drain() {
    const expired = sql.all`UPDATE bridge_replies SET block_until=NULL
      WHERE state='waiting' AND block_until<=${Date.now()} RETURNING entry`;
    for (const { entry } of expired) released(entry, 'hold_expired');
    while (!closed && await sendNext()) { /* Each acknowledged chunk commits before the next send. */ }
    if (!closed) await poll();
    if (!closed) await sendProgress();
  }
  function arm() {
    if (closed) return;
    let due;
    try {
      const backlog = sql.get`SELECT COUNT(*) AS n,MIN(block_until) AS deadline FROM bridge_replies WHERE state='waiting'`;
      const retries = sql.get`SELECT MIN(retry_at) AS due FROM bridge_replies WHERE state='ready'`;
      const progress = sql.get`SELECT MIN(p.due) AS due FROM bridge_progress p JOIN bridge_replies r ON r.entry=p.entry
        WHERE p.due IS NOT NULL AND r.state IN ('registered','waiting')`;
      const times = [progress.due, retries.due, backlog.deadline, backlog.n && readReplies ? nextPoll : null].filter(value => value !== null);
      if (!times.length) return;
      due = Math.max(storageRetryAt, Math.min(...times));
    } catch { due = Date.now() + retryBaseMs; }
    timer = setTimeout(wake, Math.max(1, due - Date.now()));
    timer.unref();
  }
  function wake() {
    if (closed) return;
    clearTimeout(timer);
    if (worker) { again = true; return; }
    again = false;
    worker = Promise.resolve().then(() => { if (!closed) return drain(); }).catch(() => {
      storageRetryAt = Date.now() + retryBaseMs;
      emit('reply_storage_error', {});
    }).finally(() => {
      worker = null;
      if (again && Date.now() >= storageRetryAt) wake();
      else arm();
    });
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    clearTimeout(timer);
    closePromise = Promise.resolve(worker).finally(() => {
      for (const statement of statements.values()) statement.close?.();
      statements.clear();
    });
    return closePromise;
  }
  wake();
  return { register, trackProgress, finishProgress, bindQueue, unmatched, tokenFor, start, ready, wake, hasPendingTurn, close };
}

module.exports = { createReplies };
