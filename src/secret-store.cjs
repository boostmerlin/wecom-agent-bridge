'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function secretStore(botId, directory = path.join(__dirname, '..')) {
  const key = createHash('sha256').update(botId).digest('hex');
  const state = path.join(directory, '.state');
  const file = path.join(state, 'bot-' + key + '.secret');

  function read() {
    try { return fs.readFileSync(file, 'utf8').trim() || null; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  function save(secret) {
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, secret, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  return { read, save };
}

module.exports = { secretStore };
