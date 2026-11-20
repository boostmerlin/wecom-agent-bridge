'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { parseCommand, createCommandStore } = require('../src/commands.cjs');

test('command aliases, memory scopes, stable deletion IDs and atomic replay', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-memory-'));
  const store = createCommandStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const route = { chatType: 'single', chatId: 'me', senderId: 'me' };
  const scope = store.scope(dir, route);
  const parse = content => parseCommand({ msgtype: 'text', chattype: 'group', text: { content } });
  assert.deepEqual(parse('@机器人 /memory 请view 时审查 MR'), parse('/记忆 请view 时审查 MR'));
  assert.equal(parse('提到 /new'), null);
  assert.equal(parse('/save 内容'), null);
  assert.equal(parse('/save'), null);
  assert.equal(parse('/memoryMore a'), null);
  assert.equal(parseCommand({ msgtype: 'voice', voice: { content: '/new' } }), null);
  assert.match(store.memory(parse('/memory   '), scope), /还没有记忆/);
  assert.match(store.memory(parse('/memory 测试命令 = npm test'), scope), /已记住 #1/);
  store.memory(parse('/记忆 测试命令 = node --test'), scope);
  assert.deepEqual(parse('@机器人 /memory'), parse('/记忆'));
  assert.equal(store.memory(parse('/memory'), scope), '#1 测试命令 = node --test');
  assert.equal(store.memory(parse('/MEMORY \n  '), scope), '#1 测试命令 = node --test');
  assert.match(store.memory(parse('/memory ' + '长'.repeat(1001)), scope), /最多 1000/);
  assert.equal(store.append('请测试', dir, route),
    '请测试\n\n&nbsp;  \n**约定**（以正文为准，仅本次适用）  \n• 测试命令：node --test');
  for (const other of [{ ...route, chatType: 'group' }, { ...route, senderId: 'guest' }]) {
    assert.equal(store.append('请测试', dir, other), '请测试');
  }
  assert.deepEqual(parse('@机器人 /forget #1'), parse('/忘记 #1'));
  store.plan('forget', () => ({ reply: store.memory(parse('/forget #1'), scope) }));
  assert.deepEqual(store.plan('forget', () => assert.fail('replayed')), { reply: '已删除记忆 #1' });
  assert.equal(store.append('请测试', dir, route), '请测试');
});

test('task numbers survive upgrade and replay while remaining scoped to the original conversation', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-task-index-'));
  const db = new DatabaseSync(path.join(dir, 'commands.sqlite'));
  const route = { chatType: 'group', chatId: 'team', senderId: 'owner' };
  const other = { ...route, chatId: 'other' };
  const target = { queueKey: 'old-queue', workingDir: dir, threadId: 'old-thread' };
  const media = { total: 0 };
  db.exec('CREATE TABLE last_tasks(chat TEXT PRIMARY KEY, msg_id TEXT NOT NULL,target TEXT NOT NULL,media TEXT NOT NULL)');
  db.prepare('INSERT INTO last_tasks VALUES(?,?,?,?)').run(JSON.stringify(['group', 'team']), 'legacy', JSON.stringify(target), JSON.stringify(media));
  db.close();
  let store = createCommandStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const migrated = store.task(route);
  assert.deepEqual(migrated, { number: 1, id: 'legacy', target, media });
  assert.equal(store.task(other, migrated.number), undefined);
  store.recordTask(route, 'new', { ...target, queueKey: 'different-queue' }, media);
  store.recordTask(route, 'legacy', { ...target, threadId: 'other-thread' }, media);
  store.close();
  store = createCommandStore(dir);
  assert.deepEqual(store.recentTasks(route).map(({ id, number }) => [id, number]), [['new', 2], ['legacy', 1]]);
  assert.deepEqual(store.task(route, migrated.number), migrated);
  assert.equal(store.task(route).id, 'new');
  assert.deepEqual(store.recentTasks(other), []);
});

test('verified WS commands switch the live target in order and acknowledge the original chat', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-cmd-ws-'));
  const src = path.join(root, 'src');
  fs.cpSync(path.join(__dirname, '..', 'src'), src, { recursive: true });
  const sdk = path.join(root, 'node_modules', '@wecom', 'aibot-node-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'index.js'), '');
  const secondDir = path.join(root, 'project two');
  fs.mkdirSync(secondDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let client, status, stop;
  class WSClient extends EventEmitter {
    constructor() { super(); client = this; }
    connect() { this.emit('authenticated'); }
    disconnect() {}
  }
  function inject(file, exports) {
    const id = require.resolve(file);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  inject(sdk, { WSClient });
  inject(path.join(src, 'control.cjs'), { listenControl: async (get, end) => {
    status = get; stop = end; return { close() {} };
  } });
  const known = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
  inject(path.join(src, 'backends', 'codex-history.cjs'), { listThreads: async ({workingDir}) => {
    assert.equal(workingDir, root);
    return [{ id:known, name:'当前测试' }, { id:second, name:null }];
  }, readThread: async ({threadId}) => {
    assert.equal(threadId, second);
    return { id: second, name: '目标聊天' };
  }, readThreadCwd: async ({threadId}) => {
    if (threadId === second) return secondDir;
    throw Error('unknown chat');
  } });
  const messages = [];
  const waitForEnqueue = new Map();
  inject(path.join(src, 'delivery.cjs'), { createDelivery: options => ({
    idle: () => false, close: async () => {},
    enqueue(id,text,type,route,req,sender,ack) {
      options.log(ack ? 'reply_ready' : 'delivery_queued', { wecomRequestId: req });
      messages.push({ id, text, route, ack, target: options.threadId, dir: options.workingDir, key:options.queueKey });
      waitForEnqueue.get(id)?.(messages.at(-1));
    },
  }) });
  const main = require(path.join(src,'main.cjs'));
  const { createCodexBackend } = require(path.join(src,'backends','codex.cjs'));
  const backend = createCodexBackend({ codexPath: 'dummy' });
  const config = { botId:'test-bot', ownerId:'me', secret:'dummy', backend, workingDir:root, threadId:known };
  await main.runBridge({...config});
  function push(id, content, sender='me', group='group-A') {
    client.emit('message',{headers:{req_id:id}, body:{msgid:id, chattype:'group',chatid:group,
      from:{userid:sender},msgtype:'text',text:{content}}});
  }
  push('s','/memory 当我说请view时，审查指定 MR，通过后合并');
  push('s','/memory 当我说请view时，审查指定 MR，通过后合并');
  push('list','/threads');
  push('list-denied','/threads','guest');
  push('history-empty','/history');
  push('owner','请view !123');
  push('guest','请view !123','other');
  push('other-chat','请view !123','me','group-B');
  push('deny','/new','other');
  push('new','/new');
  push('next','请view !456');
  push('cwd','/cwd '+secondDir);
  push('changed','请view !789');
  push('invalid','/thread invalid');
  push('switch','/thread codex://threads/'+second);
  push('last','hello');
  push('history','/history');
  push('history-denied','/history','guest');
  push('history-usage','/history extra');
  await stop('test');
  const by = id => messages.find(m => m.id === id);
  assert.equal(messages.filter(m => m.id === 's').length,1);
  assert.equal(by('list').ack,true);
  assert.ok(by('list').text.includes('【当前】当前测试\n' + known));
  assert.ok(by('list').text.includes('未命名聊天\n' + second));
  assert.match(by('list-denied').text,/仅限/);
  assert.match(by('history-empty').text,/尚无/);
  assert.equal(by('history').ack, true);
  assert.match(by('history').text, /【当前】/);
  assert.ok(by('history').text.indexOf(second) < by('history').text.indexOf(known));
  assert.ok(by('history').text.includes(secondDir));
  assert.ok(by('history').text.includes(root));
  assert.match(by('history-denied').text, /仅限/);
  assert.match(by('history-usage').text, /用法：\/history/);
  assert.equal(by('s').ack,true);
  assert.equal(by('s').route.chatId,'group-A');
  assert.match(by('owner').text,/通过后合并/);
  assert.doesNotMatch(by('guest').text,/通过后合并/);
  assert.doesNotMatch(by('other-chat').text,/通过后合并/);
  assert.match(by('deny').text,/仅限/);
  assert.match(by('next').text,/通过后合并/);
  assert.notEqual(by('next').key,known);
  assert.equal(by('next').dir,root);
  assert.equal(by('changed').dir,secondDir);
  assert.doesNotMatch(by('changed').text,/通过后合并/);
  assert.match(by('invalid').text,/失败/);
  assert.equal(by('switch').text, '已切换聊天 目标聊天 · …000000000002\n工作目录：' + secondDir);
  assert.equal(by('last').target,second);
  assert.equal(status().threadId,second);
  const events = fs.readFileSync(path.join(root, '.state', 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const [id, expectedDir, expectedThread] of [['new', root, known], ['changed', secondDir, null], ['last', secondDir, second]]) {
    const event = events.find(row => row.wecomRequestId === id);
    assert.equal(event.workingDir, expectedDir);
    assert.equal(event.threadId, expectedThread);
  }
  assert.equal(main.loadTarget(backend).workingDir,secondDir);
  assert.equal(main.loadTarget(backend).threadId,second);
  const lastFile = path.join(root, '.state', 'last-target.json');
  const localFile = path.join(root, '.config.local.json');
  fs.writeFileSync(localFile, JSON.stringify({threadId: known, workingDir: root}));
  await main.runBridge({...config,...main.loadTarget(backend)});
  async function deliver(id, content = 'hello') {
    const delivered = new Promise(resolve => {
      waitForEnqueue.set(id, resolve);
    });
    push(id, content);
    return Promise.race([delivered, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Missing delivery ' + id)), 2000);
      timer.unref();
    })]);
  }
  fs.writeFileSync(localFile, JSON.stringify({threadId: second, workingDir: secondDir}));
  fs.writeFileSync(lastFile, JSON.stringify({threadId: second, workingDir: root}));
  assert.equal((await deliver('same-chat-new-dir')).dir, root);
  fs.writeFileSync(lastFile, JSON.stringify({threadId: second, workingDir: secondDir}));
  assert.equal((await deliver('restore-dir')).dir, secondDir);
  fs.unlinkSync(lastFile);
  assert.equal((await deliver('removed')).target, known);
  assert.equal(fs.existsSync(lastFile), false);
  fs.writeFileSync(localFile, JSON.stringify({threadId: second}));
  assert.equal((await deliver('fallback-cwd')).dir, root);
  fs.writeFileSync(lastFile, '{');
  assert.equal((await deliver('invalid-file')).ack, true);
  const historyInvalid = await deliver('history-invalid-config', '/history');
  assert.ok(historyInvalid.text.includes(second));
  assert.doesNotMatch(historyInvalid.text, /【当前】/);
  fs.writeFileSync(lastFile, JSON.stringify({threadId: known, workingDir: root}));
  assert.equal((await deliver('fixed')).target, known);
  fs.unlinkSync(lastFile);
  fs.unlinkSync(localFile);
  const empty = await deliver('no-files');
  assert.equal(empty.target, known);
  assert.equal(empty.dir, root);
  assert.equal((await deliver('pending')).key, empty.key);
  push('fresh','/new');
  await stop('test');
  fs.writeFileSync(path.join(root,'.config.local.json'),JSON.stringify({threadId:known}));
  assert.equal(main.loadTarget(backend).threadId,undefined);
});
