const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMediaStore } = require('../src/media.cjs');

const attachment = {
  msgId: 'msg/../001', part: 1, kind: 'file',
  url: 'https://wwfile.work.weixin.qq.com/download?signature=test-only', aeskey: 'fake-key'
};

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-attachment-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('saves SDK bytes and filename extension inside the cache, reuses concurrent and persisted files', async t => {
  const root = await temporaryRoot(t);
  const bytes = Buffer.from('附件正文');
  const downloadFile = t.mock.fn(async () => ({ buffer: bytes, filename: '../../恶意目录/报告.DOCX' }));
  const save = createMediaStore({ downloadFile }, root);
  const [first, duplicate] = await Promise.all([save(attachment), save(attachment)]);
  assert.equal(duplicate, first);
  const restarted = createMediaStore({ downloadFile }, root);
  assert.equal(await restarted({ ...attachment, url: '' }), first);
  assert.equal(downloadFile.mock.callCount(), 1);
  assert.deepEqual(downloadFile.mock.calls[0].arguments, [attachment.url, attachment.aeskey]);
  assert.deepEqual(await fs.readFile(first), bytes);
  assert.match(path.relative(root, first).split(path.sep).join('/'), /^[a-f0-9]{64}\/attachment\.docx$/);
  assert.notEqual(await save({ ...attachment, part: 2 }), first);
  assert.notEqual(await save({ ...attachment, msgId: 'next-msg' }), first);
});

test('detects a PNG when the filename is absent or unusable, allows the image CDN', async t => {
  const root = await temporaryRoot(t);
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const save = createMediaStore({ downloadFile: async () => ({ buffer: bytes }) }, root);
  const result = await save({ ...attachment, kind: 'image', url: 'https://wework.qpic.cn/image' });
  assert.equal(path.extname(result), '.png');
});

test('refuses unrelated URLs and private or non-HTTPS addresses before calling the SDK', async t => {
  const root = await temporaryRoot(t);
  const downloadFile = t.mock.fn();
  const save = createMediaStore({ downloadFile }, root);
  for (const url of ['file:///C:/system', 'https://127.0.0.1/x', 'https://[::1]/x',
    'https://other-1258476243.cos.ap-guangzhou.myqcloud.com/x',
    'https://ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com.attacker.invalid/x',
    'https://10.2.3.4/x', 'https://localhost/x', 'https://qq.com.example.org/x',
    'https://name:pw@wework.qpic.cn/x', 'http://wework.qpic.cn/x']) {
    await assert.rejects(save({ ...attachment, url }), /来源/);
  }
  assert.equal(downloadFile.mock.callCount(), 0);
});

test('redacts download errors and retries the same part without partial files', async t => {
  const root = await temporaryRoot(t);
  let fail = true;
  const save = createMediaStore({ downloadFile: async () => {
    if (fail) throw Error(attachment.url + attachment.aeskey);
    return { buffer: Buffer.from('content') };
  } }, root);
  await assert.rejects(save(attachment), { message: '企微媒体下载或解密失败' });
  assert.deepEqual(await fs.readdir(root), []);
  fail = false;
  assert.equal(path.extname(await save(attachment)), '.bin');
});

test('does not follow a cached directory junction to outside the media root', async t => {
  const root = await temporaryRoot(t);
  const cache = path.join(root, 'cache');
  const save = createMediaStore({ downloadFile: async () => ({ buffer: Buffer.from('a') }) }, cache);
  const file = await save(attachment);
  const slot = path.dirname(file);
  const moved = path.join(root, 'outside');
  await fs.rename(slot, moved);
  await fs.symlink(moved, slot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(save(attachment), /缓存目录无效/);
});

test('mixed image and text from the WeCom COS host reach Codex with a decrypted PNG path', async t => {
  const { formatIncoming } = require('../src/incoming.cjs');
  const { WSClient } = require('@wecom/aibot-node-sdk');
  const { createCipheriv, randomBytes } = require('node:crypto');
  const root = await temporaryRoot(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4R8AAAAASUVORK5CYII=', 'base64');
  const key = randomBytes(32);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const pad = 32 - png.length % 32;
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([png, Buffer.alloc(pad, pad)])), cipher.final()]);
  const client = new WSClient({ botId: 'bot', secret: 'fixture', logger: { debug() {}, info() {}, warn() {}, error() {} } });
  t.mock.method(client.apiClient, 'downloadFileRaw', async () => ({ buffer: encrypted }));
  const url = 'https://ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com/test';
  for (const encoding of ['hex', 'base64']) {
    const body = { msgid: encoding, chattype: 'single', from: { userid: 'me' }, msgtype: 'mixed',
      mixed: { msg_item: [{ msgtype: 'image', image: { url, aeskey: key.toString(encoding) } },
        { msgtype: 'text', text: { content: '请查看图片' } }] } };
    const result = await formatIncoming(body, { botId: 'bot', ownerId: 'me', saveMedia: createMediaStore(client, root) });
    const file = /图片：([^\n]+\.png)\n请查看图片/.exec(result.text)?.[1];
    assert.ok(file);
    assert.deepEqual(await fs.readFile(file), png);
  }
});
