import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyState } from '../src/core.mjs';
import { boardAdd, boardAppend, boardUpdate } from '../src/board.mjs';

test('several requirements from one WeCom message stay separate items', () => {
  const state = emptyState();
  boardAdd(state, { chatKey: 'group:g', title: '合并页面', status: '待做', detail: '甲', taskIds: ['t1'], options: ['一套', '多套'] });
  const second = boardAdd(state, { chatKey: 'group:g', title: '每份可选主题', status: '待做', detail: '乙', taskIds: ['t1'] });
  assert.equal(second.created, true);
  assert.deepEqual(state.board.items.map((item) => [item.title, item.detail]), [['合并页面', '甲'], ['每份可选主题', '乙']]);
  assert.deepEqual(state.board.items[0].options.map((option) => option.label), ['一套', '多套']);
});

test('the same title with the same task id finds its item again, even after it was finished', () => {
  const state = emptyState();
  const first = boardAdd(state, { chatKey: 'group:g', title: '合并页面', status: '待做', taskIds: ['t1'] });
  boardUpdate(state, { id: first.item.id, status: '完成' });
  const again = boardAdd(state, { chatKey: 'group:g', title: '合并页面', status: '待做', taskIds: ['t1'] });
  assert.equal(again.created, false);
  assert.equal(again.item.id, first.item.id);
  assert.equal(again.item.status, 'todo');
  const otherChat = boardAdd(state, { chatKey: 'group:h', title: '合并页面', status: '待做', taskIds: ['t1'] });
  assert.equal(otherChat.created, true);
});

test('a rejected status change leaves the other fields untouched', () => {
  const state = emptyState();
  const { item } = boardAdd(state, { chatKey: 'group:g', title: '已放弃的事', status: '放弃', detail: '原文' });
  assert.throws(() => boardUpdate(state, { id: item.id, status: '完成', detail: '被改了', decision: '被改了' }), /不能从/);
  assert.equal(item.detail, '原文');
  assert.equal(item.decision, '');
});

test('开始做 only lists the session’s own chats and never says there is nothing to do when the board is empty', () => {
  const state = emptyState();
  boardAdd(state, { chatKey: 'group:mine', title: '我这个群的需求', status: '待做' });
  boardAdd(state, { chatKey: 'group:secret', title: '别的群的需求', status: '待做' });
  const mine = boardAppend(state, { chatKeys: ['group:mine'], startWork: true });
  assert.match(mine, /我这个群的需求/);
  assert.doesNotMatch(mine, /别的群的需求/);
  const empty = boardAppend(state, { chatKeys: ['group:none'], startWork: true });
  assert.match(empty, /不代表没有事做/);
});
