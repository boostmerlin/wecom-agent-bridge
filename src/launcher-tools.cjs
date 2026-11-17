'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const executionOptions = { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 };

function pathDirectories() {
  return (process.env.PATH || '').split(path.delimiter)
    .map(value => value.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

async function isFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function supportsBridgeCli(file) {
  if (!path.isAbsolute(file) || !await isFile(file)) return false;
  try {
    const { stdout, stderr } = await execute(file, ['exec', 'resume', '--help'], executionOptions);
    const help = stdout + stderr;
    if (!/SESSION_ID/.test(help) || !/--json/.test(help) || !/stdin/.test(help)) return false;
    const queue = await execute(file, ['queue', '--help'], executionOptions);
    const queueHelp = queue.stdout + queue.stderr;
    return /--thread\b/.test(queueHelp) && /--message\b/.test(queueHelp) && /--resume\b/.test(queueHelp);
  } catch { return false; }
}

async function resolveCodex() {
  const explicit = process.env.CODEX_CLI_PATH?.trim().replace(/^"(.*)"$/, '$1');
  if (explicit) {
    if (await supportsBridgeCli(explicit)) return path.resolve(explicit);
    throw new Error('CODEX_CLI_PATH must support exec resume --json with stdin and queue --thread --message --resume.');
  }

  for (const directory of pathDirectories()) {
    const file = path.resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (await supportsBridgeCli(file)) return file;
  }

  if (process.platform !== 'win32') {
    if (process.platform === 'darwin') {
      const bundled = '/Applications/Codex.app/Contents/Resources/codex';
      if (await supportsBridgeCli(bundled)) return bundled;
    }
    throw new Error('请将支持 exec resume 和 queue --resume 的 codex 加入 PATH，或设置 CODEX_CLI_PATH。');
  }

  // Desktop's executable is not necessarily on a standalone Node process's PATH.
  // Query the registered app, rather than pinning its versioned WindowsApps path.
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const command = '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); Get-AppxPackage -Name OpenAI.Codex | ForEach-Object { $_.InstallLocation } | ConvertTo-Json -Compress';
    const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], executionOptions);
    const locations = JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]');
    for (const directory of Array.isArray(locations) ? locations : [locations]) {
      if (typeof directory !== 'string' || !path.isAbsolute(directory)) continue;
      const file = path.join(directory, 'app', 'resources', 'codex.exe');
      if (await supportsBridgeCli(file)) return file;
    }
  } catch { /* A missing Appx query must still produce the actionable error below. */ }
  throw new Error('No Codex CLI supporting exec resume --json with stdin and queue --thread --message --resume was found. Update Codex desktop or set CODEX_CLI_PATH.');
}

// All Claude launches use execFile/spawn with shell:false. A Windows npm shim
// resolves to Node plus its real JS entry, never to a .cmd or PowerShell process.
async function claudeCommand(file) {
  if (!path.isAbsolute(file) || !await isFile(file)) return undefined;
  if (/\.(?:cmd|ps1)$/i.test(file)) {
    const packageRoot = path.join(path.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code');
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.claude;
      if (manifest.name !== '@anthropic-ai/claude-code' || typeof bin !== 'string') return undefined;
      const entry = path.resolve(packageRoot, bin);
      if (await isFile(entry)) return { file: process.execPath, prefix: [entry] };
    } catch { /* The next PATH entry may contain a valid installation. */ }
    return undefined;
  }
  return /\.(?:[cm]?js)$/i.test(file)
    ? { file: process.execPath, prefix: [file] }
    : { file, prefix: [] };
}

async function checkClaude(cli) {
  const options = { ...executionOptions, shell: false };
  let help;
  try {
    const { stdout, stderr } = await execute(cli.file, [...cli.prefix, '--help'], options);
    help = stdout + stderr;
  } catch { throw new Error('无法运行 Claude CLI --help，请检查 CLAUDE_CLI_PATH 或 PATH。'); }
  const required = ['--print', '--output-format', '--verbose', '--resume', '--permission-prompts'];
  const missing = required.filter(flag => !new RegExp(flag + '(?=[\\s,=<>\\[\\]]|$)').test(help));
  if (missing.length) throw new Error('Claude CLI 缺少桥接所需参数：' + missing.join(', ') + '。请更新 Claude Code。');
  try {
    const { stdout } = await execute(cli.file, [...cli.prefix, 'auth', 'status'], options);
    const status = JSON.parse(stdout.trim());
    if (status.loggedIn !== true) throw new Error('not logged in');
  } catch { throw new Error('Claude CLI 尚未登录或无法核对授权，请运行 claude auth status 并使用 claude auth login 登录。'); }
  return cli;
}

async function resolveClaude() {
  const explicit = process.env.CLAUDE_CLI_PATH?.trim().replace(/^"(.*)"$/, '$1');
  if (explicit) {
    const cli = await claudeCommand(explicit);
    if (!cli) throw new Error('CLAUDE_CLI_PATH 必须是 Claude CLI 的绝对文件路径（可使用 npm shim 或真实 JS 入口）。');
    return checkClaude(cli);
  }
  for (const directory of pathDirectories()) {
    const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.ps1'] : ['claude'];
    for (const name of names) {
      const cli = await claudeCommand(path.resolve(directory, name));
      if (cli) return checkClaude(cli);
    }
  }
  throw new Error('未找到 Claude CLI。请将 claude 加入 PATH，或设置 CLAUDE_CLI_PATH 为绝对路径。');
}

async function resolveWecom() {
  for (const directory of pathDirectories()) {
    if (process.platform !== 'win32') {
      const executable = path.resolve(directory, 'wecom-cli');
      if (await isFile(executable)) {
        try { await fs.access(executable, fs.constants.X_OK); return { file: executable, prefix: [] }; }
        catch { /* Continue looking for an executable on PATH. */ }
      }
      continue;
    }
    // npm's Windows shim sits beside node_modules. Run the declared JS entry
    // with this Node executable; .cmd files cannot be execFile'd without a shell.
    if (await isFile(path.join(directory, 'wecom-cli.cmd'))) {
      const packageRoot = path.join(directory, 'node_modules', '@wecom', 'cli');
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
        const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['wecom-cli'];
        if (manifest.name === '@wecom/cli' && typeof bin === 'string') {
          const entry = path.resolve(packageRoot, bin);
          if (await isFile(entry)) return { file: process.execPath, prefix: [entry] };
        }
      } catch { /* Try a native executable or the next PATH installation. */ }
    }
    const native = path.resolve(directory, 'wecom-cli.exe');
    if (await isFile(native)) return { file: native, prefix: [] };
  }
  throw new Error('Could not find the installed @wecom/cli executable on PATH. Install it with npm install -g @wecom/cli.');
}

async function readIdentity() {
  const cli = await resolveWecom();
  let authText;
  try {
    ({ stdout: authText } = await execute(cli.file, [...cli.prefix, 'auth', 'show'], executionOptions));
  } catch { throw new Error('Could not read current WeCom authorization. This launcher never initializes authorization.'); }
  const botMatch = authText.match(/^\s*bot[\s_-]*id\s*[:\uFF1A]\s*([^\s]+)\s*$/im);
  if (!botMatch) throw new Error('Could not identify the currently configured WeCom bot.');

  let identity;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { stdout } = await execute(cli.file, [...cli.prefix, 'identity', 'whoami'], { ...executionOptions, timeout: 60_000 });
      identity = JSON.parse(stdout.replace(/^\uFEFF/, ''));
      break;
    } catch (error) {
      const diagnostic = String(error.stdout || '') + '\n' + String(error.stderr || '');
      if (attempt === 1 && (error.killed || /timed?\s*out|ECONNRESET|ETIMEDOUT|fetch failed|error sending request|超时/i.test(diagnostic))) continue;
      throw new Error('未能核对企微身份，请运行 wecom-cli identity whoami 检查连接和授权。');
    }
  }
  if (identity.errcode || identity.error) throw new Error('WeCom identity verification failed. Check authorization in WeCom.');
  const context = typeof identity.extra_identity_context === 'string' ? identity.extra_identity_context : '';
  const fields = [...context.matchAll(/^\u540D\u5B57[\uFF1A:]\s*([^\r\n]+)\r?\nID[\uFF1A:]\s*([^\r\n]+)/gm)];
  const botId = botMatch[1].trim();
  if (fields.length !== 2 || fields[0][2].trim() !== botId) {
    throw new Error('The configured WeCom bot and authenticated identity do not match.');
  }
  const ownerId = fields[1][2].trim();
  if (!ownerId) throw new Error('The authenticated WeCom owner is missing.');
  return { botId, ownerId };
}

module.exports = { resolveCodex, resolveClaude, readIdentity, resolveWecom };
