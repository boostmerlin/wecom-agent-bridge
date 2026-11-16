"use strict";

const { createHash } = require("node:crypto");
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createReplies } = require("./replies.cjs");

function buildWecomPrompt(text) {
  return (
    text +
    "\n\n请完成正文要求的任务后回复实际结果。默认简洁，优先说明结论、关键结果和未完成事项。正文要求提供的代码、命令、文案等内容应完整给出；指定了回复内容或格式时，严格遵循。桥接会将最终答复发回原企微会话，请勿自行发送。"
  );
}

function createDelivery({
  backend,
  ownerId,
  threadId,
  workingDir,
  stateDir,
  log = () => {},
  readReplies = backend?.readReplies && (keys => backend.readReplies({ threadId, workingDir }, keys)),
  sendReply, progressText, progressAfterMs,
  queueKey = threadId,
  onCreated,
}) {
  if (
    typeof backend?.submit !== "function" || ![queueKey, workingDir, stateDir].every(
      (value) => typeof value === "string" && value.trim(),
    )
  ) {
    throw new TypeError(
      "A backend, queue key, working directory and state directory are required",
    );
  }
  if (!threadId && typeof onCreated !== "function")
    throw new Error("Missing new chat handler");
  const isOwner = senderId => Boolean(ownerId) && senderId === ownerId;
  let logContext;
  const emit = (event, details) => {
    if (details?.entry != null && sendReply) {
      try {
        logContext ??=
          db.prepare(`SELECT r.token AS requestId, COALESCE(r.sender_id, m.sender_id) AS senderId,
          m.wecom_request_id AS wecomRequestId FROM messages m LEFT JOIN bridge_replies r ON r.entry=m.id WHERE m.id=?`);
        const context = logContext.get(details.entry);
        if (context) details = { ...details, ...context };
      } catch {
        /* Keep the original event if its context is unavailable. */
      }
    }
    try {
      log(event, details);
    } catch {
      /* Logging cannot change a committed delivery outcome. */
    }
  };
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const threadKey = createHash("sha256").update(queueKey).digest("hex");
  const base = join(stateDir, "delivery-" + threadKey);
  const lock = new DatabaseSync(base + ".lock.sqlite");
  let pendingBinding;
  let db, insert, nextMessage, markSubmitting, markResult, replies;
  let stopped = false,
    worker,
    retryTimer,
    wakeRequested = false,
    closePromise;
  try {
    // A separate SQLite lock survives a slow child and is released by the OS on process exit.
    // This makes it safe for the next worker to classify interrupted submissions on startup.
    lock.exec("BEGIN EXCLUSIVE");
    db = new DatabaseSync(base + ".sqlite");
    db.exec("PRAGMA synchronous = FULL");
    if (queueKey !== threadId) {
      db.exec(
        "CREATE TABLE IF NOT EXISTS bridge_target (id INTEGER PRIMARY KEY CHECK(id=1), thread_id TEXT NOT NULL)",
      );
      const bound = db
        .prepare("SELECT thread_id FROM bridge_target WHERE id=1")
        .get();
      if (bound && threadId && bound.thread_id !== threadId)
        throw new Error("本地队列属于另一个聊天。");
      if (bound && !threadId) {
        onCreated(bound.thread_id);
        threadId = bound.thread_id;
      }
    }
    db.exec("CREATE TABLE IF NOT EXISTS manual_retries (command TEXT PRIMARY KEY, answer TEXT NOT NULL)");
    const previous = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'messages'",
      )
      .get();
    const migrate = previous && !previous.sql.includes("'queued_in_codex'");
    db.exec("BEGIN IMMEDIATE");
    if (migrate) db.exec("ALTER TABLE messages RENAME TO old_messages");
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, msg_id TEXT UNIQUE NOT NULL, body TEXT,
        state TEXT NOT NULL CHECK (state IN ('queued','submitting','completed','queued_in_codex','uncertain','rejected'))
      )`);
    if (migrate)
      db.exec(`
      INSERT INTO messages SELECT id, msg_id, body, CASE WHEN state = 'submitted' THEN 'queued_in_codex' ELSE state END FROM old_messages;
      DROP TABLE old_messages;
    `);
    const columns = db
      .prepare("PRAGMA table_info(messages)")
      .all()
      .map((column) => column.name);
    if (!columns.includes("retry_dir")) db.exec("ALTER TABLE messages ADD COLUMN retry_dir TEXT");
    if (!columns.includes("sender_id"))
      db.exec("ALTER TABLE messages ADD COLUMN sender_id TEXT");
    if (!columns.includes("wecom_request_id"))
      db.exec("ALTER TABLE messages ADD COLUMN wecom_request_id TEXT");
    db.exec(
      "CREATE INDEX IF NOT EXISTS by_state ON messages (state, id); COMMIT",
    );
    insert = db.prepare(
      "INSERT INTO messages(msg_id, body, sender_id, wecom_request_id, state) VALUES(?, ?, ?, ?, 'queued') ON CONFLICT(msg_id) DO NOTHING",
    );
    nextMessage = db.prepare(
      "SELECT id, body, retry_dir, sender_id FROM messages WHERE state = 'queued' ORDER BY id LIMIT 1",
    );
    markSubmitting = db.prepare(
      "UPDATE messages SET state = 'submitting' WHERE id = ?",
    );
    markResult = db.prepare(
      "UPDATE messages SET state = ?, body = CASE WHEN ? IN ('completed','queued_in_codex') THEN NULL ELSE body END WHERE id = ?",
    );
    if (sendReply)
      replies = createReplies({
        db,
        readReplies,
        replyKey: backend.replyKey,
        missingReceiptReason: backend.missingReceiptReason,
        sendReply, progressText, progressAfterMs,
        log: emit,
        onTurnResolved: wake,
      });
    db.exec("BEGIN IMMEDIATE");
    const interrupted = db
      .prepare(
        "UPDATE messages SET state = 'uncertain' WHERE state = 'submitting' RETURNING id, sender_id",
      )
      .all();
    for (const { id, sender_id } of interrupted) {
      if (replies?.tokenFor(id)) {
        if (isOwner(sender_id) && readReplies) replies.start(id, { blocking: false });
        else replies.unmatched(id);
      }
    }
    db.exec("COMMIT");
    for (const { id } of interrupted) replies?.finishProgress(id);
    if (interrupted.length)
      emit("delivery_uncertain", {
        count: interrupted.length,
        reason: "interrupted_submission",
      });
  } catch (error) {
    try {
      db?.close();
    } finally {
      lock.close();
    }
    throw error;
  }

  function retryLater() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      wake();
    }, 30_000);
    retryTimer.unref();
  }

  async function drain() {
    while (!stopped) {
      if (pendingBinding) {
        db.prepare(
          "INSERT OR REPLACE INTO bridge_target(id,thread_id) VALUES(1,?)",
        ).run(pendingBinding);
        onCreated(pendingBinding);
        pendingBinding = undefined;
      }
      if (replies?.hasPendingTurn()) return;
      const message = nextMessage.get();
      if (!message) return;
      // Commit the intent before spawning. A crash between this and recording the result
      // leaves one ambiguous row for review instead of risking a second remote submission.
      markSubmitting.run(message.id);
      const token = replies?.tokenFor(message.id);
      let result;
      try {
        const owner = isOwner(message.sender_id);
        const turn = {
          workingDir: message.retry_dir ?? workingDir, stateDir, replyToken: token,
          prompt: buildWecomPrompt(message.body),
          onStarted() {
            replies?.trackProgress(message.id, true);
            emit("delivery_submitted", { entry: message.id });
          },
          onDiagnostic(details) {
            emit("cli_exited", { entry: message.id, ...details });
          },
        };
        if (owner) result = await backend.submit({
          ...turn, threadId, autoCreated: queueKey !== threadId,
          onCreated(id) {
            threadId = pendingBinding = id;
            db.prepare("INSERT INTO bridge_target(id,thread_id) VALUES(1,?)").run(id);
            onCreated(id);
            pendingBinding = undefined;
          },
        });
        else if (backend.submitExternal) result = await backend.submitExternal(turn);
        else result = { state: "rejected", reason: "external_sandbox_unsupported" };
      } catch {
        // The backend may already have started processing. Never submit it twice.
        result = { state: "uncertain", reason: "backend_outcome_unknown" };
      }
      // Existing SQLite queues use this spelling for remote acceptance.
      const storedState = result.state === "accepted" ? "queued_in_codex" : result.state;
      db.exec("BEGIN IMMEDIATE");
      try {
        markResult.run(storedState, storedState, message.id);
        if (
          token &&
          ["completed", "accepted", "uncertain", "rejected"].includes(result.state)
        ) {
          if (result.queueId) replies.bindQueue(message.id, result.replyId || result.queueId);
          if (result.state === "completed" && result.text?.trim()) replies.ready(message.id, result.text);
          else if (result.queueId && readReplies) replies.start(message.id);
          else if (result.state === "rejected") replies.unmatched(message.id, result.reason || "delivery_rejected",
            "本次消息投递失败，处理程序未接受任务。请检查桥接日志，修复后由本人发送 /retry 重试。");
          else replies.unmatched(message.id, result.reason);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (result.state === "accepted" && result.queueId) replies?.trackProgress(message.id, false);
      else if (result.state === "queued") replies?.trackProgress(message.id, false, true);
      else replies?.finishProgress(message.id);
      if (result.state === "queued") {
        emit("delivery_deferred", { entry: message.id, reason: result.reason });
        retryLater();
        return;
      }
      const details = result.reason ? { reason: result.reason } : {};
      if (result.wakeConfirmed === false) details.wakeConfirmed = false;
      const event = result.state === "accepted" && backend.acceptedEvent;
      emit(event || "delivery_" + result.state, { entry: message.id, ...details });
      if (result.state === "accepted" && backend.afterAccepted) {
        await backend.afterAccepted(result, threadId, (name, fields) =>
          emit(name, { entry: message.id, ...fields }));
      }
    }
  }

  function wake() {
    if (stopped || retryTimer) return;
    if (worker) {
      wakeRequested = true;
      return;
    }
    wakeRequested = false;
    worker = Promise.resolve()
      .then(drain)
      .catch(() => {
        emit("delivery_storage_error", { reason: "state_access_failed" });
        retryLater();
      })
      .finally(() => {
        worker = null;
        if (wakeRequested) wake();
      });
  }

  function enqueue(
    msgId,
    text,
    chatType,
    route,
    wecomRequestId,
    senderId = route?.senderId,
    localReply = false,
  ) {
    if (stopped) throw new Error("Delivery is closed");
    if (
      typeof msgId !== "string" ||
      !msgId.trim() ||
      typeof text !== "string" ||
      !text.trim()
    ) {
      throw new TypeError("A message ID and nonempty text are required");
    }
    let stored;
    db.exec("BEGIN IMMEDIATE");
    try {
      stored = insert.run(
        msgId,
        text,
        senderId ?? null,
        typeof wecomRequestId === "string" ? wecomRequestId : null,
      );
      if (stored.changes && route)
        replies?.register(stored.lastInsertRowid, route);
      if (stored.changes && localReply) {
        if (!route || !replies)
          throw new Error("Local reply requires a verified route");
        markResult.run("completed", "completed", stored.lastInsertRowid);
        replies.ready(stored.lastInsertRowid, text);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (!stored.changes) return false;
    emit("delivery_queued", { entry: stored.lastInsertRowid, chatType });
    if (replies && !route)
      emit("reply_no_route", { entry: stored.lastInsertRowid, chatType });
    wake();
    return true;
  }

  function taskState(id, route) {
    return db.prepare(`SELECT m.id AS entry,
      CASE WHEN r.failure_reason='turn_failed' THEN 'failed'
        WHEN m.state='queued_in_codex' AND r.failure_reason IS NOT NULL THEN 'uncertain'
        WHEN m.state='queued_in_codex' AND r.total>0 THEN 'completed' ELSE m.state END AS delivery,
      r.state AS reply,r.total,r.part,r.failure_reason AS failureReason,
      COALESCE(p.started,0) AS started FROM messages m JOIN bridge_replies r ON r.entry=m.id
      LEFT JOIN bridge_progress p ON p.entry=m.id WHERE m.msg_id=? AND r.chat_id=? AND r.chat_type=?`)
      .get(id, route.chatId, route.chatType);
  }

  function retryTask(commandId, id, route, originalDir = workingDir) {
    const prior = db.prepare("SELECT answer FROM manual_retries WHERE command=?").get(commandId);
    if (prior) return prior.answer;
    let answer;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = taskState(id, route);
      if (row?.reply === "failed" && row.part < row.total) {
        db.prepare("UPDATE bridge_replies SET state='ready',retry_at=0,attempts=0 WHERE entry=?").run(row.entry);
        answer = "已安排从未发出的分段继续回发。";
      } else if (row?.delivery === "rejected" && ["registered", "sent", "failed"].includes(row.reply)) {
        db.prepare("DELETE FROM bridge_reply_chunks WHERE entry=?").run(row.entry);
        db.prepare("UPDATE bridge_replies SET state='registered',total=0,part=0,attempts=0,retry_at=0,failure_reason=NULL WHERE entry=?").run(row.entry);
        db.prepare("DELETE FROM bridge_progress WHERE entry=?").run(row.entry);
        db.prepare("UPDATE messages SET state='queued', retry_dir=? WHERE id=?").run(originalDir, row.entry);
        answer = "已重新安排投递此前被拒绝的任务。";
      } else {
        answer = "没有可安全重试的失败环节。可用 /status 查看进度。";
      }
      db.prepare("INSERT INTO manual_retries VALUES(?,?)").run(commandId, answer);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    replies?.wake();
    wake();
    return answer;
  }

  function close() {
    if (closePromise) return closePromise;
    stopped = true;
    clearTimeout(retryTimer);
    closePromise = Promise.resolve(worker)
      .then(() => replies?.close())
      .finally(() => {
        try {
          db.close();
        } finally {
          lock.close();
        }
      });
    return closePromise;
  }

  wake();
  function idle() {
    return (
      !worker &&
      !db
        .prepare(
          "SELECT 1 FROM messages WHERE state IN ('queued','submitting') LIMIT 1",
        )
        .get() &&
      !db
        .prepare(
          "SELECT 1 FROM bridge_replies WHERE state IN ('waiting','ready','sending') LIMIT 1",
        )
        .get()
    );
  }
  return { enqueue, close, idle, taskState, retryTask };
}

module.exports = { buildWecomPrompt, createDelivery };
