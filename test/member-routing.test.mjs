import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyState, bind, bindMember, bindingFor, receive, normalizeState, markInjected, settle, snapshotData, unbind, buildPrompt } from '../src/core.mjs';
import { requireBrowserGrant, grantBrowserDocuments } from '../src/browser-document.mjs';

const message = (id, user, group = 'g') => ({ msgid: id, chattype: group ? 'group' : 'single', chatid: group, from: { userid: user }, msgtype: 'text', text: { content: '检查现有代码' } });
const binding = id => ({ sessionId: id, title: id, projectRoot: '/' + id });

test('group override is scoped by group and sender, persists and falls back without changing old task projects', () => {
  let s = emptyState();
  bind(s, 'single:li', binding('A'));
  bind(s, 'group:g', binding('B'));
  bind(s, 'group:g2', binding('D'));
  receive(s, message('seen', 'li'), { now: 1 });
  bindMember(s, 'group:g', 'li', binding('C'));
  s = normalizeState(JSON.parse(JSON.stringify(s)));
  for (const [id, user, group, expected] of [['li', 'li', 'g', 'C'], ['zhang', 'zhang', 'g', 'B'], ['dm', 'li', null, 'A'], ['other', 'li', 'g2', 'D']]) {
    const r = receive(s, message(id, user, group), { now: 2 });
    assert.equal(r.binding.sessionId, expected);
    markInjected(s, id, 3);
  }
  assert.deepEqual(settle(s, 'C', 'C 的结果', 4), [{ chatKey: 'group:g', taskIds: ['li'] }]);
  assert.equal(s.tasks.find(t => t.id === 'zhang').status, 'queued');
  bind(s, 'group:g', binding('E'));
  assert.equal(bindingFor(s, 'group:g', 'li').sessionId, 'C');
  bindMember(s, 'group:g', 'li', null);
  assert.equal(receive(s, message('next', 'li'), { now: 5 }).binding.sessionId, 'E');
  assert.equal(s.tasks.find(t => t.id === 'li').projectRoot, '/C');
  assert.equal(bindingFor(s, 'single:li', 'li').sessionId, 'A');
  assert.throws(() => bindMember(s, 'group:g', 'stranger', binding('C')), /发过消息/);
  unbind(s, 'group:g');
  assert.equal(bindingFor(s, 'group:g', 'li'), null);
});

test('rebind cancels only that member pending replies and access denial still wins', () => {
  const s = emptyState();
  bind(s, 'group:g', binding('B'));
  for (const user of ['li', 'zhang']) {
    receive(s, message(user, user), { now: 1 });
    markInjected(s, user, 2);
  }
  bindMember(s, 'group:g', 'li', binding('C'));
  assert.equal(s.tasks.find(t => t.id === 'li').status, 'failed');
  assert.deepEqual(settle(s, 'B', 'B 的结果', 3)[0].taskIds, ['zhang']);
  s.access.block.push('li');
  assert.equal(receive(s, message('blocked', 'li'), { now: 4 }).decision, 'denied');
  assert.ok(snapshotData(s, {}).projects.includes('/C'));
});

test('member session follows group document restrictions and prompt limits presentation only', () => {
  const s = emptyState();
  bind(s, 'group:g', binding('B'));
  const msg = message('seen', 'li');
  receive(s, msg, { now: 1 });
  bindMember(s, 'group:g', 'li', binding('C'));
  const url = 'https://doc.weixin.qq.com/sheet/demo';
  assert.equal(requireBrowserGrant(s, 'C', 'bot', url).chatKey, 'group:g');
  grantBrowserDocuments(s, 'group:g', 'B', 'bot', '', 'listed');
  assert.throws(() => requireBrowserGrant(s, 'C', 'bot', url), /未授权/);
  const prompt = buildPrompt(s, { chatKey: 'group:g', userid: 'li', content: { text: '核对后告诉我', images: [] } });
  assert.match(prompt, /不限制查代码、调用工具、执行任务或验证/);
  assert.match(prompt, /明确区分目前已有/);
  assert.match(prompt, /本轮使用自动回传/);
});
