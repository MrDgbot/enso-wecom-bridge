import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardAdd, boardAppend, boardUpdate, normalizeBoard, normalizeLayout } from '../src/board.mjs';
import { buildPrompt, emptyState, normalizeState } from '../src/core.mjs';
import { bindingHealth, gateFor, isReviewer, markBoardTool, needsReview, setGate, setOwnerUserid } from '../src/gate.mjs';
import { applyReview, gateLines, parseReviewCommand, requestersFor, reviewByMessage, reviewItem, reviewSuffix } from '../src/review.mjs';
import './no-tunnel.mjs';

const GROUP = 'group:g1';
const OWNER = 'u-owner';

function world() {
  const state = emptyState();
  state.board.ownerUserid = OWNER;
  state.autoNames = { botId: '', users: { [OWNER]: 'Alice', 'u-bob': 'Bob', 'u-amy': 'Amy' }, groups: { g1: '需求对齐群' }, updatedAt: 1 };
  state.bindings[GROUP] = { sessionId: 'S', title: '项目会话', projectRoot: '/w', boundAt: 100 };
  state.chats[GROUP] = { userids: [OWNER, 'u-bob', 'u-amy'], kind: 'group', target: 'g1', lastUserid: 'u-bob', lastText: '', lastAt: 1 };
  return state;
}
const add = (state, title, requester, gated, extra = {}) => boardAdd(state, { chatKey: GROUP, title, status: '待做', requesterId: requester, source: 'wecom', ...extra }, 1000, { gated });

test('gate defaults: on for groups, owner is the only reviewer; off for single chats', () => {
  const state = world();
  assert.deepEqual(gateFor(state, GROUP), { on: true, reviewers: [OWNER], explicit: [], configured: false });
  assert.equal(needsReview(state, GROUP, ['u-bob']), true);
  assert.equal(needsReview(state, GROUP, [OWNER]), false);
  assert.equal(needsReview(state, GROUP, []), true, 'an unknown requester is treated as a non-reviewer');
  assert.equal(needsReview(state, 'single:u-bob', ['u-bob']), false);
  setGate(state, GROUP, { reviewers: ['u-amy'] });
  assert.equal(isReviewer(state, GROUP, 'u-amy'), true);
  assert.equal(isReviewer(state, GROUP, OWNER), true, 'the owner stays a reviewer');
  assert.equal(isReviewer(state, GROUP, 'u-bob'), false);
  setGate(state, GROUP, { on: false });
  assert.equal(needsReview(state, GROUP, ['u-bob']), false, 'gate off: everything goes straight to the board');
  assert.deepEqual(gateFor(state, GROUP).explicit, ['u-amy'], 'turning it off keeps the reviewer list');
  assert.throws(() => setGate(state, GROUP, { reviewers: ['stranger'] }), /已知成员/);
  assert.throws(() => setGate(state, 'single:x', { on: true }), /群聊/);
});

test('gate ON: a non-reviewer requirement lands as 待审核 and cannot be moved by the model', () => {
  const state = world();
  const { item } = add(state, '导出按钮改成蓝色', 'u-bob', needsReview(state, GROUP, ['u-bob']));
  assert.equal(item.status, 'pending_review');
  assert.equal(item.no, 1);
  assert.equal(item.gated, true);
  // 模型再登记、再更新都不能把它推进到待做/进行中
  const again = boardAdd(state, { chatKey: GROUP, title: '导出按钮改成蓝色', status: '进行中', source: 'wecom' }, 2000, { gated: true });
  assert.equal(again.created, false);
  assert.equal(again.item.status, 'pending_review');
  assert.throws(() => boardUpdate(state, { id: item.id, status: '进行中' }), /待审核/);
  assert.throws(() => boardUpdate(state, { id: item.id, status: '待做' }, 1, { actor: 'page' }), /待审核/, 'even the generic page route cannot skip the review');
  assert.throws(() => boardAdd(state, { chatKey: GROUP, title: '自封待审核', status: '待审核' }), /自动设置/);
  boardUpdate(state, { id: item.id, detail: '补充：蓝色 #1677ff' });
  assert.equal(item.detail, '补充：蓝色 #1677ff');
  assert.equal(item.status, 'pending_review', 'clarifying is allowed');
});

test('gate OFF and reviewer-raised items skip the gate', () => {
  const state = world();
  const mine = add(state, '老板提的需求', OWNER, needsReview(state, GROUP, [OWNER])).item;
  assert.equal(mine.status, 'todo');
  setGate(state, GROUP, { on: false });
  const open = add(state, '关了门槛的需求', 'u-bob', needsReview(state, GROUP, ['u-bob'])).item;
  assert.equal(open.status, 'todo');
  assert.equal(open.gated, false);
  assert.deepEqual([mine.no, open.no], [1, 2]);
});

test('approve moves the item to 待做, records the reviewer server-side, and queues a task for the requester session', () => {
  const state = world();
  const item = add(state, '导出按钮改成蓝色', 'u-bob', true).item;
  const done = applyReview(state, item.id, 'approve', { name: '所有者', via: 'page' }, 5000);
  assert.equal(item.status, 'todo');
  assert.equal(item.review, 'approved');
  assert.equal(item.decidedBy, '所有者');
  assert.equal(item.reviewVia, 'page');
  assert.equal(item.decidedAt, 5000);
  assert.match(done.text, /已通过 #1/);
  assert.equal(done.task.status, 'pending');
  assert.equal(done.task.synthetic, true);
  assert.equal(done.task.sessionId, 'S');
  assert.equal(done.task.userid, 'u-bob');
  assert.match(done.task.text, /审核通过/);
  assert.throws(() => reviewItem(state, item.id, 'approve', { name: 'x' }), /不在待审核/, 'a second approval is refused, not applied twice');
});

test('reject closes the item with the reason and does not wake the session', () => {
  const state = world();
  const item = add(state, '把所有页面推倒重来', 'u-bob', true, { taskIds: ['m0'] }).item;
  const done = applyReview(state, item.id, 'reject', { name: '小王', via: 'share' }, 6000, '范围太大，本期不做');
  assert.equal(item.status, 'dropped');
  assert.equal(item.review, 'rejected');
  assert.equal(item.decision, '范围太大，本期不做');
  assert.equal(item.decidedBy, '小王');
  assert.equal(done.task, null);
  assert.equal(state.tasks.length, 0);
  // 驳回后，模型对同一条消息再登记也复活不了；提出人新发一条消息，会作为新条目重新排队审核
  const retry = boardAdd(state, { chatKey: GROUP, title: '把所有页面推倒重来', status: '待做', taskIds: ['m0'] }, 7000, { gated: false });
  assert.equal(retry.item.id, item.id);
  assert.equal(retry.item.status, 'dropped');
  assert.throws(() => boardUpdate(state, { id: item.id, status: '待做' }), /驳回/);
  const reraised = boardAdd(state, { chatKey: GROUP, title: '把所有页面推倒重来', status: '待做', taskIds: ['m9'] }, 8000, { gated: true });
  assert.notEqual(reraised.item.id, item.id);
  assert.equal(reraised.item.status, 'pending_review');
  assert.equal(reraised.item.no, 2);
  assert.equal(item.status, 'dropped');
  // 同一条消息里带了新旧两个任务编号时，驳回过的条目重新排队审核，旧结论清掉
  const merged = boardAdd(state, { chatKey: GROUP, title: '把所有页面推倒重来', status: '待做', taskIds: ['m0', 'm10'] }, 9000, { gated: true });
  assert.equal(merged.item.id, item.id);
  assert.equal(merged.item.status, 'pending_review');
  assert.equal(merged.item.decision, '');
});

test('group commands: a reviewer approves or rejects by number, by id, or by quoting the registered item', () => {
  const state = world();
  setGate(state, GROUP, { reviewers: ['u-amy'] });
  const a = add(state, '导出按钮改成蓝色', 'u-bob', true).item;
  const b = add(state, '增加批量导入', 'u-bob', true).item;
  const c = add(state, '登录页加验证码', 'u-bob', true).item;
  const ctx = (userid, text, quote = '') => ({ chatKey: GROUP, userid, content: { text, quote, images: [] } });

  const byNo = reviewByMessage(state, ctx('u-amy', '同意 1'), 9000);
  assert.equal(byNo.kind, 'approve');
  assert.equal(a.status, 'todo');
  assert.equal(a.decidedBy, 'Amy', 'the name comes from the directory, not from the message');
  assert.equal(a.reviewVia, 'group');
  assert.match(byNo.text, /Amy 已通过 #1/);

  const byId = reviewByMessage(state, ctx(OWNER, `驳回 ${b.id} 暂时不排期`), 9100);
  assert.equal(byId.kind, 'reject');
  assert.equal(b.status, 'dropped');
  assert.equal(b.decision, '暂时不排期');

  const quoted = reviewByMessage(state, ctx('u-amy', '通过', '⏳ 已登记，等审核人确认：\n#3「登录页加验证码」\n审核人回复「同意 3」'), 9200);
  assert.equal(quoted.kind, 'approve');
  assert.equal(c.status, 'todo');
  assert.equal(state.tasks.filter((task) => task.synthetic).length, 2, 'one work task per approval');
});

test('a non-reviewer saying 同意 is ignored: no state change, no task', () => {
  const state = world();
  const item = add(state, '导出按钮改成蓝色', 'u-bob', true).item;
  assert.equal(reviewByMessage(state, { chatKey: GROUP, userid: 'u-bob', content: { text: '同意 1', quote: '' } }), null, 'the requester cannot approve their own item');
  assert.equal(reviewByMessage(state, { chatKey: GROUP, userid: 'u-amy', content: { text: '同意 1', quote: '' } }), null, 'neither can another member');
  assert.equal(reviewByMessage(state, { chatKey: GROUP, userid: 'forged-owner', content: { text: '通过 #1', quote: '' } }), null);
  assert.equal(item.status, 'pending_review');
  assert.equal(state.tasks.length, 0);
});

test('review commands are strict: chat that merely starts with 同意 is not a command; stale numbers are reported', () => {
  assert.equal(parseReviewCommand('同意这个方案，但是排期要再讨论一下看看怎么安排比较合适'), null);
  assert.equal(parseReviewCommand('我同意 1'), null);
  assert.deepEqual(parseReviewCommand('同意 1、2 和 #3'), { kind: 'approve', refs: [{ no: 1 }, { no: 2 }, { no: 3 }], reason: '' });
  assert.deepEqual(parseReviewCommand('不同意 4 太贵了'), { kind: 'reject', refs: [{ no: 4 }], reason: '太贵了' });
  assert.deepEqual(parseReviewCommand('驳回#5：重复了'), { kind: 'reject', refs: [{ no: 5 }], reason: '重复了' });
  assert.equal(parseReviewCommand('同意 3，开始做吧').kind, 'approve');
  assert.equal(parseReviewCommand('通过了吗？'), null, 'a question is not an approval');
  assert.equal(parseReviewCommand('同意 3 吗'), null);
  assert.equal(parseReviewCommand('通过，可以先排到下周再看看'), null, 'no number and a long tail is just chat');
  assert.equal(parseReviewCommand('同意吧').kind, 'approve');
  const state = world();
  assert.equal(reviewByMessage(state, { chatKey: GROUP, userid: OWNER, content: { text: '同意', quote: '' } }), null, 'a bare 同意 with nothing quoted is just a message');
  const stale = reviewByMessage(state, { chatKey: GROUP, userid: OWNER, content: { text: '同意 9', quote: '' } });
  assert.match(stale.text, /没有找到 #9/);
  assert.equal(stale.handled, false);
});

test('requester comes from the plugin task log, never from what the model claims', () => {
  const state = world();
  state.tasks.push({ id: 'm1', chatKey: GROUP, userid: 'u-bob', status: 'queued', sessionId: 'S', createdAt: 1 });
  state.tasks.push({ id: 'm2', chatKey: GROUP, userid: OWNER, status: 'queued', sessionId: 'S', createdAt: 2 });
  const hit = requestersFor(state, { chatKey: GROUP, sessionId: 'S', taskIds: ['m1'], source: 'local' });
  assert.deepEqual(hit.ids, ['u-bob'], 'source=local cannot launder a task that came from Bob');
  const both = requestersFor(state, { chatKey: GROUP, sessionId: 'S', taskIds: ['m1', 'm2'] });
  assert.equal(needsReview(state, GROUP, both.ids), true, 'one non-reviewer in the batch is enough to gate');
  const none = requestersFor(state, { chatKey: GROUP, sessionId: 'S', taskIds: [], source: 'wecom' });
  assert.deepEqual(none.ids.sort(), [OWNER, 'u-bob'].sort(), 'no task ids: use who the session is answering right now');
  const idle = emptyState();
  assert.equal(requestersFor(idle, { chatKey: GROUP, sessionId: 'S', taskIds: [], source: 'local' }).local, true);
  assert.equal(requestersFor(idle, { chatKey: GROUP, sessionId: 'S', taskIds: [], source: 'wecom' }).local, false, 'claiming wecom with no matching message keeps the gate');
  assert.equal(needsReview(idle, GROUP, requestersFor(idle, { chatKey: GROUP, sessionId: 'S', taskIds: ['made-up'], source: 'wecom' }).ids), true);
});

test('prompts tell the model plainly that a pending item may only be clarified', () => {
  const state = world();
  add(state, '导出按钮改成蓝色', 'u-bob', true);
  const append = boardAppend(state, { chatKeys: [GROUP], gateLines: gateLines(state, [GROUP]) });
  assert.match(append, /待审核，不得实现/);
  assert.match(append, /只能澄清/);
  assert.match(append, /审核人：Alice/);
  const start = boardAppend(state, { chatKeys: [GROUP], startWork: true });
  assert.match(start, /不要做，点名跳过/);
  const prompt = buildPrompt(state, { messages: [{ chatKey: GROUP, userid: 'u-bob', taskId: 'm1', content: { text: '导出按钮想改成蓝色', quote: '' }, gate: { gated: true, reviewerNames: ['Alice'] } }] });
  assert.match(prompt, /不是本群的需求审核人/);
  assert.match(prompt, /不能实现/);
  assert.match(prompt, /等审核人确认/);
});

test('the group reply carries the item number and how to approve it', () => {
  const state = world();
  state.tasks.push({ id: 'm1', chatKey: GROUP, userid: 'u-bob', status: 'queued', sessionId: 'S', createdAt: 500 });
  add(state, '导出按钮改成蓝色', 'u-bob', true, { taskIds: ['m1'] });
  add(state, '别的群需求', 'u-bob', true, { chatKey: 'group:other' });
  const suffix = reviewSuffix(state, GROUP, ['m1']);
  assert.match(suffix, /已登记，等审核人确认（审核人：Alice）/);
  assert.match(suffix, /#1「导出按钮改成蓝色」/);
  assert.match(suffix, /同意 1/);
  assert.equal(reviewSuffix(state, GROUP, ['unrelated']), '');
  assert.equal(reviewSuffix(state, 'single:u-bob', ['m1']), '');
});

test('old state.json migrates: items get numbers, layouts keep a 待审核 column, the owner is never guessed', () => {
  const raw = {
    board: {
      ownerToken: 'x'.repeat(24),
      items: [
        { id: 'b_1', chatKey: GROUP, title: '旧需求甲', status: 'todo', createdAt: 20 },
        { id: 'b_2', chatKey: GROUP, title: '旧需求乙', status: 'done', createdAt: 10 },
        { id: 'b_3', chatKey: 'group:h', title: '另一个群', status: 'todo', createdAt: 5 },
      ],
      layouts: { owner: { columns: ['todo', 'doing'] } },
    },
    tasks: [{ id: 't', chatKey: GROUP, userid: 'woFAKE0000000000000000000000user', status: 'replied', createdAt: 1 }],
  };
  const state = normalizeState(raw, {});
  assert.deepEqual(state.board.items.map((item) => [item.id, item.no]), [['b_1', 2], ['b_2', 1], ['b_3', 1]]);
  assert.deepEqual(state.board.seq, { [GROUP]: 2, 'group:h': 1 });
  assert.deepEqual(state.board.gates, {});
  assert.equal(state.board.ownerUserid, '', 'the owner is never guessed from message history; it is picked on the page');
  assert.equal(normalizeLayout(state.board.layouts.owner).columns[0], 'pending_review');
  const next = boardAdd(state, { chatKey: GROUP, title: '新需求', status: '待做' }, 99);
  assert.equal(next.item.no, 3, 'numbers keep counting after the migration');
  const stranger = normalizeState({ board: { items: [] } }, {});
  assert.equal(stranger.board.ownerUserid, '', 'an install that never saw that id gets no owner guessed');
  assert.equal(normalizeBoard({ gates: { 'single:x': { on: false }, [GROUP]: { on: false, reviewers: ['a', 'a', 7] } } }).gates[GROUP].reviewers.length, 2);
  setOwnerUserid(world(), OWNER);
});

test('binding health: predates the board, or used without ever touching a board tool', () => {
  const state = world();
  state.board.since = 1000;
  assert.equal(bindingHealth(state, GROUP).level, 'predates', 'bound at 100, board arrived at 1000');
  assert.match(bindingHealth(state, GROUP).text, /新建一个会话/);
  state.bindings[GROUP].boundAt = 2000;
  assert.equal(bindingHealth(state, GROUP), null, 'a fresh binding is fine until it has been used');
  for (let i = 0; i < 3; i++) state.tasks.push({ id: `r${i}`, chatKey: GROUP, userid: 'u-bob', status: 'replied', createdAt: 3000 + i });
  assert.equal(bindingHealth(state, GROUP).level, 'silent');
  assert.equal(markBoardTool(state, 'S', 4000), true);
  assert.equal(bindingHealth(state, GROUP), null, 'any board tool call proves the session has the tools');
  assert.equal(markBoardTool(state, 'S', 5000), false);
  assert.equal(markBoardTool(state, 'other', 5000), false);
});

test('review messages and approval notices are never offered as missing requirements', async () => {
  const { findMisses } = await import('../src/board.mjs');
  const state = world();
  const now = 1_000_000;
  state.tasks.push({ id: 'r1', chatKey: GROUP, userid: OWNER, text: '驳回 2 这个需求暂时不做了，等下个季度再说吧', status: 'replied', reviewed: true, createdAt: now - 1000 });
  state.tasks.push({ id: 'n1', chatKey: GROUP, userid: 'u-bob', text: '【审核通过】Alice在群里同意了需求 #1「导出按钮改成蓝色」（提出人 Bob）', status: 'replied', synthetic: true, createdAt: now - 1000 });
  state.tasks.push({ id: 'k1', chatKey: GROUP, userid: 'u-bob', text: '能不能把导出按钮改成蓝色', status: 'replied', createdAt: now - 1000 });
  assert.deepEqual(findMisses(state, now).map((miss) => miss.taskId), ['k1']);
});
