import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import AiBot from '@wecom/aibot-node-sdk';
import { activate, deactivate } from '../src/main.mjs';
import { emptyState } from '../src/core.mjs';
import './no-tunnel.mjs';

const until = async (predicate, label) => {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(label || 'timed out');
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot({ prep } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-gate-'));
  const original = AiBot.WSClient;
  const originalFetch = globalThis.fetch;
  const ctx = { events: new Map(), handlers: new Map(), replies: [], pushes: [], injections: [], dataDir, client: null };
  const state = emptyState();
  state.board.ownerUserid = 'owner';
  state.autoNames = { botId: 'bot', users: { owner: 'Alice', bob: 'Bob', amy: 'Amy' }, groups: { g: '设计群' }, updatedAt: 1 };
  state.bindings = { 'group:g': { sessionId: 'S', title: '项目会话', projectRoot: '/work', boundAt: Date.now() } };
  prep?.(state);
  await writeFile(join(dataDir, 'state.json'), JSON.stringify(state));
  AiBot.WSClient = class extends EventEmitter {
    constructor() { super(); ctx.client = this; this.isConnected = true; }
    connect() { this.emit('authenticated'); }
    disconnect() {}
    async replyStream(_frame, _id, text) { ctx.replies.push(text); }
    async sendMessage(chat, body) { ctx.pushes.push({ chat, text: body.markdown.content }); }
    async downloadFile() { throw new Error('no images in this test'); }
  };
  globalThis.fetch = async (url, init) => (String(url).startsWith('http://127.0.0.1:')
    ? originalFetch(url, init)
    : new Response(JSON.stringify(String(url).endsWith('get_cli_config') ? { token: 't' } : { results_json: JSON.stringify({ result: { sessions: [] } }) })));
  activate({
    dataDir,
    config: { get: async () => ({ botId: 'bot', secret: 'secret' }) },
    tools: { register: (name, fn) => ctx.handlers.set(name, fn) },
    events: { on: (name, fn) => ctx.events.set(name, fn) },
    renderer: { handle: (name, fn) => ctx.handlers.set(name, fn) },
    ui: { view: { emit() {} } },
    session: {
      list: async () => ({ sessions: [{ id: 'S', title: '项目会话' }] }),
      inject: async (input) => { ctx.injections.push(input); return {}; },
    },
  });
  await until(() => ctx.client, 'socket');
  ctx.emit = (id, text, { userid = 'bob', quote } = {}) => ctx.client.emit('message', {
    headers: { req_id: id },
    body: { msgid: id, chattype: 'group', chatid: 'g', from: { userid }, msgtype: 'text', text: { content: text }, ...(quote ? { quote: { msgtype: 'text', text: { content: quote } } } : {}) },
  });
  ctx.saved = async () => JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
  ctx.close = async () => {
    deactivate();
    AiBot.WSClient = original;
    globalThis.fetch = originalFetch;
    await sleep(30);
    await rm(dataDir, { recursive: true, force: true });
  };
  return ctx;
}

// 走一遍：Bob 在群里提需求 → 助手登记（模型自己乱填提出人也没用）→ 回复里自带编号和审核方式
async function bobRaises(rt, extra = {}) {
  rt.emit('m1', '导出按钮想改成蓝色', { userid: 'bob' });
  await until(() => rt.injections.some((i) => /导出按钮/.test(i.text)), 'injected');
  await rt.handlers.get('board_add')({ title: '导出按钮改成蓝色', chatKey: 'group:g', status: '待做', source: 'local', requesterId: 'owner', requesterName: '老板', taskIds: ['m1'], ...extra }, { sessionId: 'S' });
}

test('gate ON end to end: Bob raises, it waits as 待审核, the prompt and the group reply say so; forged requester/source do not help', async () => {
  const rt = await boot();
  try {
    await bobRaises(rt);
    assert.match(rt.injections[0].text, /不是本群的需求审核人（审核人：Alice）/);
    assert.match(rt.injections[0].text, /不能实现/);
    const saved = await rt.saved();
    const item = saved.board.items[0];
    assert.equal(item.status, 'pending_review');
    assert.equal(item.requester.id, 'bob', 'requester comes from the task log, not from the model');
    assert.equal(item.source, 'wecom');
    assert.equal(item.no, 1);
    await assert.rejects(rt.handlers.get('board_update')({ id: item.id, status: '进行中' }, { sessionId: 'S' }), /待审核/);
    const hook = await rt.events.get('before_agent_start')({ prompt: '开始做', kind: 'user' }, { sessionId: 'S' });
    assert.match(hook.append, /待审核，不得实现/);
    assert.match(hook.append, /群「设计群」的审核门槛已开启，审核人：Alice/);
    await rt.events.get('agent_end')({ text: '已记下，我先确认一下细节。' }, { sessionId: 'S' });
    await until(() => rt.pushes.length === 1, 'group reply');
    assert.match(rt.pushes[0].text, /已记下，我先确认一下细节/);
    assert.match(rt.pushes[0].text, /已登记，等审核人确认（审核人：Alice）/);
    assert.match(rt.pushes[0].text, /#1「导出按钮改成蓝色」/);
    assert.match(rt.pushes[0].text, /同意 1/);
  } finally {
    await rt.close();
  }
});

test('gate ON: a reviewer in the group approves by number; the item opens, the requester session gets a work task, the group is told', async () => {
  const rt = await boot();
  try {
    await bobRaises(rt);
    await rt.events.get('agent_end')({ text: '已登记。' }, { sessionId: 'S' });
    await until(() => rt.pushes.length === 1);
    rt.emit('m2', '同意 1', { userid: 'owner' });
    await until(() => rt.replies.some((text) => /已通过 #1/.test(text)), 'group notice');
    await until(() => rt.injections.some((i) => /审核通过/.test(i.text)), 'work task injected');
    const saved = await rt.saved();
    const item = saved.board.items[0];
    assert.equal(item.status, 'todo');
    assert.equal(item.decidedBy, 'Alice');
    assert.equal(item.reviewVia, 'group');
    const approval = saved.tasks.find((task) => task.id === 'm2');
    assert.equal(approval.status, 'replied', 'the approval message itself is not forwarded to the session as work');
    assert.equal(rt.injections.filter((i) => /同意 1/.test(i.text) && !/审核通过/.test(i.text)).length, 0);
    const work = rt.injections.find((i) => /审核通过/.test(i.text));
    assert.match(work.text, /Alice在群里同意了需求 #1「导出按钮改成蓝色」/);
    assert.match(work.text, /审核通知/);
    // 助手做完之后的最终回复照常发回群里
    await rt.events.get('agent_end')({ text: '蓝色已经改好。' }, { sessionId: 'S' });
    await until(() => rt.pushes.some((push) => /蓝色已经改好/.test(push.text)), 'result posted to the group');
  } finally {
    await rt.close();
  }
});

test('gate ON: approving by quoting the registered reply works; rejecting closes the item with the reason', async () => {
  const rt = await boot();
  try {
    await bobRaises(rt);
    await rt.handlers.get('board_add')({ title: '把首页全部重做', chatKey: 'group:g', status: '待做', taskIds: ['m1'] }, { sessionId: 'S' });
    await rt.events.get('agent_end')({ text: '已登记。' }, { sessionId: 'S' });
    await until(() => rt.pushes.length === 1);
    const posted = rt.pushes[0].text;
    assert.match(posted, /#1「导出按钮改成蓝色」/);
    assert.match(posted, /#2「把首页全部重做」/);
    rt.emit('m2', '驳回 2 本期不排', { userid: 'owner' });
    await until(() => rt.replies.some((text) => /已驳回 #2/.test(text)), 'reject notice');
    rt.emit('m3', '通过', { userid: 'owner', quote: posted });
    await until(() => rt.replies.some((text) => /已通过 #1/.test(text)), 'quote approval');
    const saved = await rt.saved();
    const byNo = Object.fromEntries(saved.board.items.map((item) => [item.no, item]));
    assert.equal(byNo[1].status, 'todo');
    assert.equal(byNo[2].status, 'dropped');
    assert.equal(byNo[2].decision, '本期不排');
    assert.equal(byNo[2].decidedBy, 'Alice');
  } finally {
    await rt.close();
  }
});

test('gate ON: a non-reviewer saying 同意 is forwarded as an ordinary message and changes nothing', async () => {
  const rt = await boot({ prep: (s) => { s.board.gates['group:g'] = { on: true, reviewers: ['amy'] }; } });
  try {
    await bobRaises(rt);
    await rt.events.get('agent_end')({ text: '已登记。' }, { sessionId: 'S' });
    await until(() => rt.pushes.length === 1);
    const before = rt.injections.length;
    rt.emit('m2', '同意 1', { userid: 'bob' });
    await until(() => rt.injections.length === before + 1, 'forwarded to the session as a normal message');
    assert.match(rt.injections.at(-1).text, /发送人 Bob/);
    assert.match(rt.injections.at(-1).text, /不是本群的需求审核人（审核人：Alice、Amy）/);
    const saved = await rt.saved();
    assert.equal(saved.board.items[0].status, 'pending_review');
    assert.equal(saved.tasks.filter((task) => task.synthetic).length, 0);
    // 指定的审核人 Amy 说同意，就生效
    rt.emit('m3', '同意 1', { userid: 'amy' });
    await until(async () => (await rt.saved()).board.items[0].status === 'todo', 'Amy approves');
    assert.equal((await rt.saved()).board.items[0].decidedBy, 'Amy');
  } finally {
    await rt.close();
  }
});

test('gate OFF and reviewer-raised requirements are registered straight to 待做', async () => {
  const rt = await boot({ prep: (s) => { s.board.gates['group:g'] = { on: false, reviewers: [] }; } });
  try {
    await bobRaises(rt);
    assert.doesNotMatch(rt.injections[0].text, /审核门槛/);
    assert.equal((await rt.saved()).board.items[0].status, 'todo');
    await rt.events.get('agent_end')({ text: '好的。' }, { sessionId: 'S' });
    await until(() => rt.pushes.length === 1);
    assert.doesNotMatch(rt.pushes[0].text, /等审核人确认/);
  } finally {
    await rt.close();
  }
  const rt2 = await boot();
  try {
    rt2.emit('o1', '登录页加一个记住我', { userid: 'owner' });
    await until(() => rt2.injections.length === 1);
    assert.doesNotMatch(rt2.injections[0].text, /不是本群的需求审核人/, 'the owner is a reviewer by default');
    await rt2.handlers.get('board_add')({ title: '登录页加记住我', chatKey: 'group:g', status: '待做', taskIds: ['o1'] }, { sessionId: 'S' });
    assert.equal((await rt2.saved()).board.items[0].status, 'todo');
  } finally {
    await rt2.close();
  }
});

test('page approval through the real web server: owner approves, a decide link can reject, a read link cannot; decidedBy is never taken from the body', async () => {
  const rt = await boot();
  try {
    await bobRaises(rt);
    const snap = await rt.handlers.get('snapshot')({ sessionId: 'S' });
    const owner = snap.board.localUrl;
    assert.match(owner, /^http:\/\/127\.0\.0\.1:\d+\/a\//);
    const origin = new URL(owner).origin;
    const state = await rt.saved();
    const id = state.board.items[0].id;
    // 只读链接不能审核
    const create = async (role) => (await (await fetch(`${owner}/shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: role === 'read' ? '围观' : '小王', role, projects: ['group:g'] }) })).json());
    const reader = await create('read');
    const decider = await create('decide');
    const denied = await fetch(`${origin}/s/${reader.token}/items/${id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'approve' }) });
    assert.equal(denied.status, 403);
    // 拍板链接：驳回，名字只能是链接自己的名字
    const rejected = await fetch(`${origin}/s/${decider.token}/items/${id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'reject', reason: '先不做', decidedBy: '老板', reviewVia: 'group' }) });
    assert.equal(rejected.status, 200);
    const afterReject = (await rt.saved()).board.items[0];
    assert.equal(afterReject.status, 'dropped');
    assert.equal(afterReject.decidedBy, '小王');
    assert.equal(afterReject.reviewVia, 'share');
    await until(() => rt.pushes.some((push) => /小王 已驳回 #1/.test(push.text)), 'group told');
    // 第二次审核已处理的条目：409，不会重复生效
    const again = await fetch(`${owner}/items/${id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'approve' }) });
    assert.equal(again.status, 409);
    // 新的一条：所有者同意，body 里的 decidedBy 被忽略
    await rt.handlers.get('board_add')({ title: '导出加一个 CSV 选项', chatKey: 'group:g', status: '待做', taskIds: ['m1'] }, { sessionId: 'S' });
    const second = (await rt.saved()).board.items.find((item) => item.no === 2);
    const approved = await fetch(`${owner}/items/${second.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'approve', decidedBy: '冒充的人' }) });
    assert.equal(approved.status, 200);
    const done = (await rt.saved()).board.items.find((item) => item.no === 2);
    assert.equal(done.status, 'todo');
    assert.equal(done.decidedBy, '所有者');
    await until(() => rt.injections.some((i) => /审核通过/.test(i.text) && /CSV/.test(i.text)), 'work task from the page approval');
    await until(() => rt.pushes.some((push) => /所有者 已通过 #2/.test(push.text)), 'group told about the approval');
  } finally {
    await rt.close();
  }
});

test('board tools mark the binding so the sidebar stops saying the session predates the board', async () => {
  const rt = await boot({ prep: (s) => { s.board.since = Date.now() + 1000; s.bindings['group:g'].boundAt = 5; } });
  try {
    const first = await rt.handlers.get('snapshot')({});
    assert.equal(first.chats.find((chat) => chat.chatKey === 'group:g').boardHint.level, 'predates');
    await rt.handlers.get('board_list')({}, { sessionId: 'S' });
    const next = await rt.handlers.get('snapshot')({});
    assert.equal(next.chats.find((chat) => chat.chatKey === 'group:g').boardHint, null);
    assert.ok((await rt.saved()).bindings['group:g'].boardToolAt > 0);
  } finally {
    await rt.close();
  }
});

test('补登记 from the sidebar goes through the host: imports the old misses once, gated, with the original time', async () => {
  const rt = await boot({
    prep: (s) => {
      s.tasks.push({ id: 'old1', chatKey: 'group:g', userid: 'bob', text: '能不能给导出加一个 CSV 选项', status: 'replied', createdAt: 12345 });
      s.board.misses = [{ taskId: 'old1', chatKey: 'group:g', text: '能不能给导出加一个 CSV 选项', requesterId: 'bob', createdAt: 12345, status: 'replied' }];
    },
  });
  try {
    await assert.rejects(rt.handlers.get('importMisses')({ chatKey: 'nope' }, {}), /不合法/);
    const snap = await rt.handlers.get('importMisses')({ chatKey: '' }, {});
    assert.equal(snap.board.misses.length, 0);
    const item = (await rt.saved()).board.items[0];
    assert.equal(item.status, 'pending_review');
    assert.equal(item.createdAt, 12345);
    assert.equal(item.requester.id, 'bob');
    assert.equal(item.chatKey, 'group:g');
    const again = await rt.handlers.get('importMisses')({}, {});
    assert.equal(again.board.items.length, 1);
  } finally {
    await rt.close();
  }
});

test('two reviewers acting at the same moment: exactly one wins, the item is decided once and only an approval queues work', async () => {
  const rt = await boot();
  try {
    await bobRaises(rt);
    const snap = await rt.handlers.get('snapshot')({ sessionId: 'S' });
    const owner = snap.board.localUrl;
    const id = (await rt.saved()).board.items[0].id;
    const act = (verdict) => fetch(`${owner}/items/${id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict }) });
    const [a, b, c] = await Promise.all([act('approve'), act('reject'), act('approve')]);
    assert.deepEqual([a.status, b.status, c.status].sort(), [200, 409, 409]);
    const saved = await rt.saved();
    const item = saved.board.items[0];
    assert.ok(['todo', 'dropped'].includes(item.status));
    assert.equal(saved.tasks.filter((task) => task.synthetic).length, item.status === 'todo' ? 1 : 0);
    // 同时，群里的口令和页面按钮抢同一条：群里那条要么生效要么说明已处理，不会重复开工
    await rt.handlers.get('board_add')({ title: '第二条需求', chatKey: 'group:g', status: '待做', taskIds: ['m1'] }, { sessionId: 'S' });
    const second = (await rt.saved()).board.items.find((entry) => entry.no === 2);
    rt.emit('r1', '同意 2', { userid: 'owner' });
    const page = act2(owner, second.id);
    await Promise.all([page]);
    await until(async () => (await rt.saved()).tasks.some((task) => task.id === 'r1' && task.status === 'replied'), 'group command settled');
    const end = await rt.saved();
    assert.equal(end.board.items.find((entry) => entry.no === 2).status, 'todo');
    assert.equal(end.tasks.filter((task) => task.synthetic && /第二条需求/.test(task.text)).length, 1);
  } finally {
    await rt.close();
  }
});
const act2 = (owner, id) => fetch(`${owner}/items/${id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'approve' }) });

test('the model cannot write the decider: board_update ignores decidedBy and decision text never changes who decided', async () => {
  const rt = await boot({ prep: (s) => { s.board.gates['group:g'] = { on: false, reviewers: [] }; } });
  try {
    await bobRaises(rt);
    const item = (await rt.saved()).board.items[0];
    await rt.handlers.get('board_update')({ id: item.id, status: '进行中', decision: '按这个做', decidedBy: '老板' }, { sessionId: 'S' });
    const after = (await rt.saved()).board.items[0];
    assert.equal(after.status, 'doing');
    assert.equal(after.decision, '按这个做');
    assert.equal(after.decidedBy, '');
  } finally {
    await rt.close();
  }
});
