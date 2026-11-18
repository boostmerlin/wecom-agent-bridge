'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function parseCommand(body) {
  if (body.msgtype !== 'text' || typeof body.text?.content !== 'string') return null;
  let text = body.text.content.trim();
  if (body.chattype === 'group') text = text.replace(/^@[^\s]+\s+/, '');
  const decision = /^\/?(允许|拒绝|approve|deny)(?:\s+([a-z0-9]+))?$/i.exec(text);
  if (decision) return { name: /^(允许|approve)$/i.test(decision[1]) ? 'approve' : 'deny', arg: decision[2] || '' };
  const match = /^\/(记住|记忆|memory|忘记|forget|new|cwd|thread|threads|history|status|bind|retry|cancel|backend|help|允许|拒绝|approve|deny)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const aliases = { memory: '记忆', forget: '忘记', 允许: 'approve', 拒绝: 'deny' };
  return { name: aliases[name] ?? name, arg: (match[2] || '').trim() };
}

const helpText = [
  '桥接指令（群里先 @机器人，再输入指令）',
  '/help  查看帮助',
  '/backend  查看当前后端；/backend codex|claude  切换整个机器人的后端',
  '/status  查看下一条消息的目标和本会话上一条任务',
  '/bind  固定当前目标；/bind <绝对目录>  绑定项目并开启新聊天',
  '/bind off  恢复使用机器人默认目标',
  '/threads  列出工作目录中的聊天',
  '/history  列出当前后端最近使用的聊天和工作目录（最多 20 条）',
  '/thread <ID 或链接>  切换聊天',
  '/new  新开聊天；/cwd <绝对目录>  换目录并新开聊天',
  '/retry  重试本会话上一条任务中确定失败的环节',
  '/cancel  取消本会话上一条排队或本地执行中的任务，不撤销已有改动',
  '允许 <审批编号> / 拒绝 <审批编号>  回应 Codex / Claude 审批；只有一条待审批时可省略编号',
  '/memory 或 /记忆  查看记忆；后接内容则保存',
  '/忘记 或 /forget <编号或内容>  删除记忆',
  '绑定后切换目录或聊天只影响本会话。管理指令限机器人绑定的本人使用。',
].join('\n');

function chatKey(route) { return JSON.stringify([route.chatType, route.chatId]); }

function createCommandStore(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, 'commands.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_locations (queue_key TEXT PRIMARY KEY, working_dir TEXT NOT NULL, thread_id TEXT);
    CREATE INDEX IF NOT EXISTS queue_by_target ON queue_locations(thread_id,working_dir);
    CREATE TABLE IF NOT EXISTS target_history (queue_key TEXT PRIMARY KEY, used_order INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bindings (chat TEXT PRIMARY KEY, target TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS last_tasks (chat TEXT PRIMARY KEY, msg_id TEXT NOT NULL, target TEXT NOT NULL, media TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, name TEXT, body TEXT NOT NULL,
      UNIQUE(scope,name)
    );
    CREATE TABLE IF NOT EXISTS received (id TEXT PRIMARY KEY, queue_key TEXT NOT NULL, done INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workers (queue_key TEXT PRIMARY KEY, target TEXT NOT NULL);
  `);
  // Seed queues created before directory ownership was recorded. An older queue
  // can contain tasks from multiple directories; each last task keeps its own snapshot.
  db.exec(`INSERT OR IGNORE INTO queue_locations
    SELECT json_extract(target,'$.queueKey'),json_extract(target,'$.workingDir'),json_extract(target,'$.threadId')
    FROM workers UNION ALL SELECT json_extract(target,'$.queueKey'),json_extract(target,'$.workingDir'),
    json_extract(target,'$.threadId') FROM last_tasks`);
  // Older versions retained only the last task per chat; their relative age is unknown.
  db.exec(`INSERT OR IGNORE INTO target_history
    SELECT json_extract(target,'$.queueKey'),0 FROM last_tasks
    WHERE json_extract(target,'$.queueKey') IS NOT NULL`);
  const notes = db.prepare('SELECT id,name,body FROM notes WHERE scope=? ORDER BY id');
  function scope(dir, route) {
    const canonical = fs.realpathSync(dir);
    return JSON.stringify([process.platform === 'win32' ? canonical.toLowerCase() : canonical,
      route.chatType, route.chatId, route.senderId]);
  }
  function memory(command, key) {
    const rows = notes.all(key);
    const { arg, name } = command;
    if (name === '记忆' && !arg) {
      return rows.length ? rows.map(row => '#' + row.id + ' ' + (row.name ? row.name + ' = ' : '') + row.body).join('\n') : '当前会话和目录还没有记忆。';
    }
    if (name === '忘记') {
      const row = rows.find(r => '#' + r.id === arg || String(r.id) === arg || r.name === arg || r.body === arg);
      if (!row) return '未找到这条记忆。可用 /记忆 查看编号。';
      db.prepare('DELETE FROM notes WHERE scope=? AND id=?').run(key, row.id);
      return '已删除记忆 #' + row.id;
    }
    if (!arg || arg.length > 1000) return '用法：/memory 一条约定（最多 1000 个字符）；不带内容则查看记忆。';
    const pair = /^(.{1,80}?)\s+=\s+([\s\S]+)$/.exec(arg);
    const label = pair ? pair[1].trim() : null;
    const body = pair ? pair[2].trim() : arg;
    const prior = rows.find(r => label ? r.name === label : !r.name && r.body === body);
    if (prior) {
      db.prepare('UPDATE notes SET body=? WHERE id=?').run(body, prior.id);
      return '已记住 #' + prior.id;
    }
    if (rows.length >= 20) return '已保存 20 条记忆，请先用 /忘记 删除一条。';
    return '已记住 #' + db.prepare('INSERT INTO notes(scope,name,body) VALUES(?,?,?)').run(key,label,body).lastInsertRowid;
  }
  return {
    memory, scope,
    binding(route) {
      const row = db.prepare('SELECT target FROM bindings WHERE chat=?').get(chatKey(route));
      return row && JSON.parse(row.target);
    },
    bind(route, target) {
      if (target) db.prepare('INSERT OR REPLACE INTO bindings VALUES(?,?)').run(chatKey(route), JSON.stringify(target));
      else db.prepare('DELETE FROM bindings WHERE chat=?').run(chatKey(route));
    },
    recordTask(route, id, target, media) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT OR REPLACE INTO last_tasks VALUES(?,?,?,?)').run(chatKey(route), id,
          JSON.stringify(target), JSON.stringify(media));
        db.prepare(`INSERT OR REPLACE INTO target_history
          SELECT ?,COALESCE(MAX(used_order),0)+1 FROM target_history`).run(target.queueKey);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    history(limit = 20) {
      // Resolve IDs through queue_locations so onCreated also updates existing history.
      // SQLite's MAX selects queue_key from the most recently used row in each group.
      return db.prepare(`SELECT q.queue_key AS queueKey,q.thread_id AS threadId,
        q.working_dir AS workingDir,MAX(h.used_order) AS lastUsed
        FROM target_history h JOIN queue_locations q USING(queue_key)
        GROUP BY q.thread_id,q.working_dir ORDER BY lastUsed DESC,q.queue_key LIMIT ?`).all(limit);
    },
    lastTask(route) {
      const row = db.prepare('SELECT msg_id,target,media FROM last_tasks WHERE chat=?').get(chatKey(route));
      return row && { id: row.msg_id, target: JSON.parse(row.target), media: JSON.parse(row.media) };
    },
    append(text, dir, route) {
      const rows = notes.all(scope(dir, route));
      if (!rows.length) return text;
      return text + '\n\n**约定**（以正文为准，仅本次适用）\n\n' +
        rows.map(r => '- ' + (r.name ? r.name + '：' : '') + r.body).join('\n');
    },
    claim(id, key) {
      db.prepare('INSERT INTO received(id,queue_key) VALUES(?,?) ON CONFLICT DO NOTHING').run(id,key);
      return db.prepare('SELECT queue_key,done FROM received WHERE id=?').get(id);
    },
    handled(id) { return db.prepare('SELECT done FROM received WHERE id=?').get(id)?.done === 1; },
    plan(id, build) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare('SELECT data FROM plans WHERE id=?').get(id);
        const plan = existing ? JSON.parse(existing.data) : build();
        if (!existing) db.prepare('INSERT INTO plans(id,data) VALUES(?,?)').run(id, JSON.stringify(plan));
        db.exec('COMMIT');
        return plan;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    pending() { return db.prepare('SELECT data FROM plans').all().map(r => JSON.parse(r.data)); },
    finish(id) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE received SET done=1 WHERE id=?').run(id);
        db.prepare('DELETE FROM plans WHERE id=?').run(id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    queueFor(threadId, dir) {
      return db.prepare('SELECT queue_key FROM queue_locations WHERE thread_id=? AND working_dir=? LIMIT 1').get(threadId, dir)?.queue_key;
    },
    queueDirectory(key) {
      return db.prepare('SELECT working_dir FROM queue_locations WHERE queue_key=?').get(key)?.working_dir;
    },
    track(target) {
      db.prepare(`INSERT INTO queue_locations VALUES(?,?,?) ON CONFLICT(queue_key) DO UPDATE
        SET thread_id=COALESCE(excluded.thread_id,thread_id) WHERE working_dir=excluded.working_dir`)
        .run(target.queueKey, target.workingDir, target.threadId ?? null);
      db.prepare('INSERT OR REPLACE INTO workers(queue_key,target) VALUES(?,?)').run(target.queueKey,JSON.stringify(target));
    },
    targets() { return db.prepare('SELECT target FROM workers').all().map(row => JSON.parse(row.target)); },
    untrack(key) { db.prepare('DELETE FROM workers WHERE queue_key=?').run(key); },
    close() { db.close(); },
  };
}

module.exports = { helpText, parseCommand, createCommandStore };
