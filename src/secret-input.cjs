'use strict';

const readline = require('node:readline');

function promptSecret(botId, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('请在交互终端启动，或通过环境变量 WECOM_BOT_SECRET 提供长连接 Secret。'));
  }
  const prompt = '机器人 ' + botId.slice(-6) + ' · 请输入长连接 Secret（Ctrl+U 清空，Enter 确认）';
  const wasRaw = Boolean(input.isRaw);
  const wasFlowing = input.readableFlowing === true;
  let characters = [];

  return new Promise((resolve, reject) => {
    let settled = false;
    let pendingDraw;
    let visibleStars = 0;

    function drawMask() {
      pendingDraw = undefined;
      // Reserve the last column so a long paste never wraps the input row.
      const count = Math.min(characters.length, Math.max(0, (output.columns || 80) - 1));
      if (count > visibleStars) {
        output.write('*'.repeat(count - visibleStars));
      } else if (count < visibleStars) {
        readline.cursorTo(output, count);
        readline.clearLine(output, 1);
      }
      visibleStars = count;
    }
    function redraw() {
      if (!pendingDraw) pendingDraw = setImmediate(drawMask);
    }
    function finish(error) {
      if (settled) return;
      settled = true;
      if (pendingDraw) { clearImmediate(pendingDraw); drawMask(); }
      input.removeListener('keypress', onKey);
      input.removeListener('end', onCancel);
      input.removeListener('close', onCancel);
      input.removeListener('error', onError);
      let secret = characters.join('').trim();
      characters.fill('');
      characters = [];
      try {
        input.setRawMode(wasRaw);
        if (!wasFlowing) input.pause();
        output.write('\n');
      } catch (restoreError) {
        error ||= restoreError;
      }
      if (error) { secret = ''; reject(error); }
      else if (!secret) reject(new Error('长连接 Secret 为空。'));
      else resolve(secret);
    }
    function onCancel() { finish(new Error('已取消输入 Secret。')); }
    function onError() { finish(new Error('终端输入失败。')); }
    function onKey(text, key = {}) {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) { onCancel(); return; }
      if (key.name === 'return' || key.name === 'enter') { finish(); return; }
      if (key.ctrl && key.name === 'u') { characters.fill(''); characters = []; redraw(); return; }
      if (key.name === 'backspace' || key.name === 'delete') { characters.pop(); redraw(); return; }
      if (key.ctrl || key.meta || key.name === 'escape') return;
      // Ignore terminal navigation/control sequences; pasted text takes this same path.
      if (!text || /[\x00-\x1f\x7f]/.test(text)) return;
      characters.push(...text);
      redraw();
    }
    input.on('keypress', onKey);
    input.once('end', onCancel);
    input.once('close', onCancel);
    input.once('error', onError);
    try {
      readline.emitKeypressEvents(input);
      input.setRawMode(true);
      output.write(prompt + '\n');
      input.resume();
    } catch { onError(); }
  });
}

module.exports = { promptSecret };
