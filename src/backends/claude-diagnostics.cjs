'use strict';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const number = value => Number.isFinite(value) && value >= 0;

// Explicit allowlists keep prompts, tool arguments and arbitrary SDK fields out of logs.
function createClaudeDiagnostics(onWarning = () => {}) {
  const stats = {};
  return {
    stats,
    observe(event) {
      if (event.type === 'system' && event.subtype === 'init' &&
          typeof event.model === 'string' && /^[\w.:/-]{1,100}$/.test(event.model)) stats.model = event.model;
      if (event.type === 'result') {
        for (const [source, target] of Object.entries({ duration_ms: 'durationMs', duration_api_ms: 'durationApiMs',
          total_cost_usd: 'costUsd', num_turns: 'numTurns' })) {
          if (number(event[source])) stats[target] = event[source];
        }
        if (event.usage) {
          stats.usage = {};
          for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
            if (number(event.usage[key])) stats.usage[key] = event.usage[key];
          }
        }
        if (Array.isArray(event.permission_denials)) stats.permissionDenials = {
          count: event.permission_denials.length,
          tools: [...new Set(event.permission_denials.map(item => item?.tool_name)
            .filter(name => typeof name === 'string' && /^[\w.:-]{1,80}$/.test(name)))].slice(0, 30),
        };
      }
      if (event.type === 'system' && event.subtype === 'session_writes_lost') {
        const warning = {
          reason: 'session_writes_lost',
          errorCode: ['ENOSPC', 'EDQUOT'].includes(event.error_code) ? event.error_code : 'UNKNOWN',
          lost: Array.isArray(event.lost) ? [...new Set(event.lost.filter(kind => ['transcript', 'global_config'].includes(kind)))] : [],
          threadIds: Array.isArray(event.transcript_session_ids)
            ? event.transcript_session_ids.filter(id => typeof id === 'string' && uuid.test(id)).slice(0, 100) : [],
        };
        try { onWarning(warning); } catch { /* Observability cannot change the task result. */ }
      }
    },
  };
}

module.exports = { createClaudeDiagnostics };
