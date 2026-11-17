'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { taskTimeout } = require('./process-lifecycle.cjs');
const root = path.join(__dirname, '..');

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function stateDirectory(directory, backend) {
  if (typeof backend.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(backend.id)) throw new Error('Invalid backend ID');
  // Codex already has active queues at the original location.
  const base = path.join(directory, '.state');
  return backend.id === 'codex' ? base : path.join(base, 'backends', backend.id);
}

function storageKey(id) {
  return uuid.test(id) ? id : 's-' + createHash('sha256').update(id).digest('hex').slice(0, 32);
}

function parseQueueKey(key) {
  if (typeof key !== 'string' || !uuid.test(key)) throw new Error('Invalid local queue ID');
  return key.toLowerCase();
}

function checkWorkingDir(workingDir) {
  if (typeof workingDir !== 'string' || !path.isAbsolute(workingDir) || !fs.statSync(workingDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('工作目录必须是本机存在的绝对目录。请检查 .config.local.json 或目标聊天的工作目录。');
  }
  return workingDir;
}

function readSettings(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('需要 JSON 对象');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(file + '：' + error.message);
  }
}

function readBackend(directory = root) {
  const selected = readSettings(path.join(directory, '.config.local.json')).backend;
  if (selected === undefined) return 'codex';
  if (selected !== 'codex' && selected !== 'claude') throw new Error('backend 必须是 codex 或 claude。');
  return selected;
}

function readTaskTimeout(directory = root) {
  return taskTimeout(readSettings(path.join(directory, '.config.local.json')).taskTimeoutMs);
}

function backendSettings(config, backend) {
  if (config.backends !== undefined && (!config.backends || typeof config.backends !== 'object' || Array.isArray(config.backends))) {
    throw new Error('.config.local.json 中的 backends 必须是对象。');
  }
  const scoped = config.backends?.[backend.id];
  if (scoped !== undefined && (!scoped || typeof scoped !== 'object' || Array.isArray(scoped))) {
    throw new Error('.config.local.json 中的 backends.' + backend.id + ' 必须是对象。');
  }
  // Empty scoped fields intentionally clear a legacy Codex target.
  const legacy = backend.id === 'codex' || (backend.id !== 'claude' && config.backends === undefined);
  return { ...(legacy ? config : {}), ...scoped };
}

function loadTarget(backend, directory = root, defaults) {
  const last = readSettings(path.join(stateDirectory(directory, backend), 'last-target.json'));
  const present = value => value != null && (typeof value !== 'string' || value.trim() !== '');
  const lastDir = last.workingDir;
  const local = present(last.threadId) && present(lastDir) ? {} :
    backendSettings(defaults ?? readSettings(path.join(directory, '.config.local.json')), backend);
  const id = last.queueKey && !present(last.threadId) ? undefined : (present(last.threadId) ? last.threadId : local.threadId);
  const dir = present(lastDir) ? lastDir : local.workingDir;
  return {
    sources: {
      thread: last.queueKey || present(last.threadId) ? '.state' : present(id) ? '.config.local.json' : '自动新建',
      directory: present(lastDir) ? '.state' : present(dir) ? '.config.local.json' : present(id) ? '聊天记录' : '启动目录',
    },
    threadId: present(id) ? backend.parseThreadId(id) : undefined,
    workingDir: present(dir) ? checkWorkingDir(dir) : undefined,
    queueKey: !present(id) && last.queueKey ? parseQueueKey(last.queueKey) : undefined,
  };
}

async function resolveTarget(backend, defaults) {
  const target = loadTarget(backend, root, defaults);
  if (!target.workingDir) {
    target.workingDir = target.threadId
      ? checkWorkingDir(await backend.getWorkingDir(target.threadId))
      : process.cwd();
  }
  return target;
}

function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

function rememberTarget(backend, { threadId, workingDir, queueKey }, directory = root) {
  const target = { threadId: threadId ?? null, workingDir };
  if (!threadId && queueKey) target.queueKey = queueKey;
  writeState(path.join(stateDirectory(directory, backend), 'last-target.json'), target);
}

function targetRecord({ threadId, queueKey, workingDir }) {
  return { threadId, queueKey, workingDir };
}

module.exports = { root, readSettings, stateDirectory, storageKey, parseQueueKey, checkWorkingDir, readBackend, readTaskTimeout, loadTarget, resolveTarget, writeState, rememberTarget, targetRecord };
