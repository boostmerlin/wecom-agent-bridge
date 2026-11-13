'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');

test('another backend handles WeCom commands, new turns and replies across a restart', { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-backend-'));
  const src = path.join(root, 'src');
  fs.cpSync(path.join(__dirname, '..', 'src'), src, { recursive: true });
  // Do not even install the Codex adapters in this copy of the bridge.
  fs.rmSync(path.join(src, 'backends'), { recursive: true });
  const sdk = path.join(root, 'node_modules', '@wecom', 'aibot-node-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'index.js'), '');
  const replies = new EventEmitter();
  let socket, stop, failNextFinal = false;
  function inject(file, exports) {
    const id = require.resolve(file);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  inject(sdk, { WSClient: class extends EventEmitter {
    constructor() { super(); socket = this; }
    connect() { this.emit('authenticated'); }
    disconnect() {}
  } });
  inject(path.join(src, 'control.cjs'), { listenControl: async (_, end) => {
    stop = end;
    return { close() {} };
  } });
  inject(path.join(src, 'wecom-reply.cjs'), { createWecomSender: () => async (route, text) => {
    if (failNextFinal && text === '历史结果') {
      failNextFinal = false;
      replies.emit('rejected');
      throw Object.assign(new Error('fixture send rejected'), { definitelyUnsent: true });
    }
    replies.emit('sent', route, text);
  } });
  t.after(async () => {
    await stop?.('test');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const main = require(path.join(src, 'main.cjs'));
  const calls = [];
  const backend = {
    id: 'fixture', name: 'Fixture',
    parseThreadId: value => {
      assert.match(value, /^chat\/[abc]$/);
      return value;
    },
    getWorkingDir: async id => {
      assert.equal(id, 'chat/b');
      return root;
    },
    getThreadTitle: async id => ({ 'chat/a': 'Alpha', 'chat/b': 'Beta' })[id],
    listThreads: async dir => {
      assert.equal(dir, root);
      return [{ id: 'chat/a', name: 'Alpha' }, { id: 'chat/b', name: 'Beta' }];
    },
    async submit({ threadId, workingDir, prompt, onCreated, onStarted }) {
      calls.push({ threadId, workingDir, prompt });
      if (!threadId) onCreated(calls.length === 1 ? 'chat/a' : 'chat/c');
      onStarted();
      return { state: 'completed', text: prompt.includes('保存失败回执') ? '历史结果' : '收到' };
    },
  };
  const state = path.join(root, '.state');
  fs.mkdirSync(state);
  const codexTarget = JSON.stringify({ threadId: 'existing-codex-chat', workingDir: root });
  fs.writeFileSync(path.join(state, 'last-target.json'), codexTarget);
  fs.writeFileSync(path.join(root, '.config.local.json'), JSON.stringify({ workingDir: root }));
  async function start() {
    await main.runBridge({ backend, ...await main.resolveTarget(backend), botId: 'bot', ownerId: 'me', secret: 'test' });
  }
  let serial = 0;
  async function send(text, group = false) {
    const route = { chatId: group ? 'team' : 'me', chatType: group ? 'group' : 'single', senderId: 'me' };
    const signal = AbortSignal.timeout(4000);
    const done = new Promise((resolve, reject) => {
      function listen(origin, answer) {
        if (origin.chatId !== route.chatId) return;
        replies.off('sent', listen);
        resolve([origin, answer]);
      }
      replies.on('sent', listen);
      signal.addEventListener('abort', () => { replies.off('sent', listen); reject(signal.reason); }, { once: true });
    });
    const keepAlive = setTimeout(() => {}, 4100);
    try {
      socket.emit('message', { body: { msgid: String(++serial), chattype: route.chatType, chatid: route.chatId,
        from: { userid: 'me' }, msgtype: 'text', text: { content: text } } });
      const [origin, answer] = await done;
      assert.deepEqual(origin, route);
      return answer;
    } finally { clearTimeout(keepAlive); }
  }
  await start();
  assert.equal(await send('first'), '收到');
  assert.match(await send('/threads'), /【当前】Alpha\nchat\/a/);
  await stop('restart');
  await start();
  assert.equal(await send('continue', true), '收到');
  assert.match(await send('/thread chat/b'), /chat\/b/);
  assert.equal(await send('switched'), '收到');
  assert.match(await send('/new'), /新聊天/);
  assert.equal(await send('new', true), '收到');
  assert.deepEqual(calls.map(turn => turn.threadId), [undefined, 'chat/a', 'chat/b', undefined]);
  assert.ok(calls.every(turn => turn.workingDir === root));
  assert.match(calls[1].prompt, /企微群聊/);
  const before = calls.length;
  const help = await send('/help', true);
  for (const name of ['/status', '/bind', '/retry', '/threads', '/save', '/memory', '/forget']) assert.ok(help.includes(name));
  const groupStatus = await send('/status', true);
  assert.match(groupStatus, /上一条任务 → chat\/c/);
  assert.match(groupStatus, /投递：已完成；回复：已回发/);
  assert.match(groupStatus, /附件：无/);
  assert.match(await send('/bind', true), /本会话已绑定/);
  assert.match(await send('/thread chat/b'), /已切换聊天/);
  await stop('restart');
  await start();
  assert.match(await send('/status', true), /下一条消息 → chat\/c（会话绑定）/);
  assert.match(await send('/status'), /下一条消息 → Beta.*\.state/);
  assert.match(await send('/thread chat/b', true), /已切换聊天/);
  assert.match(await send('/status', true), /下一条消息 → Beta[\s\S]+上一条任务 → chat\/c/);
  assert.match(await send('/retry', true), /没有可安全重试/);
  const project = path.join(root, 'project two');
  fs.mkdirSync(project);
  assert.match(await send('/bind ' + project, true), /project two/);
  assert.match(await send('/status', true), /等待新建聊天[\s\S]+project two/);
  fs.rmdirSync(project);
  assert.match(await send('directory was removed', true), /绑定目录/);
  assert.match(await send('/help'), /桥接指令/);
  assert.match(await send('/status', true), /绑定目录/);
  assert.match(await send('/bind ' + root, true), /已绑定/);
  assert.match(await send('/status', true), /会话绑定/);
  fs.mkdirSync(project);
  assert.match(await send('/bind ' + project, true), /已绑定/);
  fs.rmdirSync(project);
  assert.match(await send('/bind off', true), /默认目标/);
  assert.match(await send('/status', true), /下一条消息 → Beta.*\.state/);
  assert.equal(calls.length, before);
  // Retire the original worker, then reuse the same thread in another directory.
  fs.mkdirSync(project);
  const lastFile = path.join(state, 'backends', 'fixture', 'last-target.json');
  const switchTo = (threadId, workingDir) => fs.writeFileSync(lastFile, JSON.stringify({ threadId, workingDir }));
  switchTo('chat/a', root);
  await send('/help', true);
  switchTo('chat/b', project);
  await send('/help', true);
  const history = await send('/status');
  assert.match(history, /上一条任务 → Beta/);
  assert.match(history, /投递：已完成；回复：已回发/);

  // Fail only the final send in directory A, then retry from directory B after restart.
  switchTo('chat/b', root);
  failNextFinal = true;
  const rejected = once(replies, 'rejected');
  socket.emit('message', { body: { msgid: String(++serial), chattype: 'group', chatid: 'team',
    from: { userid: 'me' }, msgtype: 'text', text: { content: '保存失败回执' } } });
  await rejected;
  switchTo('chat/b', project);
  await send('/help');
  await stop('restart');
  await start();
  assert.match(await send('/status', true), /投递：已完成；回复：失败/);
  const turnsBeforeRetry = calls.length;
  const responses = [];
  const retried = new Promise(resolve => {
    function collect(origin, text) {
      assert.equal(origin.chatId, 'team');
      responses.push(text);
      if (responses.length === 2) { replies.off('sent', collect); resolve(); }
    }
    replies.on('sent', collect);
  });
  socket.emit('message', { body: { msgid: String(++serial), chattype: 'group', chatid: 'team',
    from: { userid: 'me' }, msgtype: 'text', text: { content: '/retry' } } });
  await retried;
  assert.ok(responses.includes('历史结果'));
  assert.ok(responses.some(text => text.includes('未发出的分段')));
  assert.equal(calls.length, turnsBeforeRetry);
  assert.match(await send('/status', true), /投递：已完成；回复：已回发/);

  // Both snapshots refer to one thread. The group is answered before the slow status.
  let lookups = 0;
  const started = Promise.withResolvers();
  backend.getThreadTitle = () => { lookups++; started.resolve(); return new Promise(() => {}); };
  const answers = [];
  const observe = (origin, text) => answers.push({ chatId: origin.chatId, text });
  replies.on('sent', observe);
  const slow = send('/status');
  await started.promise;
  assert.match(await send('/help', true), /桥接指令/);
  // send() listens for the first matching conversation's reply.
  assert.match(await slow, /下一条消息 → chat\/b/);
  replies.off('sent', observe);
  assert.deepEqual(answers.map(answer => answer.chatId), ['team', 'me']);
  assert.equal(lookups, 1);
  assert.equal(fs.readFileSync(path.join(state, 'last-target.json'), 'utf8'), codexTarget);
});
