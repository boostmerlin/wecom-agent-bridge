'use strict';

const { resolveCodex, resolveClaude } = require('../launcher-tools.cjs');

async function loadBackend(id) {
  if (id === 'codex') return require('./codex.cjs').createCodexBackend({ codexPath: await resolveCodex() });
  if (id === 'claude') return require('./claude.cjs').createClaudeBackend({ claudePath: await resolveClaude() });
  throw new Error('Unsupported backend');
}

module.exports = { loadBackend };
