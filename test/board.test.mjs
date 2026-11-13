import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bind, buildPrompt, emptyState, freshState, normalizeState, unbind } from '../src/core.mjs';
import { BOARD_APPEND_MAX_BYTES, boardAdd, boardAppend, boardUpdate, refreshMisses, syncDelivery } from '../src/board.mjs';

test('board dedups open items, keeps them across rebind, and accepts old state without a board', () => {
  const state = emptyState();
  bind(state, 'group:g', { sessionId: 'S1', title: '甲', projectRoot: '/a', boundAt: 1 });
  const first = boardAdd(state, { chatKey: 'group:g', title: '合并报表', status: '待决定', detail: '先调研', requesterId: 'u1', requesterName: '用户甲', source: 'wecom', taskIds: ['t1'], options: ['合并', '不合并'] }, 10);
  const again = boardAdd(state, { chatKey: 'group:g', title: '合并报表', status: '待做', detail: '按份可选主题', taskIds: ['t2'] }, 20);
  assert.equal(again.created, false);
  assert.equal(again.item.id, first.item.id);
  assert.equal(again.item.status, 'todo');
  assert.deepEqual(again.item.taskIds, ['t1', 't2']);
  unbind(state, 'group:g');
  bind(state, 'group:g', { sessionId: 'S2', title: '乙', projectRoot: '/b', boundAt: 30 });
  assert.equal(state.board.items[0].chatKey, 'group:g');
  assert.equal(state.board.items[0].title, '合并报表');
  const legacy = normalizeState({ tasks: [{ id: 'old', status: 'replied', text: '历史' }], bindings: {} });
  assert.equal(legacy.board.items.length, 0);
  assert.ok(legacy.board.ownerToken);
  const saved = normalizeState(JSON.parse(JSON.stringify(state)));
  assert.equal(saved.board.ownerToken, state.board.ownerToken);
  assert.equal(saved.board.items[0].status, 'todo');
});

test('status transitions record the decision and empty delivery reopens a finished item', () => {
  const state = emptyState();
  const { item } = boardAdd(state, { chatKey: 'single:u', title: '主题是否可选', status: '待决定', waitingOn: '用户甲', taskIds: ['t9'] }, 1);
  assert.throws(() => boardUpdate(state, { id: 'missing', status: '完成' }), /没有这条/);
  const decided = boardUpdate(state, { id: item.id, status: '待做', decision: '每套可选', decidedBy: '用户甲' }, 2);
  assert.equal(decided.status, 'todo');
  assert.equal(decided.decision, '每套可选');
  boardUpdate(state, { id: item.id, status: '进行中' }, 3);
  boardUpdate(state, { id: item.id, status: '完成' }, 4);
  assert.equal(state.board.items[0].status, 'done');
  syncDelivery(state, ['t9'], 'empty', 5);
  assert.equal(state.board.items[0].status, 'doing');
  assert.equal(state.board.items[0].delivery, 'empty');
  syncDelivery(state, ['t9'], 'undelivered', 6);
  assert.equal(state.board.items[0].delivery, 'undelivered');
});

test('new installs are allowlist with closed documents; old installs stay open', () => {
  const fresh = freshState();
  assert.equal(fresh.access.mode, 'allowlist');
  assert.deepEqual(fresh.access.allow, []);
  bind(fresh, 'single:u', { sessionId: 'S' });
  assert.deepEqual(fresh.bindings['single:u'].browserDocuments, { scope: 'listed', paths: [] });
  const old = normalizeState({ access: { mode: 'blocklist', allow: [], block: [] }, bindings: { 'single:u': { sessionId: 'S' } } });
  assert.equal(old.access.mode, 'blocklist');
  assert.equal(old.policy.documents, 'legacy');
  assert.equal(old.bindings['single:u'].browserDocuments, undefined);
});

test('append stays under the host cap and lists every todo when work starts', () => {
  const state = emptyState();
  for (let i = 0; i < 400; i++) boardAdd(state, { chatKey: 'group:g', title: `需求${i}需要处理一件很长的事情`, status: i % 2 ? '待做' : '待决定' }, i);
  const append = boardAppend(state, { chatKeys: ['group:g'], startWork: true });
  assert.ok(Buffer.byteLength(append) <= BOARD_APPEND_MAX_BYTES);
  assert.ok(Buffer.byteLength(append) < 16 * 1024);
  assert.match(append, /开始做/);
  const prompt = buildPrompt(state, { chatKey: 'group:g', userid: 'u', content: { text: '都要做', quote: '', images: [] } });
  assert.match(prompt, /需求0需要处理/);
  assert.match(prompt, /需求399需要处理|看板摘要已截断|待处理/);
  assert.match(prompt, /不要只做最后|跳过/);
  assert.match(prompt, /board_add/);
});

test('missed registration compares recent requests with the board and does not invent a group post', () => {
  const state = emptyState();
  state.tasks.push(
    { id: 't1', chatKey: 'group:g', userid: 'u', text: '能不能把报表合并成一个页面', status: 'replied', createdAt: 10 },
    { id: 't2', chatKey: 'group:g', userid: 'u', text: '好的', status: 'replied', createdAt: 11 },
  );
  boardAdd(state, { chatKey: 'group:g', title: '能不能把报表合并成一个页面', status: '待做', taskIds: ['t1'] }, 12);
  state.tasks.push({ id: 't3', chatKey: 'group:g', userid: 'u2', text: '小数点是否必须精确到两位', status: 'replied', createdAt: 13 });
  const misses = refreshMisses(state, 20);
  assert.deepEqual(misses.map((item) => item.taskId), ['t3']);
});
