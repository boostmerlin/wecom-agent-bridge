'use strict';

const { stripVTControlCharacters } = require('node:util');

// CLI errors can echo credentials or the submitted prompt. Keep a bounded,
// redacted diagnostic for local logs, never for the remote failure notice.
function createDiagnostics(command, prompt, onDiagnostic = () => {}) {
  const privateValues = Object.entries(process.env)
    .filter(([key, value]) => /secret|token|password|api.?key|authorization/i.test(key) && value.length >= 4)
    .map(([, value]) => value);
  privateValues.push(...prompt.split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 4));
  privateValues.sort((a, b) => b.length - a.length);
  let stderr = '', structuredError = '';

  function redact(value) {
    let text = stripVTControlCharacters(value);
    for (const secret of privateValues) text = text.split(secret).join('[redacted]');
    return text
      .replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/((?:["']?)[\w-]*(?:secret|token|password|api[_-]?key|authorization)[\w-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[redacted]')
      .replace(/\b(?:sk-|gh[pousr]_|github_pat_|glpat-)[\w-]+/g, '[redacted]')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  }

  return {
    capture(chunk) { stderr = (stderr + chunk).slice(-8192); },
    error(message) { if (typeof message === 'string') structuredError = redact(message).slice(0, 1200); },
    report(exitCode, signal, error) {
      const summary = redact(error?.message || structuredError || stderr)
        .split(/\r?\n/).filter(line => line.trim()).slice(-4).join(' | ').slice(0, 1200);
      try {
        onDiagnostic({ command, exitCode: exitCode ?? null, signal: signal ?? null,
          ...(error?.code && { errorCode: error.code }), ...(summary && { errorSummary: summary }) });
      } catch { /* Diagnostics must not change delivery or cause duplicate execution. */ }
    },
  };
}

module.exports = { createDiagnostics };
