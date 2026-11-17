'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { processOptions, watchProcess } = require('../src/process-lifecycle.cjs');

test('cancellation terminates a CLI and its tool child, including tools ignoring SIGTERM', { timeout: 10000 }, async t => {
  const controller = new AbortController();
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const tool = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    tool.once('message', () => process.send(tool.pid));
    setInterval(() => {}, 1000);
  `], { ...processOptions, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  let toolPid;
  t.after(() => {
    child.kill('SIGKILL');
    if (toolPid) { try { process.kill(toolPid, 'SIGKILL'); } catch {} }
  });
  const lifecycle = watchProcess(child, { signal: controller.signal, timeoutMs: 5000 });
  [toolPid] = await once(child, 'message');
  const closed = once(child, 'close');
  controller.abort('task_cancelled');
  await closed;
  // Allow the OS to reap children; do not consider the CLI's exit alone sufficient.
  const until = Date.now() + 2500;
  let alive = true;
  while (alive && Date.now() < until) {
    try { process.kill(toolPid, 0); } catch { alive = false; }
    if (alive) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(alive, false, 'tool process survived cancellation');
  assert.equal(lifecycle.reason, 'task_cancelled');
});
