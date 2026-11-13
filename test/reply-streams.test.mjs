import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReplyStreams, STREAM_WINDOW_MS, STREAM_TIMEOUT_TEXT } from '../src/reply-streams.mjs';

import { THINKING_PLACEHOLDER } from '../src/reply-streams.mjs';

function harness() {
  let time = 1000;
  const timers = new Map();
  const replies = [];
  const pushes = [];
  const client = { async replyStream(frame, id, text, finish) { replies.push({ req: frame.headers.req_id, id, text, finish }); } };
  const streams = createReplyStreams({
    now: () => time,
    send: async (chat, text) => pushes.push({ chat, text }),
    setTimer: (fn, delay) => { const key = {}; timers.set(key, { fn, at: time + delay }); return key; },
    clearTimer: key => timers.delete(key),
  });
  return {
    streams, client, replies, pushes, timers,
    start: (id = 'm1', text) => streams.start({ id, chatKey: 'single:u' }, { headers: { req_id: `req-${id}` } }, client, text),
    advance: async (ms, fire = true) => {
      time += ms;
      if (fire) for (const [key, timer] of [...timers]) if (timer.at <= time) { timers.delete(key); timer.fn(); }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('status and final answer replace the placeholder using the same request and stream IDs', async () => {
  const h = harness();
  await h.start();
  await h.streams.deliver(['m1'], 'single:u', '等审批', false);
  await h.advance(STREAM_WINDOW_MS - 1);
  await h.streams.deliver(['m1'], 'single:u', '已完成');
  assert.equal(THINKING_PLACEHOLDER, '<think></think>');
  assert.deepEqual(h.replies.map(r => [r.text, r.finish]), [['<think></think>', false], ['<think>等审批</think>', false], ['已完成', true]]);
  assert.equal(new Set(h.replies.map(r => r.id)).size, 1);
  assert.match(h.replies[0].id, /^stream_[0-9]+_[a-f0-9]+$/);
  assert.equal(new Set(h.replies.map(r => r.req)).size, 1);
  assert.equal(h.pushes.length, 0);
  assert.equal(h.timers.size, 0);
  await h.advance(600_000);
  assert.equal(h.replies.length, 3);
});

test('closing frame defuses literal think tags and uses visible fallback on whitespace-only text', async () => {
  const h = harness();
  await h.start('m1');
  await h.streams.deliver(['m1'], 'single:u', '包含 <think>思考</think> 字面量');
  assert.equal(h.replies[1].finish, true);
  assert.doesNotMatch(h.replies[1].text, /<\/?think>/i);
  assert.match(h.replies[1].text, /<\u200bthink>/);

  await h.start('m2');
  await h.streams.deliver(['m2'], 'single:u', '   \n\t  ');
  assert.equal(h.replies[3].finish, true);
  assert.ok(h.replies[3].text.trim().length > 0);
});

test('stream errors log errcode and errmsg from raw SDK rejection frames before falling back', async () => {
  const logged = [];
  const h = {
    replies: [],
    pushes: [],
  };
  const client = {
    async replyStream(frame, id, text, finish) {
      h.replies.push({ req: frame.headers.req_id, id, text, finish });
      if (finish) throw { headers: { req_id: frame.headers.req_id }, errcode: 846608, errmsg: 'stream message update expired' };
    },
  };
  const streams = createReplyStreams({
    send: async (chat, text) => h.pushes.push({ chat, text }),
    logError: (msg) => logged.push(msg),
  });
  await streams.start({ id: 'm1', chatKey: 'single:u' }, { headers: { req_id: 'req-m1' } }, client, '正在处理');
  await streams.deliver(['m1'], 'single:u', '已完成');
  assert.equal(h.pushes.length, 1);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /846608/);
  assert.match(logged[0], /stream message update expired/);
  streams.dispose();
});

test('timeout closes the placeholder and the late answer is pushed once', async () => {
  const h = harness();
  await h.start();
  await h.advance(STREAM_WINDOW_MS);
  assert.equal(h.replies[1].text, STREAM_TIMEOUT_TEXT);
  assert.equal(h.replies[1].finish, true);
  await h.streams.deliver(['m1'], 'single:u', '迟到的答案');
  assert.deepEqual(h.pushes, [{ chat: 'single:u', text: '迟到的答案' }]);
  assert.equal(h.replies.length, 2);
});

test('sleeping past the platform limit never attempts to update the expired stream', async () => {
  const h = harness();
  await h.start();
  await h.advance(600_001, false);
  await h.streams.deliver(['m1'], 'single:u', '完成');
  assert.equal(h.replies.length, 1);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.timers.size, 0);
});

test('initial or final stream failures fall back to a new result message', async () => {
  for (const failAt of [1, 2]) {
    const h = harness();
    let calls = 0;
    const original = h.client.replyStream;
    h.client.replyStream = (...args) => {
      if (++calls === failAt) return Promise.reject(new Error('network unavailable'));
      return original(...args);
    };
    await h.start();
    await h.streams.deliver(['m1'], 'single:u', '结果');
    assert.equal(h.pushes.length, 1);
    assert.equal(h.timers.size, 0);
  }
});

test('timeout racing a final update cannot leave a second final stream update', async () => {
  const h = harness();
  await h.start();
  let complete;
  h.client.replyStream = async (frame, id, text, finish) => {
    h.replies.push({ req: frame.headers.req_id, id, text, finish });
    await new Promise(resolve => { complete = resolve; });
  };
  const final = h.streams.deliver(['m1'], 'single:u', '结果');
  await new Promise(resolve => setImmediate(resolve));
  await h.advance(STREAM_WINDOW_MS);
  complete();
  await final;
  assert.equal(h.replies.filter(r => r.finish).length, 1);
  assert.equal(h.pushes.length, 0);
});

test('each question owns a separate stream, merged tasks close all streams without duplicate pushes', async () => {
  const h = harness();
  await h.start('m1');
  await h.start('m2');
  assert.notEqual(h.replies[0].id, h.replies[1].id);
  await h.streams.deliver(['m1', 'm2'], 'single:u', '合并结果');
  assert.equal(h.replies.filter(r => r.finish).length, 2);
  assert.equal(h.pushes.length, 0);
  h.streams.dispose();
});

test('rebind closes streams, disposal blocks old deliveries and a fresh runtime uses push fallback', async () => {
  const h = harness();
  await h.start();
  await h.streams.cancelChat('single:u', '绑定已更换');
  assert.equal(h.replies.at(-1).text, '绑定已更换');
  assert.equal(h.timers.size, 0);
  await h.start('m2');
  h.streams.dispose();
  await assert.rejects(h.streams.deliver(['m2'], 'single:u', '旧结果'), /连接已更换/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.timers.size, 0);
  assert.equal(h.replies.at(-1).finish, true, 'dispose sends a finish frame');
  assert.match(h.replies.at(-1).text, /连接已更换/);
  const restarted = harness();
  await restarted.streams.deliver(['m2'], 'single:u', '重启后结果');
  assert.equal(restarted.pushes.length, 1);
  restarted.streams.dispose();
});
