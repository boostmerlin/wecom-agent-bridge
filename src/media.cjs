const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const mediaDomains = ['qq.com', 'qpic.cn', 'qlogo.cn', 'wecom.work', 'wechat.com'];

const botImageHost = 'ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com';

function checkMediaUrl(value) {
  const url = typeof value === 'string' && URL.canParse(value) ? new URL(value) : null;
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password ||
      (url.hostname !== botImageHost && !mediaDomains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain)))) {
    throw Object.assign(new Error('企微媒体地址无效或来源不受支持'), { mediaReason: 'unsupported_url' });
  }
}

function extension(filename, buffer) {
  const ext = typeof filename === 'string' ? path.win32.extname(filename).toLowerCase() : '';
  if (/^\.[a-z0-9]{1,12}$/.test(ext)) return ext;
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
  if (buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return '.jpg';
  if (/^GIF8[79]a/.test(buffer.toString('ascii', 0, 6))) return '.gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buffer.toString('ascii', 0, 5) === '%PDF-') return '.pdf';
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    if (/^avif$|^avis$/.test(brand)) return '.avif';
    if (/^hei[cf]$|^mif1$|^msf1$/.test(brand)) return '.heif';
    if (brand === 'qt  ') return '.mov';
    if (brand === 'M4A ') return '.m4a';
    if (/^mp4|^iso|^avc1$|^M4V $/.test(brand)) return '.mp4';
  }
  if (buffer.toString('ascii', 0, 5) === '#!AMR') return '.amr';
  return '.bin';
}

async function cachedFile(directory) {
  const stat = await fs.lstat(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error('媒体缓存目录无效');
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isFile() || !/^attachment\.[a-z0-9]{1,12}$/.test(entries[0].name)) {
    throw new Error('媒体缓存文件无效');
  }
  return path.join(directory, entries[0].name);
}

function createMediaStore(client, rootDir, onFailure = () => {}) {
  const root = path.resolve(rootDir);
  const pending = new Map();

  async function download(directory, { url, aeskey }) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (path.relative(root, await fs.realpath(root))) throw new Error('媒体目录不可经过符号链接');
    const cached = await cachedFile(directory);
    if (cached) return cached;
    checkMediaUrl(url);
    let result;
    try {
      const key = typeof aeskey === 'string' && /^[a-f0-9]{64}$/i.test(aeskey)
        ? Buffer.from(aeskey, 'hex').toString('base64') : aeskey;
      result = await client.downloadFile(url, key);
    } catch {
      // The SDK error may include the signed download URL.
      throw Object.assign(new Error('企微媒体下载或解密失败'), { mediaReason: 'download_or_decrypt' });
    }
    if (!Buffer.isBuffer(result?.buffer)) throw new Error('企微媒体下载结果无效');
    const name = 'attachment' + extension(result.filename, result.buffer);
    const stage = await fs.mkdtemp(path.join(root, '.partial-'));
    try {
      await fs.writeFile(path.join(stage, name), result.buffer, { mode: 0o600, flag: 'wx' });
      // Publish the directory and extension together; a competing receiver may finish first.
      try {
        await fs.rename(stage, directory);
      } catch (error) {
        const existing = await cachedFile(directory);
        if (existing) return existing;
        throw error;
      }
      return path.join(directory, name);
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }

  return async function saveMedia(input) {
    const { msgId, part } = input;
    if (typeof msgId !== 'string' || !msgId ||
        !(Number.isSafeInteger(part) || (typeof part === 'string' && part))) {
      throw new Error('企微媒体缺少消息或附件编号');
    }
    const key = createHash('sha256').update(JSON.stringify([msgId, String(part)])).digest('hex');
    if (pending.has(key)) return pending.get(key);
    const job = download(path.join(root, key), input);
    pending.set(key, job);
    try {
      return await job;
    } catch (error) {
      onFailure({ msgId, part, kind: input.kind, reason: error.mediaReason || 'cache_io' });
      throw error;
    } finally {
      pending.delete(key);
    }
  };
}

module.exports = { createMediaStore };
