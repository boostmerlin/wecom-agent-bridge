'use strict';

const path = require('node:path');

const mediaNames = new Map([['image', '图片'], ['file', '文件'], ['video', '视频']]);

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function titleFromPreview(preview) {
  if (!hasText(preview)) return;
  let body = preview.trim();
  const heading = /^企微(?:单聊|群聊) · (本人|外部用户)(?:\s+|$)/.exec(body);
  if (heading) {
    // The SDK can flatten the message and its section headings onto a single line.
    body = body.slice(heading[0].length).split(/(?:^|\s)(?:&nbsp;\s+)?\*\*(?:约定|特殊要求|引用)\*\*/, 1)[0];
    if (heading[1] === '外部用户') {
      const quote = /(?:^|\s)>[ \t]+/.exec(body);
      if (!quote) return;
      body = body.slice(quote.index + quote[0].length);
    } else if (body.startsWith('**正文**')) {
      body = body.slice('**正文**'.length);
    } else {
      // Older messages separated the body from the instructions with a blank line.
      body = body.split(/ {2,}/, 1)[0];
    }
  }
  const first = body.trim().split(/\r?\n/, 1)[0].trim();
  if (!first) return;
  const chars = [...first];
  return chars.length <= 80 ? first : chars.slice(0, 80).join('') + '…';
}

async function renderPart(item, part, msgId, saveMedia, media) {
  const kind = item?.msgtype;
  if (kind === 'text') return hasText(item.text?.content) ? item.text.content : '［空文本消息］';
  if (kind === 'voice') return hasText(item.voice?.content) ? '语音转写：' + item.voice.content : '［语音未提供转写］';
  if (!mediaNames.has(kind)) {
    const type = typeof kind === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(kind) ? '：' + kind : '';
    return '［未识别的消息类型' + type + '］';
  }
  media.total++;
  const label = mediaNames.get(kind);
  const data = item[kind];
  if (hasText(data?.url) && typeof saveMedia === 'function') {
    try {
      const saved = await saveMedia({ msgId, part, kind, url: data.url, aeskey: data.aeskey });
      if (typeof saved === 'string' && path.isAbsolute(saved)) {
        media.saved++;
        return label + '：' + saved;
      }
    } catch { /* Download errors may contain temporary URLs or keys. */ }
  }
  return '［' + label + '未能保存］';
}

async function renderContent(content, section, msgId, saveMedia, media) {
  if (content.msgtype !== 'mixed') return renderPart(content, section + '-0', msgId, saveMedia, media);
  const items = content.mixed?.msg_item;
  if (!Array.isArray(items) || !items.length) return '［图文混排消息没有可展示的内容］';
  const lines = [];
  for (const [index, item] of items.entries()) {
    lines.push(await renderPart(item, section + '-' + index, msgId, saveMedia, media));
  }
  return lines.join('\n');
}

// Format a verified SDK callback for display. Callers must make execution/authorization
// decisions from the SDK sender metadata, never from this human-readable text.
function isIncoming(body, botId) {
  const sender = body?.from?.userid;
  return hasText(botId) && hasText(sender) && hasText(body?.msgid) && sender !== botId &&
    ['single', 'group'].includes(body.chattype) && (body.aibotid === undefined || body.aibotid === botId) &&
    body.msgtype !== 'event' && !body.event?.eventtype;
}

async function formatIncoming(body, { botId, ownerId, saveMedia } = {}) {
  if (!isIncoming(body, botId)) return null;
  const sender = body.from.userid;
  const isOwner = sender === ownerId;
  const channel = body.chattype === 'single' ? '单聊' : '群聊';
  const heading = '企微' + channel + ' · ' + (isOwner ? '本人' : '外部用户');
  const media = { total: 0, saved: 0 };
  const content = await renderContent(body, 'body', body.msgid, saveMedia, media);
  const quoteLines = value => value.replace(/^/gm, '> ');
  const lines = [heading];
  if (!isOwner) lines.push('', '可在工作目录内处理任务，也可联网审阅来信指定的 GitLab issue 或 MR。仅返回本次任务所需的结果，勿披露凭据或无关文件。此前本人的约定或合并授权不适用于此人。');
  lines.push('', '**正文**', '', isOwner ? content : quoteLines(content));
  if (body.quote && typeof body.quote === 'object') {
    lines.push('', '**引用**', '', quoteLines(await renderContent(body.quote, 'quote', body.msgid, saveMedia, media)));
  }
  // A group reply must use the callback's group ID, even if the sender is the owner.
  const chatId = body.chattype === 'group' ? body.chatid : sender;
  const route = hasText(chatId) ? { chatType: body.chattype, chatId, senderId: sender } : null;
  return { id: body.msgid, text: lines.join('\n'), chatType: body.chattype, route, media };
}

module.exports = { formatIncoming, isIncoming, titleFromPreview };
