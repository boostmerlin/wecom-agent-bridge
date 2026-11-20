'use strict';

const { titleFromPreview } = require('./incoming.cjs');

async function chatTitle(backend, id, { compact = false, allowPreview = true } = {}) {
  if (!id) return '等待新建聊天';
  let timer, title;
  try {
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, 800); });
    const lookup = backend.getThreadTitle?.(id, { allowPreview, fromPreview: compact && allowPreview ? titleFromPreview : undefined });
    title = (await Promise.race([lookup, timeout]))?.trim();
  } catch { /* A missing title must not prevent a status reply. */ }
  finally { clearTimeout(timer); }
  if (compact) {
    const suffix = id.length > 12 ? '…' + id.slice(-12) : id;
    return (title?.replace(/\s+/g, ' ') || '暂无标题') + ' · ' + suffix;
  }
  return title ? title + ' (' + id + ')' : id;
}

function taskSummary(state) {
  if (!state) return '未找到投递记录';
  const stopped = { turn_interrupted: '已中断', task_cancelled: '已取消', desktop_queue_cancelled: '投递前已取消',
    task_timeout: '执行超时', bridge_stopped: '桥接停止，任务已中断' };
  const delivery = { queued: '本地排队', submitting: state.started ? '正在处理' : '正在投递',
    queued_in_codex: state.started ? '后端已开始处理' : '已进入后端队列，尚未确认开始',
    rejected: '投递被拒绝', uncertain: '投递结果未知', failed: '处理失败', completed: '已完成' };
  const reply = { registered: '尚无答复', waiting: '等待最终答复', ready: '等待回发', sending: '回发中',
    sent: '已回发', failed: '失败', uncertain: '回发结果未知' };
  return '投递：' + (stopped[state.failureReason] || delivery[state.delivery]) + (state.failureReason ? '；失败通知：' : '；回复：') + reply[state.reply];
}

function chatTitles(backend, options) {
  const titles = new Map();
  return id => {
    if (!titles.has(id)) titles.set(id, chatTitle(backend, id, { ...options, compact: true }));
    return titles.get(id);
  };
}

async function describeStatus(backend, { target, sources, error, last }, options) {
  const lookup = chatTitles(backend, options);
  const [next, previous] = await Promise.all([error ? null : lookup(target.threadId), last && lookup(last.threadId)]);
  const destination = error || next + '（' + sources.thread + '）\n工作目录：' + target.workingDir + '（' + sources.directory + '）';
  const lines = ['下一条消息 → ' + destination];
  if (backend.id !== 'codex' && backend.name) lines.unshift('后端：' + backend.name);
  if (last) {
    lines.push('上一条任务 → ' + previous, '工作目录：' + last.workingDir, taskSummary(last.state),
      last.media.total ? '附件：已保存 ' + last.media.saved + '/' + last.media.total : '附件：无');
  } else lines.push('本会话尚无任务。');
  return lines.join('\n');
}

async function describeTasks(backend, tasks, options) {
  if (!tasks.length) return '当前后端在本会话尚无任务。';
  const lookup = chatTitles(backend, options);
  const rows = await Promise.all(tasks.map(async task => '#' + task.number + ' · ' +
    await lookup(task.threadId) + ' · ' + task.workingDir + '\n' + taskSummary(task.state)));
  return backend.name + ' · 本会话最近任务（最多 10 条）\n\n' + rows.join('\n\n');
}

module.exports = { chatTitle, describeStatus, describeTasks };
