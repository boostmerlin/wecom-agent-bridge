const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const key = createHash('sha256').update(os.homedir() + __dirname).digest('hex').slice(0, 24);
const address = process.platform === 'win32'
  ? '\\\\.\\pipe\\wecom-codex-' + key
  : path.join(os.tmpdir(), 'wecom-codex-' + key + '.sock');

async function listenControl(getStatus, stop) {
  const server = net.createServer(socket => {
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => {});
    let request = '';
    socket.on('data', bytes => {
      request += bytes.toString('ascii');
      if (request.length > 32) return socket.destroy();
      if (!request.includes('\n')) return;
      if (request.trim() === 'stop') {
        socket.end('stopping\n', stop);
      } else if (request.trim() === 'status') {
        socket.end(JSON.stringify(getStatus()) + '\n');
      } else {
        socket.destroy();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => {
      if (process.platform !== 'win32') {
        try { require('node:fs').chmodSync(address, 0o600); }
        catch (error) { server.close(); reject(error); return; }
      }
      resolve();
    });
  });
  return server;
}

if (require.main === module) {
  const command = process.argv[2] || 'status';
  if (!['stop', 'status'].includes(command)) throw new Error('Use status or stop');
  const socket = net.connect(address, () => socket.write(command + '\n'));
  socket.pipe(process.stdout);
  socket.setTimeout(5000, () => socket.destroy(new Error('timeout')));
  socket.on('error', err => {
    const offline = ['ENOENT', 'ECONNREFUSED'].includes(err.code);
    if (offline && process.argv[3] === '--if-running') return;
    console.error(offline ? 'Bridge is offline.' : 'Control channel unavailable: ' + (err.code || err.message));
    process.exitCode = 1;
  });
}

module.exports = { listenControl };
