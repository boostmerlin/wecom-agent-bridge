'use strict';

const commandMethod = 'item/commandExecution/requestApproval';
const fileMethod = 'item/fileChange/requestApproval';
const permissionsMethod = 'item/permissions/requestApproval';
const methods = new Set([commandMethod, fileMethod, permissionsMethod]);

// Translate only explicit, one-time human decisions; never install an allow rule.
function createCodexApprovals({ threadId, turnId, workingDir, onApproval, respond }) {
  const seen = new Set(), pending = new Map(), patches = new Map();
  let closed = false;
  const matches = p => p?.threadId === threadId && p?.turnId === turnId;
  function invalidate(id) {
    const item = pending.get(id);
    pending.delete(id);
    item?.controller.abort();
  }
  function observe({ method, params: p }) {
    if (method === 'serverRequest/resolved' && p?.threadId === threadId) invalidate(p.requestId);
    if (!matches(p)) return;
    if (method === 'item/started' && p.item?.type === 'fileChange') patches.set(p.item.id, p.item.changes);
    if (method === 'item/completed') {
      patches.delete(p.item?.id);
      for (const [id, item] of pending) if (item.itemId === p.item?.id) invalidate(id);
    }
  }
  function request({ id, method, params: p }) {
    if (!methods.has(method)) return false;
    if (closed || seen.has(id)) return true;
    seen.add(id);
    const permission = method === permissionsMethod;
    const deny = permission ? { permissions: {}, scope: 'turn' } : { decision: 'decline' };
    let input, toolName;
    if (matches(p) && typeof p.itemId === 'string') {
      if (method === commandMethod && typeof p.command === 'string' && p.command.trim() &&
          (!p.availableDecisions || p.availableDecisions.includes('accept'))) {
        toolName = '执行命令';
        input = { ...p, scope: '仅执行本次命令，不添加放行规则' };
      } else if (method === fileMethod) {
        const changes = patches.get(p.itemId);
        if (Array.isArray(changes) && changes.length && changes.every(c => typeof c.path === 'string' && typeof c.diff === 'string')) {
          toolName = '修改文件';
          input = { ...p, changes, scope: '仅应用本次文件修改' };
        }
      } else if (permission && p.permissions && typeof p.permissions === 'object' && !Array.isArray(p.permissions) &&
          Object.keys(p.permissions).length && Object.keys(p.permissions).every(k => ['fileSystem', 'network'].includes(k))) {
        toolName = '临时权限';
        input = { ...p, scope: '仅本轮任务，可能用于本轮后续操作，不保存到会话或全局配置' };
      }
    }
    if (!input || !onApproval) { respond(id, deny); return true; }
    const controller = new AbortController();
    pending.set(id, { controller, itemId: p.itemId });
    void (async () => {
      let decision;
      try { decision = await onApproval({ toolName, input, workingDir, threadId, signal: controller.signal }); } catch {}
      if (!pending.delete(id) || closed) return;
      const allow = decision?.behavior === 'allow';
      respond(id, allow ? permission ? { permissions: p.permissions, scope: 'turn' } : { decision: 'accept' } : deny);
    })();
    return true;
  }
  function close() {
    closed = true;
    for (const id of pending.keys()) invalidate(id);
    patches.clear();
  }
  return { request, observe, close };
}

module.exports = { createCodexApprovals };
