'use strict';

const { randomBytes } = require('node:crypto');

const approvalTimeoutMs = 5 * 60 * 1000;
const denied = message => ({ behavior: 'deny', message });
const sameChat = (a, b) => a.chatType === b.chatType && a.chatId === b.chatId;

function describeInput(input) {
  let text = JSON.stringify(input, (key, value) => /secret|token|password|api.?key|authorization/i.test(key) ? '[已隐藏]' : value, 2);
  for (const [key, value] of Object.entries(process.env)) {
    if (/secret|token|password|api.?key|authorization/i.test(key) && value.length >= 4) text = text.split(value).join('[已隐藏]');
  }
  return text.replace(/\bBearer\s+[^\s"\\]+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|glpat-)[\w-]+/g, '[已隐藏]');
}

function createApprovals({ ownerId, sendReply, log = () => {}, timeoutMs = approvalTimeoutMs }) {
  const pending = new Map();
  let closed = false;
  function emit(event, item, extra = {}) {
    try { log(event, { approvalId: item.id, backend: item.backend, workingDir: item.workingDir,
      threadId: item.threadId, requestId: item.requestId, senderId: item.route.senderId, ...extra }); } catch {}
  }
  function request(details) {
    const { route, signal } = details;
    if (closed || signal?.aborted || !ownerId || route?.senderId !== ownerId) return Promise.resolve(denied('审批不可用。'));
    // Keep metadata and tool content in one literal code block. JSON escapes prevent
    // a backtick in a command/diff from closing the fence; no active links or HTML.
    const input = describeInput({ 工具: details.toolName, 目录: details.workingDir,
      聊天: details.threadId || '新聊天', 参数: details.input }).replace(/`/g, '\\u0060');
    if (!input || Buffer.byteLength(input) > 64000) return Promise.resolve(denied('操作参数过长，无法完整展示审批内容，本次未执行。'));
    return new Promise(resolve => {
      const id = randomBytes(6).toString('hex');
      const item = { ...details, route: { ...route }, id, ready: false };
      function settle(decision, reason) {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        emit('approval_resolved', item, { decision: decision.behavior, reason });
        resolve(decision);
      }
      const abort = () => settle(denied('任务已结束或取消，审批失效。'), 'cancelled');
      const timer = setTimeout(() => settle(denied('等待审批超时，本次操作未执行。'), 'timeout'), timeoutMs);
      item.settle = settle;
      pending.set(id, item);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      emit('approval_requested', item);
      // Show the complete input before enabling approval; never approve a truncated command.
      const header = (details.backend === 'codex' ? 'Codex' : 'Claude') + ' 审批 ' + id + '\n';
      const footer = '\n回复「允许 ' + id + '」或「拒绝 ' + id + '」，仅按本次请求范围授权，不保存长期规则。' +
        Math.ceil(timeoutMs / 60000) + ' 分钟内未回复则拒绝。';
      const chunks = [];
      let chunk = '', size = 0;
      for (const char of input) {
        const bytes = Buffer.byteLength(char);
        if (size + bytes > 3500) { chunks.push(chunk); chunk = ''; size = 0; }
        chunk += char; size += bytes;
      }
      if (chunk) chunks.push(chunk);
      void (async () => {
        for (const [index, part] of chunks.entries()) {
          if (!pending.has(id)) return;
          const text = header + (chunks.length > 1 ? '详情 ' + (index + 1) + '/' + chunks.length + '\n' : '') +
            '```json\n' + part + '\n```\n' + footer;
          if (Buffer.byteLength(text) > 6144) throw new Error('Approval details too long');
          await sendReply(route, text);
        }
        if (pending.has(id)) item.ready = true;
      })().catch(() => settle(denied('审批请求发送失败，本次操作未执行。'), 'send_failed'));
    });
  }
  function respond(route, action, id) {
    if (!ownerId || route?.senderId !== ownerId) return '审批仅限机器人绑定的本人。';
    const matches = [...pending.values()].filter(item => sameChat(item.route, route));
    if (!id && matches.length > 1) return '有多条待审批操作，请回复允许或拒绝，并附上审批编号。';
    const item = id ? pending.get(id.toLowerCase()) : matches[0];
    if (!item || !sameChat(item.route, route)) return '当前会话没有这条待审批操作，编号可能已失效。';
    if (!['approve', 'deny'].includes(action)) return '请回复允许或拒绝，并附上审批编号。';
    if (!item.ready) return '审批详情尚未发送完成，请稍后再回复。';
    const allow = action === 'approve';
    item.settle(allow ? { behavior: 'allow' } : denied('用户拒绝了本次操作，请勿重复尝试。'), 'user');
    return (allow ? '已允许本次操作：' : '已拒绝本次操作：') + item.id;
  }
  function close() {
    closed = true;
    for (const item of pending.values()) item.settle(denied('桥接已停止，审批失效。'), 'bridge_stopped');
  }
  return { request, respond, close };
}

module.exports = { createApprovals, approvalTimeoutMs };
