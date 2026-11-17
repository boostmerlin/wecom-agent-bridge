'use strict';

const { spawn } = require('node:child_process');
const { join } = require('node:path');

const defaultTimeoutMs = 30 * 60 * 1000;

function taskTimeout(value = defaultTimeoutMs) {
  if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
    throw new Error('taskTimeoutMs 必须是 0 到 2147483647 的整数（毫秒），0 表示关闭超时。');
  }
  return value;
}

// Each POSIX CLI owns a process group so cancelling also stops its tools/hooks.
// Windows needs taskkill /T: child.kill() alone would leave tool processes alive.
const processOptions = { detached: process.platform !== 'win32' };

function watchProcess(child, { signal, timeoutMs }) {
  let reason, closed = false, timer;
  function kill(signalName) {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signalName);
      else child.kill(signalName);
    } catch (error) {
      if (error.code !== 'ESRCH') child.kill(signalName);
    }
  }
  function stop(why) {
    if (closed || reason) return;
    reason = why;
    if (!child.pid) return;
    if (process.platform === 'win32') {
      const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', timeout: 5000 });
      killer.once('error', () => { if (!closed) kill('SIGKILL'); });
      killer.once('exit', code => { if (code !== 0 && !closed) kill('SIGKILL'); });
    } else kill('SIGKILL');
  }
  const abort = () => stop(signal.reason === 'bridge_stopped' ? 'bridge_stopped' : 'task_cancelled');
  child.once('close', () => {
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  if (timeoutMs) { timer = setTimeout(() => stop('task_timeout'), timeoutMs); timer.unref(); }
  return { get reason() { return reason; } };
}

module.exports = { taskTimeout, processOptions, watchProcess };
