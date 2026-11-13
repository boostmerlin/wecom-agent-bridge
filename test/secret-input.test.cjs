'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const { promptSecret } = require('../src/secret-input.cjs');

function terminal(raw = false, flowing = false) {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = raw;
  input.setRawMode = value => { input.isRaw = value; };
  if (flowing) input.resume(); else input.pause();
  let rendered = '';
  const output = new Writable({ write(chunk, _encoding, done) { rendered += chunk.toString(); done(); } });
  output.isTTY = true;
  return { input, output, rendered: () => rendered };
}

test('pasted text is masked, supports backspace and Enter, restores terminal', async () => {
  const tty = terminal();
  const result = promptSecret('fixture-bot', tty);
  tty.input.write('fixture-paste\x7fZ\r');
  assert.equal(await result, 'fixture-pastZ');
  assert.match(tty.rendered(), /\*{13}/);
  assert.doesNotMatch(tty.rendered(), /fixture-paste|fixture-pastZ/);
  assert.equal(tty.input.isRaw, false);
  assert.equal(tty.input.isPaused(), true);
  assert.equal(tty.input.listenerCount('keypress'), 0);
});

test('Ctrl+U clears the whole entry; unicode paste and arrow keys work safely', async () => {
  const tty = terminal(true, true);
  const result = promptSecret('fixture-bot', tty);
  tty.input.write('discard\x15');
  tty.input.write('新密钥\x1b[D\x7f码\r');
  assert.equal(await result, '新密码');
  assert.doesNotMatch(tty.rendered(), /discard|新密钥|新密码/);
  assert.equal(tty.input.isRaw, true);
  assert.equal(tty.input.isPaused(), false);
  tty.input.pause();
});

test('one long paste in a narrow window prints the prompt once and keeps the mask on one row', async () => {
  const tty = terminal();
  tty.output.columns = 14;
  const result = promptSecret('fixture-bot', tty);
  const pasted = 'synthetic'.repeat(12);
  tty.input.write(pasted);
  await new Promise(resolve => setImmediate(resolve));
  tty.input.write('\r');
  assert.equal(await result, pasted);
  const lines = tty.rendered().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[1], '*'.repeat(13));
  assert.equal(lines[2], '');
  assert.doesNotMatch(tty.rendered(), /synthetic/);
});

test('Ctrl+C cancels and restores terminal without returning text', async () => {
  const tty = terminal();
  const result = promptSecret('fixture-bot', tty);
  tty.input.write('cancel-fixture\x03');
  await assert.rejects(result, /已取消/);
  assert.doesNotMatch(tty.rendered(), /cancel-fixture/);
  assert.equal(tty.input.isRaw, false);
  assert.equal(tty.input.listenerCount('keypress'), 0);
});

test('empty Enter, EOF, and non-TTY input fail cleanly', async () => {
  const empty = terminal();
  const emptyResult = promptSecret('fixture', empty);
  empty.input.write('\r');
  await assert.rejects(emptyResult, /为空/);
  const closed = terminal();
  const closedResult = promptSecret('fixture', closed);
  closed.input.end();
  await assert.rejects(closedResult, /已取消/);
  assert.equal(closed.input.isRaw, false);
  const plain = terminal();
  plain.input.isTTY = false;
  await assert.rejects(promptSecret('fixture', plain), /交互终端/);
  assert.equal(plain.rendered(), '');
});
