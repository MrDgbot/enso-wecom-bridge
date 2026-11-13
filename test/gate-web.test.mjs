// 审核门槛在管理页、分享页和侧栏上的表现，以及补登记和旧会话提示。
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { boardAdd, createShare } from '../src/board.mjs';
import { emptyState, panelView } from '../src/core.mjs';
import { setGate } from '../src/gate.mjs';
import { importMisses } from '../src/review.mjs';
import { createBoardHandler } from '../src/web-board.mjs';
import './no-tunnel.mjs';

const G = 'group:g1';
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const visibleText = (doc) => {
  const body = doc.body.cloneNode(true);
  for (const el of body.querySelectorAll('script, style')) el.remove();
  return body.textContent.replace(/\s+/g, ' ');
};

function fixture() {
  const state = emptyState();
  state.board.ownerUserid = 'owner';
  state.board.since = 1000;
  state.autoNames = { botId: 'bot', users: { owner: 'Alice', bob: 'Bob', amy: 'Amy' }, groups: { g1: '需求对齐群', g2: '设计评审' }, updatedAt: 1 };
  state.chats[G] = { userids: ['owner', 'bob', 'amy'], kind: 'group', target: 'g1', lastUserid: 'bob', lastAt: 1 };
  state.bindings[G] = { sessionId: 'S', title: '旧会话', boundAt: 10 };
  boardAdd(state, { chatKey: G, title: '导出按钮改成蓝色', status: '待做', requesterId: 'bob', source: 'wecom' }, 100, { gated: true });
  boardAdd(state, { chatKey: G, title: '增加批量导入', status: '待做', requesterId: 'bob', source: 'wecom' }, 200, { gated: true });
  boardAdd(state, { chatKey: G, title: '老板自己提的', status: '待做', requesterId: 'owner', source: 'wecom' }, 300, { gated: false });
  return state;
}

async function serve(state, extra = {}) {
  const reviewed = [];
  const server = createServer(createBoardHandler({
    getState: async () => state,
    update: async (fn) => fn(state),
    onReviewed: async (info) => { reviewed.push(info); },
    ...extra,
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, reviewed,
    get: async (path) => { const res = await fetch(origin + path); return { status: res.status, text: await res.text() }; },
    post: async (path, body) => { const res = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; },
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }),
  };
}

async function open(web, path) {
  const { text } = await web.get(path);
  const posts = [];
  const alerts = [];
  const dom = new JSDOM(text, {
    runScripts: 'dangerously',
    virtualConsole: new VirtualConsole(), // location.reload() 在 jsdom 里没有实现，不用打印出来
    url: web.origin + path,
    beforeParse(window) {
      window.alert = (message) => alerts.push(message);
      window.fetch = async (target, options = {}) => {
        posts.push({ target, body: options.body ? JSON.parse(options.body) : null });
        const res = await fetch(web.origin + target, options);
        return { ok: res.ok, status: res.status, json: () => res.json() };
      };
    },
  });
  await tick();
  return { dom, doc: dom.window.document, posts, alerts, text: () => visibleText(dom.window.document), close: () => dom.window.close() };
}

test('owner page: pending count and filter per group, approve/reject buttons, nothing to type a decider name into', async () => {
  const state = fixture();
  const web = await serve(state);
  try {
    const page = await open(web, `/a/${state.board.ownerToken}`);
    assert.match(page.text(), /有 2 条需求待审核：审核人同意前只能澄清，不会开始做/);
    assert.match(page.text(), /#1 导出按钮改成蓝色/);
    assert.match(page.text(), /待审核/);
    assert.equal(page.doc.querySelectorAll('[placeholder="谁拍的板"]').length, 0);
    assert.equal([...page.doc.querySelectorAll('#board button')].filter((el) => el.textContent === '同意，开始做').length, 2);
    // 只看待审核：老板自己提的那条（待做）被收起来
    [...page.doc.querySelectorAll('#review button')].find((el) => el.textContent === '只看待审核').click();
    await tick();
    assert.doesNotMatch(page.doc.getElementById('board').textContent, /老板自己提的/);
    assert.match(page.doc.getElementById('board').textContent, /增加批量导入/);
    // 驳回：带原因，请求里没有任何「谁」
    const reason = page.doc.querySelector('#board input[placeholder="驳回原因（可选）"]');
    reason.value = '范围太大';
    [...page.doc.querySelectorAll('#board button')].find((el) => el.textContent === '驳回').click();
    await tick(80);
    const post = page.posts.find((entry) => /\/review$/.test(entry.target));
    assert.deepEqual(post.body, { verdict: 'reject', reason: '范围太大' });
    const dropped = state.board.items.filter((item) => item.status === 'dropped');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].decidedBy, '所有者');
    assert.equal(dropped[0].decision, '范围太大');
    page.close();
  } finally { await web.close(); }
});

test('owner page: reviewer settings per group are saved through the owner-only /gates, strangers are refused', async () => {
  const state = fixture();
  const web = await serve(state);
  try {
    const page = await open(web, `/a/${state.board.ownerToken}`);
    assert.match(page.text(), /需求审核人/);
    const details = page.doc.querySelector('#gates details.gate');
    assert.match(details.querySelector('summary').textContent, /需求对齐群 · 门槛开 · 审核人 Alice · 2 条待审核/);
    const boxes = [...details.querySelectorAll('.picks input')];
    const owner = boxes.find((el) => el.value === 'owner');
    assert.equal(owner.checked && owner.disabled, true, 'the owner is always a reviewer and cannot be unticked');
    boxes.find((el) => el.value === 'amy').click();
    [...details.querySelectorAll('button')].find((el) => el.textContent === '保存审核设置').click();
    await tick(80);
    assert.deepEqual(page.posts.find((entry) => entry.target.endsWith('/gates')).body, { chatKey: G, on: true, reviewers: ['amy'] });
    assert.deepEqual(state.board.gates[G], { on: true, reviewers: ['amy'] });
    page.close();
    const off = await web.post(`/a/${state.board.ownerToken}/gates`, { chatKey: G, on: false });
    assert.equal(off.status, 200);
    assert.equal(state.board.gates[G].on, false);
    assert.deepEqual(state.board.gates[G].reviewers, ['amy']);
    const stranger = await web.post(`/a/${state.board.ownerToken}/gates`, { chatKey: G, reviewers: ['nobody'] });
    assert.equal(stranger.status, 400);
    const single = await web.post(`/a/${state.board.ownerToken}/gates`, { chatKey: 'single:bob', on: false });
    assert.equal(single.status, 400);
    const me = await web.post(`/a/${state.board.ownerToken}/owner`, { userid: 'amy' });
    assert.equal(me.status, 200);
    assert.equal(state.board.ownerUserid, 'amy');
    assert.equal((await web.post(`/a/${state.board.ownerToken}/owner`, { userid: 'nobody' })).status, 400);
    // 分享链接碰不到审核设置
    const share = createShare(state, { name: '小王', role: 'decide', projects: [G] });
    for (const path of ['gates', 'owner', 'misses/import']) {
      const res = await web.post(`/s/${share.token}/${path}`, { chatKey: G, on: false, userid: 'bob' });
      assert.equal(res.status, 404, path);
    }
    assert.equal(state.board.gates[G].on, false, 'unchanged by the share attempts');
    state.board.gates[G].on = true;
    const api = JSON.parse((await web.get(`/s/${share.token}/api`)).text);
    assert.deepEqual(api.gates, []);
    assert.equal(api.owner, null);
  } finally { await web.close(); }
});

test('share links: a decide link sees pending items and can review them in scope only; a read link gets no buttons', async () => {
  const state = fixture();
  boardAdd(state, { chatKey: 'group:g2', title: '别的群的待审核', status: '待做', requesterId: 'bob', source: 'wecom' }, 400, { gated: true });
  const decide = createShare(state, { name: '小王', role: 'decide', projects: [G] });
  const read = createShare(state, { name: '围观', role: 'read', projects: [G] });
  const web = await serve(state);
  try {
    const mine = await open(web, `/s/${decide.token}`);
    assert.equal([...mine.doc.querySelectorAll('#board button')].filter((el) => el.textContent === '同意，开始做').length, 2);
    assert.doesNotMatch(mine.text(), /别的群的待审核|需求审核人/);
    mine.close();
    const ro = await open(web, `/s/${read.token}`);
    assert.equal([...ro.doc.querySelectorAll('#board button')].filter((el) => el.textContent === '同意，开始做').length, 0);
    assert.match(ro.text(), /待审核/);
    ro.close();
    const outside = state.board.items.find((item) => item.chatKey === 'group:g2');
    assert.equal((await web.post(`/s/${decide.token}/items/${outside.id}/review`, { verdict: 'approve' })).status, 404);
    assert.equal((await web.post(`/s/${read.token}/items/${state.board.items[0].id}/review`, { verdict: 'approve' })).status, 403);
    assert.equal(state.board.items[0].status, 'pending_review');
    const ok = await web.post(`/s/${decide.token}/items/${state.board.items[0].id}/review`, { verdict: 'approve', decidedBy: '冒充' });
    assert.equal(ok.status, 200);
    assert.equal(state.board.items[0].decidedBy, '小王');
    assert.equal(web.reviewed.length, 1);
    assert.match(web.reviewed[0].text, /小王 已通过 #1/);
    assert.equal((await web.post(`/s/${decide.token}/items/${state.board.items[0].id}/review`, { verdict: 'approve' })).status, 409);
    assert.equal((await web.post(`/s/${decide.token}/items/${state.board.items[1].id}/review`, { verdict: 'maybe' })).status, 400);
    // 通用的改状态入口不能绕过审核，也不能用来冒充审核人
    const via = await web.post(`/s/${decide.token}/items/${state.board.items[1].id}`, { status: '进行中', decidedBy: '老板' });
    assert.equal(via.status, 400);
    assert.match(via.body.error, /待审核/);
    assert.equal(state.board.items[1].status, 'pending_review');
    // 链接收回之后，同一个请求立刻失效
    state.board.shares.find((s) => s.id === decide.id).revoked = true;
    assert.equal((await web.post(`/s/${decide.token}/items/${state.board.items[1].id}/review`, { verdict: 'approve' })).status, 401);
  } finally { await web.close(); }
});

test('补登记: imports misses with chat, requester and createdAt, goes through the gate, de-duplicates and is idempotent', async () => {
  const state = emptyState();
  state.board.ownerUserid = 'owner';
  state.autoNames = { botId: 'bot', users: { owner: 'Alice', bob: 'Bob' }, groups: { g1: '需求对齐群', g2: '设计评审' }, updatedAt: 1 };
  state.tasks.push({ id: 't1', chatKey: G, userid: 'bob', text: '能不能把导出按钮改成蓝色。顺便把字号调大', status: 'replied', createdAt: 111 });
  state.tasks.push({ id: 't2', chatKey: G, userid: 'owner', text: '登录页要加一个记住我选项', status: 'replied', createdAt: 222 });
  state.tasks.push({ id: 't3', chatKey: 'single:bob', userid: 'bob', text: '私聊里问一下批量导入怎么做', status: 'replied', createdAt: 333 });
  state.tasks.push({ id: 't4', chatKey: G, userid: 'bob', text: '已经在看板上的那条需求', status: 'replied', createdAt: 444 });
  state.tasks.push({ id: 't5', chatKey: 'group:g2', userid: 'bob', text: '设计群里的需求，这次不导入', status: 'replied', createdAt: 555 });
  boardAdd(state, { chatKey: G, title: '已经在看板上的那条需求', status: '待做', requesterId: 'bob' }, 1);
  state.board.misses = state.tasks.map((task) => ({ taskId: task.id, chatKey: task.chatKey, text: task.text, requesterId: task.userid, createdAt: task.createdAt, status: task.status }));
  const web = await serve(state);
  try {
    const first = await web.post(`/a/${state.board.ownerToken}/misses/import`, { chatKey: G });
    assert.equal(first.status, 200);
    assert.deepEqual({ imported: first.body.imported, skipped: first.body.skipped, pending: first.body.pending }, { imported: 2, skipped: 1, pending: 1 });
    const byTask = (id) => state.board.items.find((item) => item.taskIds.includes(id));
    assert.equal(byTask('t1').status, 'pending_review', 'Bob is not a reviewer: same gate as live requests');
    assert.equal(byTask('t1').requester.id, 'bob');
    assert.equal(byTask('t1').createdAt, 111);
    assert.equal(byTask('t1').chatKey, G);
    assert.equal(byTask('t1').title, '能不能把导出按钮改成蓝色');
    assert.match(byTask('t1').detail, /顺便把字号调大/);
    assert.equal(byTask('t2').status, 'todo', 'the owner is a reviewer: straight to 待做');
    assert.equal(byTask('t2').createdAt, 222);
    assert.equal(byTask('t5'), undefined, 'only the requested group was imported');
    assert.deepEqual(state.board.misses.map((miss) => miss.taskId), ['t3', 't5'], 'handled misses are removed, the rest stay');
    const again = await web.post(`/a/${state.board.ownerToken}/misses/import`, { chatKey: G });
    assert.equal(again.body.imported, 0, 'a second click does not duplicate');
    const rest = importMisses(state, {}, 999);
    assert.equal(rest.imported, 2);
    assert.equal(byTask('t3').status, 'todo', 'a private chat has no gate');
    assert.equal(byTask('t5').status, 'pending_review');
    assert.equal(state.board.misses.length, 0);
    assert.equal(state.board.items.length, 5);
    assert.deepEqual([...new Set(state.board.items.filter((item) => item.chatKey === G).map((item) => item.no))].sort(), [1, 2, 3], 'numbers stay unique per chat');
    // 门槛关了之后补登记不再待审核
    setGate(state, 'group:g2', { on: false });
    state.tasks.push({ id: 't6', chatKey: 'group:g2', userid: 'bob', text: '关了门槛之后进来的需求', status: 'replied', createdAt: 600 });
    state.board.misses = [{ taskId: 't6', chatKey: 'group:g2', text: '关了门槛之后进来的需求', requesterId: 'bob', createdAt: 600 }];
    importMisses(state, {}, 1000);
    assert.equal(byTask('t6').status, 'todo');
  } finally { await web.close(); }
});

test('owner page shows the 补登记 button and the rebind hint; the sidebar shows the same hint, the pending count and an import button', async () => {
  const state = fixture();
  state.board.misses = [{ taskId: 'm1', chatKey: G, text: '能不能把标题加长', requesterId: 'bob', createdAt: 5 }];
  const web = await serve(state);
  try {
    const page = await open(web, `/a/${state.board.ownerToken}`);
    assert.match(page.text(), /这些群接的会话可能没有看板工具/);
    assert.match(page.text(), /需求对齐群：这个聊天接的会话是在看板和审核门槛上线前绑的/);
    const button = [...page.doc.querySelectorAll('#misses button')].find((el) => el.textContent.startsWith('补登记 1 条'));
    assert.ok(button);
    button.click();
    await tick(80);
    assert.deepEqual(page.posts.find((entry) => entry.target.endsWith('/misses/import')).body, { chatKey: '' });
    assert.match(page.alerts.at(-1), /已补登记 1 条，其中 1 条待审核/);
    page.close();
  } finally { await web.close(); }

  const view = () => ({ ...panelView(state, { status: 'online', botId: 'bot', detail: '' }, null, new Map()), nameSync: { status: 'ready', detail: '' } });
  assert.equal(view().chats.find((chat) => chat.chatKey === G).boardHint.level, 'predates');
  const html = await readFile(new URL('../plugin/panel.html', import.meta.url), 'utf8');
  const calls = [];
  state.board.misses = [{ taskId: 'm2', chatKey: G, text: '再加一个导出格式', requesterId: 'bob', createdAt: 6 }];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.enso = Object.freeze({ theme: 'dark', onTheme() {}, on() {}, async call(method, args = {}) { calls.push({ method, args }); return view(); } });
    },
  });
  try {
    await tick(50);
    const doc = dom.window.document;
    assert.match(doc.querySelector('[data-act="tab"][data-tab="board"]').textContent, /3/, 'the 看板 tab badge counts items waiting for review (2 live + 1 imported above)');
    doc.querySelector('[data-act="tab"][data-tab="chats"]').click();
    await tick();
    assert.match(visibleText(doc), /会话可能没有看板工具，请在新会话里重新绑定/);
    doc.querySelector('[data-act="tab"][data-tab="board"]').click();
    await tick();
    assert.match(visibleText(doc), /待审核 3/);
    assert.match(visibleText(doc), /需求对齐群 · 审核门槛：开 · 审核人 Alice · 3 条待审核/);
    assert.match(visibleText(doc), /会话可能没有看板工具/);
    assert.match(visibleText(doc), /#1 导出按钮改成蓝色/);
    [...doc.querySelectorAll('[data-act="importMisses"]')][0].click();
    await tick(50);
    assert.deepEqual(calls.filter((c) => c.method === 'importMisses').map((c) => ({ ...c.args })), [{ chatKey: '' }]);
  } finally { dom.window.close(); }
});
