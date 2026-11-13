import { generateReqId } from '@wecom/aibot-node-sdk';

export const STREAM_WINDOW_MS = 570_000;
const PLATFORM_WINDOW_MS = 600_000;
export const THINKING_PLACEHOLDER = '<think></think>';
export const STREAM_TIMEOUT_TEXT = '还在处理，完成后会另发一条结果。';
const EMPTY_CLOSE_TEXT = '（本轮没有文字回复，请在 EnsoCode 查看）';

const defuseThinkTags = (s) => String(s ?? '').replace(/<(\/?)think\b/gi, '<\u200b$1think');

const wrapThinking = (text) => {
  const clean = defuseThinkTags(text).trim();
  return clean ? `<think>${clean}</think>` : THINKING_PLACEHOLDER;
};

const closingBody = (text, format) => {
  const clean = defuseThinkTags(text);
  const formatted = format(clean);
  return /\S/.test(formatted) ? formatted : EMPTY_CLOSE_TEXT;
};

const streamErrorText = (err) => {
  if (!err) return 'unknown error';
  if (typeof err === 'object' && ('errcode' in err || 'errmsg' in err)) {
    return `errcode=${err.errcode ?? '?'} errmsg=${err.errmsg ?? ''}`.trim();
  }
  return err?.message ?? String(err);
};

export function createReplyStreams({
  send,
  format = String,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logInfo = (msg) => console.info(msg),
  logError = (msg) => console.warn(msg),
}) {
  const entries = new Map();
  let disposed = false;
  const serial = (entry, fn) => {
    const result = entry.chain.then(fn);
    entry.chain = result.catch(() => {});
    return result;
  };
  const forget = (entry) => {
    clearTimer(entry.timer);
    if (entries.get(entry.taskId) === entry) entries.delete(entry.taskId);
  };
  const close = async (entry, text) => {
    forget(entry);
    if (disposed || entry.state !== 'open') return;
    entry.state = 'closed';
    if (now() - entry.startedAt >= PLATFORM_WINDOW_MS) return;
    const body = closingBody(text, format);
    try {
      await entry.client.replyStream(entry.frame, entry.streamId, body, true);
      logInfo(`[stream] closed streamId=${entry.streamId} bytes=${Buffer.byteLength(body)}`);
    } catch (err) {
      logError(`[stream] close failed streamId=${entry.streamId}: ${streamErrorText(err)}`);
    }
  };

  return {
    async start(task, frame, client, text = '') {
      if (disposed || !frame?.headers?.req_id || entries.has(task.id)) return;
      const streamId = generateReqId('stream');
      const entry = {
        taskId: task.id, chatKey: task.chatKey, client,
        frame: { headers: { req_id: frame.headers.req_id } },
        streamId, startedAt: now(), state: 'open', chain: Promise.resolve(), timer: null,
      };
      entries.set(task.id, entry);
      entry.timer = setTimer(() => {
        void serial(entry, () => close(entry, STREAM_TIMEOUT_TEXT));
      }, STREAM_WINDOW_MS);
      entry.timer?.unref?.();
      await serial(entry, async () => {
        if (disposed) return;
        const body = wrapThinking(text);
        try {
          await client.replyStream(entry.frame, entry.streamId, body, false);
          logInfo(`[stream] started streamId=${entry.streamId} finish=false bytes=${Buffer.byteLength(body)}`);
        } catch (err) {
          logError(`[stream] start failed streamId=${entry.streamId}: ${streamErrorText(err)}`);
          entry.state = 'fallback';
          forget(entry);
        }
      });
    },

    async deliver(taskIds, chatKey, text, finish = true) {
      if (disposed) throw new Error('回复连接已更换');
      const active = taskIds.map(id => entries.get(id)).filter(entry => entry?.chatKey === chatKey);
      let delivered = false;
      for (const entry of active) {
        const ok = await serial(entry, async () => {
          if (disposed || entry.state !== 'open') return false;
          if (now() - entry.startedAt >= STREAM_WINDOW_MS) {
            await close(entry, STREAM_TIMEOUT_TEXT);
            return false;
          }
          if (finish) {
            entry.state = 'closed';
            forget(entry);
          }
          const body = finish ? closingBody(text, format) : wrapThinking(text);
          try {
            await entry.client.replyStream(entry.frame, entry.streamId, body, finish);
            logInfo(`[stream] delivered streamId=${entry.streamId} finish=${finish} bytes=${Buffer.byteLength(body)}`);
            return true;
          } catch (err) {
            logError(`[stream] deliver failed streamId=${entry.streamId} finish=${finish}: ${streamErrorText(err)}`);
            entry.state = 'fallback';
            forget(entry);
            return false;
          }
        });
        delivered ||= ok;
      }
      if (disposed) throw new Error('回复连接已更换');
      if (!delivered) {
        logInfo(`[stream] fallback push taskIds=${taskIds.length}`);
        await send(chatKey, text);
      }
    },

    async cancelChat(chatKey, text) {
      const active = [...entries.values()].filter(entry => entry.chatKey === chatKey);
      await Promise.all(active.map(entry => serial(entry, () => close(entry, text))));
    },

    dispose() {
      const active = [...entries.values()];
      disposed = true;
      for (const entry of active) clearTimer(entry.timer);
      entries.clear();
      for (const entry of active) {
        if (entry.state !== 'open') continue;
        entry.state = 'closed';
        const body = closingBody('连接已更换，结果会另行发送。', format);
        void entry.client.replyStream(entry.frame, entry.streamId, body, true).catch((err) => {
          logError(`[stream] dispose finish failed streamId=${entry.streamId}: ${streamErrorText(err)}`);
        });
      }
    },
  };
}
