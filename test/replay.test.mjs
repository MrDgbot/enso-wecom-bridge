import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bind, buildPrompt, emptyState, markInjected, receive, settle } from '../src/core.mjs';
import { boardAdd, boardAppend, boardList } from '../src/board.mjs';
import { createDispatcher } from '../src/dispatch.mjs';

const allow = (state) => { state.access = { mode: 'allowlist', allow: ['user-a', 'user-b'], block: [] }; };
const group = (id, user, text) => ({ msgid: id, chattype: 'group', chatid: 'room', from: { userid: user }, msgtype: 'text', text: { content: text } });

test('two messages in one run share one numbered reply instead of repeating the last answer', () => {
  const state = emptyState();
  allow(state);
  bind(state, 'group:room', { sessionId: 'S', title: '项目', projectRoot: '/work', boundAt: 1 });
  receive(state, group('m1', 'user-a', '同一批的多个报表能否合并到一个页面'), { now: 1 });
  receive(state, group('m2', 'user-b', '合并时每份都能选主题'), { now: 2 });
  markInjected(state, 'm1', 3, undefined, { batchId: 'run' });
  markInjected(state, 'm2', 3, undefined, { batchId: 'run' });
  const prompt = buildPrompt(state, {
    messages: [
      { chatKey: 'group:room', userid: 'user-a', taskId: 'm1', content: { text: '同一批的多个报表能否合并到一个页面', quote: '', images: [] } },
      { chatKey: 'group:room', userid: 'user-b', taskId: 'm2', content: { text: '合并时每份都能选主题', quote: '', images: [] } },
    ],
  });
  assert.match(prompt, /1\. /);
  assert.match(prompt, /2\. /);
  assert.match(prompt, /按编号/);
  assert.match(prompt, /不要只回答最后一条/);
  const replies = settle(state, 'S', '1. 可以合成。\n2. 每份都能选主题。', 4, { batchId: 'run' });
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].taskIds, ['m1', 'm2']);
  assert.equal(state.tasks[0].reply, state.tasks[1].reply);
});

test('an empty aborted run does not publish the placeholder or close the tasks', () => {
  const state = emptyState();
  allow(state);
  bind(state, 'group:room', { sessionId: 'S', title: '项目', projectRoot: '/work', boundAt: 1 });
  receive(state, group('m1', 'user-a', '小数点是否必须精确到两位'), { now: 1 });
  markInjected(state, 'm1', 2, undefined, { batchId: 'run' });
  const dispatcher = createDispatcher();
  dispatcher.begin('S', 'run');
  const sent = [];
  const first = dispatcher.endRun('S', '');
  assert.equal(first.action, 'retry-empty');
  assert.deepEqual(settle(state, 'S', '', 3, { aborted: true }), []);
  assert.equal(state.tasks[0].status, 'queued');
  const second = dispatcher.endRun('S', '   ');
  assert.equal(second.action, 'give-up');
  if (second.action !== 'give-up') sent.push('placeholder');
  assert.deepEqual(sent, []);
  assert.equal(state.tasks[0].status, 'queued');
  dispatcher.stop();
});

test('开始做 after several confirmed items lists every todo, not only the latest', () => {
  const state = emptyState();
  allow(state);
  bind(state, 'group:room', { sessionId: 'S', title: '项目', projectRoot: '/work', boundAt: 1 });
  for (const title of ['合并页面', '每份可选主题', '转交后权限不变']) {
    boardAdd(state, { chatKey: 'group:room', title, status: '待做', source: 'wecom', requesterId: 'user-a' });
  }
  const prompt = buildPrompt(state, { chatKey: 'group:room', userid: 'user-a', content: { text: '开始做', quote: '', images: [] } });
  for (const title of ['合并页面', '每份可选主题', '转交后权限不变']) assert.match(prompt, new RegExp(title));
  const append = boardAppend(state, { chatKeys: ['group:room'], startWork: true });
  for (const title of ['合并页面', '每份可选主题', '转交后权限不变']) assert.match(append, new RegExp(title));
  assert.equal(boardList(state, { chatKey: 'group:room', status: '待做' }).length, 3);
});
