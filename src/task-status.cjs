'use strict';

async function chatTitle(backend, id) {
  if (!id) return '等待新建聊天';
  if (!backend.getThreadTitle) return id;
  let timer;
  try {
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, 800); });
    const title = await Promise.race([backend.getThreadTitle(id), timeout]);
    return title?.trim() ? title.trim() + ' (' + id + ')' : id;
  } catch { return id; }
  finally { clearTimeout(timer); }
}

function taskSummary(state) {
  if (!state) return '未找到投递记录';
  const delivery = { queued: '本地排队', submitting: state.started ? '正在处理' : '正在投递',
    queued_in_codex: '已进入后端队列', rejected: '投递被拒绝', uncertain: '投递结果未知', failed: '处理失败', completed: '已完成' };
  const reply = { registered: '尚无答复', waiting: '等待最终答复', ready: '等待回发', sending: '回发中',
    sent: '已回发', failed: '失败', uncertain: '回发结果未知' };
  return '投递：' + delivery[state.delivery] + (state.failureReason ? '；失败通知：' : '；回复：') + reply[state.reply];
}

async function describeStatus(backend, { target, sources, error, last }) {
  const titles = new Map();
  function lookup(id) {
    if (!titles.has(id)) titles.set(id, chatTitle(backend, id));
    return titles.get(id);
  }
  const [next, previous] = await Promise.all([error ? null : lookup(target.threadId), last && lookup(last.threadId)]);
  const destination = error || next + '（' + sources.thread + '）\n工作目录：' + target.workingDir + '（' + sources.directory + '）';
  const lines = ['下一条消息 → ' + destination];
  if (last) {
    lines.push('上一条任务 → ' + previous, '工作目录：' + last.workingDir, taskSummary(last.state),
      last.media.total ? '附件：已保存 ' + last.media.saved + '/' + last.media.total : '附件：无');
  } else lines.push('本会话尚无任务。');
  return lines.join('\n');
}

module.exports = { chatTitle, describeStatus };
