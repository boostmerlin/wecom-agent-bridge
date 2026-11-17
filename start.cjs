const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { promptSecret } = require('./src/secret-input.cjs');
const { readBackend, readTaskTimeout, resolveTarget, runBridge } = require('./src/main.cjs');
const { readIdentity, resolveCodex, resolveClaude } = require('./src/launcher-tools.cjs');

const { secretStore } = require('./src/secret-store.cjs');

function printTarget({ workingDir, threadId }, name) {
  console.log(name + ' 工作目录  ' + workingDir);
  console.log(name + ' 聊天 ID   ' + (threadId || '收到首条消息时创建'));
}

async function start() {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === '--check';
  const replace = args.length === 1 && args[0] === '--replace-secret';
  if (args.length && !check && !replace) throw new Error('用法：node start.cjs [--check | --replace-secret]');
  let secret = process.env.WECOM_BOT_SECRET?.trim();
  delete process.env.WECOM_BOT_SECRET;
  if (!check) {
    const control = path.join(__dirname, 'src', 'control.cjs');
    const status = execFileSync(process.execPath, [control, 'status', '--if-running'], { encoding: 'utf8', windowsHide: true }).trim();
    if (status) {
      console.log('Bridge already running. ' + status);
      const running = JSON.parse(status);
      printTarget(running, running.backendName || 'Codex');
      return;
    }
  }
  const backendId = readBackend();
  const taskTimeoutMs = readTaskTimeout();
  const backend = backendId === 'claude'
    ? require('./src/backends/claude.cjs').createClaudeBackend({ claudePath: await resolveClaude() })
    : require('./src/backends/codex.cjs').createCodexBackend({ codexPath: await resolveCodex() });
  const target = await resolveTarget(backend);
  printTarget(target, backend.name);
  console.log('正在核对企微机器人身份…');
  const { botId, ownerId } = await readIdentity();
  if (check) {
    console.log('检查通过。');
    return;
  }
  let onAuthenticated;
  if (!secret) {
    const store = secretStore(botId);
    if (!replace) {
      try { secret = store.read(); }
      catch { console.warn('无法读取已保存的 Secret，请重新输入。'); }
    }
    if (!secret) {
      secret = await promptSecret(botId);
      onAuthenticated = () => {
        try { store.save(secret); console.log('机器人 Secret 已保存到 .state。'); }
        catch { console.warn('机器人已连接，但 Secret 保存失败，下次启动需要重新输入。'); }
      };
    }
  }
  await runBridge({ ...target, backend, botId, ownerId, secret, onAuthenticated, taskTimeoutMs });
}

start().catch(error => {
  console.error(error.code === 'EADDRINUSE' ? 'Bridge already running.' : error.message);
  process.exitCode = 1;
});
