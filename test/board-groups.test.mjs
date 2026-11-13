// 看板里的群名、按群查看、分享范围里的群名，以及侧栏看板页。
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { boardAdd, createShare, normalizeLayout, saveLayout } from '../src/board.mjs';
import { boardScope, chatLabel, emptyState, namedItem, panelView } from '../src/core.mjs';
import { createBoardHandler } from '../src/web-board.mjs';

const RAW = 'group:wrFAKE0000000000000000000group';
const RAW_ID = RAW.slice('group:'.length);
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
// 只取看得见的文字：页面脚本和样式里的字符串不算。
const visibleText = (doc) => {
  const body = doc.body.cloneNode(true);
  for (const el of body.querySelectorAll('script, style')) el.remove();
  return body.textContent.replace(/\s+/g, ' ');
};

function fixture() {
  const state = emptyState();
  state.autoNames = { botId: 'bot-1', users: { u1: '张三', u2: '李四' }, groups: { [RAW_ID]: '需求对齐群', beta: '设计评审', gamma: '运营周会' }, updatedAt: 1 };
  boardAdd(state, { chatKey: RAW, title: '商品标题规则', status: '待做', requesterId: 'u1', source: 'wecom', taskIds: ['t1'] }, 1);
  boardAdd(state, { chatKey: RAW, title: '主图尺寸', status: '待决定', requesterId: 'u2', source: 'wecom' }, 2);
  boardAdd(state, { chatKey: 'group:beta', title: '评审排期', status: '待做', requesterId: 'u1', source: 'wecom' }, 3);
  boardAdd(state, { chatKey: 'group:gamma', title: '周报模板', status: '进行中', requesterId: 'u2', source: 'wecom' }, 4);
  state.board.misses = [
    { taskId: 'm1', chatKey: RAW, text: '能不能把标题加长', requesterId: 'u1', createdAt: 5, status: 'replied' },
    { taskId: 'm2', chatKey: 'group:beta', text: '评审会改到周四', requesterId: 'u2', createdAt: 6, status: 'replied' },
  ];
  return state;
}

async function serve(state) {
  const server = createServer(createBoardHandler({
    getState: async () => state,
    update: async (fn) => fn(state),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    get: async (path) => { const res = await fetch(origin + path); return { status: res.status, text: await res.text() }; },
    post: async (path, body) => { const res = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; },
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }),
  };
}

// 在 jsdom 里真的跑看板页面脚本；fetch 转发给真实服务，记录下页面发出的请求。
async function open(web, path) {
  const { text } = await web.get(path);
  const posts = [];
  const alerts = [];
  const dom = new JSDOM(text, {
    runScripts: 'dangerously',
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
  const doc = dom.window.document;
  return {
    dom, doc, posts, alerts, html: text,
    text: () => visibleText(doc),
    chips: () => [...doc.querySelectorAll('#groups .chip')],
    chip: (name) => [...doc.querySelectorAll('#groups .chip')].find((el) => el.textContent.includes(name)),
    headings: () => [...doc.querySelectorAll('#board h2')].map((el) => el.textContent),
    close: () => dom.window.close(),
  };
}

test('chatLabel resolves manual remarks first, then synced names, and never shows the raw id as the name', () => {
  const state = fixture();
  assert.equal(chatLabel(state, RAW).name, '需求对齐群');
  assert.equal(chatLabel(state, RAW).named, true);
  state.names[RAW_ID] = '我的备注';
  assert.equal(chatLabel(state, RAW).name, '我的备注');
  delete state.names[RAW_ID];
  delete state.autoNames.groups[RAW_ID];
  const fallback = chatLabel(state, RAW);
  assert.equal(fallback.named, false);
  assert.match(fallback.name, /^群名未获取/);
  assert.ok(!fallback.name.includes(RAW_ID), 'the full id is not shown');
  assert.equal(chatLabel(state, 'single:u1').title, '张三（私聊）');
  // 名字不落进条目，之后同步到的名字立刻生效
  assert.equal(JSON.stringify(state.board.items).includes('迭代'), false);
  state.autoNames.groups[RAW_ID] = '同步来的新名字';
  assert.equal(namedItem(state, state.board.items[0]).chatName, '同步来的新名字');
  assert.equal(namedItem(state, state.board.items[0]).requesterName, '张三');
});

test('layout remembers the group, ignores nonsense, and a share cannot park on a group outside its scope', () => {
  assert.equal(normalizeLayout({ group: RAW }).group, RAW);
  assert.equal(normalizeLayout({ group: 'oops' }).group, '');
  assert.equal(normalizeLayout({ group: { x: 1 } }).group, '');
  assert.equal(normalizeLayout(null).group, '');
  const state = fixture();
  const share = createShare(state, { name: '甲', projects: [RAW] });
  const auth = { kind: 'share', id: share.id, share };
  assert.equal(saveLayout(state, auth, { group: 'group:beta' }).group, '');
  assert.equal(saveLayout(state, auth, { group: RAW }).group, RAW);
});

test('boardScope: owner sees every group with counts, a share only its own groups', () => {
  const state = fixture();
  const owner = boardScope(state, { kind: 'owner', id: 'owner' });
  assert.deepEqual(owner.groups.map((g) => [g.name, g.count, g.misses]).sort(), [['需求对齐群', 2, 1], ['设计评审', 1, 1], ['运营周会', 1, 0]].sort());
  assert.ok(owner.directory.groups.length >= 3);
  assert.deepEqual(owner.directory.users.map((u) => u.name).sort(), ['张三', '李四'].sort());
  const share = createShare(state, { name: '乙', projects: [RAW, 'group:gamma'] });
  const mine = boardScope(state, { kind: 'share', id: share.id, share });
  assert.deepEqual(mine.groups.map((g) => g.name).sort(), ['需求对齐群', '运营周会'].sort());
  assert.equal(mine.directory, null);
  assert.equal(mine.groups.every((g) => g.misses === 0), true);
});

test('web board: the page shows group names (id only as tooltip), misses are labelled, group chips filter and are remembered', async () => {
  const state = fixture();
  const web = await serve(state);
  try {
    const page = await open(web, `/a/${state.board.ownerToken}`);
    assert.doesNotMatch(page.text(), /group:|wrFAKE00/, 'no raw chatKey in visible text');
    assert.match(page.text(), /需求对齐群/);
    const miss = [...page.doc.querySelectorAll('.miss')].find((el) => el.textContent.includes('能不能把标题加长'));
    assert.ok(miss, 'miss rendered');
    assert.match(miss.textContent, /张三/);
    assert.ok(page.html.includes(RAW), 'the id is still available (tooltips)');
    assert.equal(page.chips().length, 4, '全部 + 3 groups');
    assert.match(page.chip('全部').textContent, /4/);
    assert.match(page.chip('需求对齐群').textContent, /2 · 1 待登记/);

    page.chip('设计评审').click();
    await tick();
    assert.match(page.text(), /评审排期/);
    assert.doesNotMatch(page.text(), /商品标题规则|周报模板/);
    assert.match(page.text(), /评审会改到周四/);
    assert.doesNotMatch(page.text(), /能不能把标题加长/, 'misses are filtered by group too');
    assert.equal(page.posts.at(-1).target.endsWith('/layout'), true);
    assert.equal(page.posts.at(-1).body.group, 'group:beta');
    assert.equal(state.board.layouts.owner.group, 'group:beta');

    const reopened = await open(web, `/a/${state.board.ownerToken}`);
    assert.ok(reopened.chip('设计评审').classList.contains('on'), 'remembered');
    assert.doesNotMatch(reopened.text(), /商品标题规则/);
    reopened.chip('全部').click();
    await tick();
    assert.match(reopened.text(), /商品标题规则/);
    assert.equal(state.board.layouts.owner.group, '');
    page.close(); reopened.close();
  } finally { await web.close(); }
});

test('web board: group-by-project headers and the share list use names, and names are resolved when the page is rendered', async () => {
  const state = fixture();
  const share = createShare(state, { name: '外包同事', projects: [RAW, 'group:gamma'], onlyMine: true, requesterId: 'u1' });
  state.board.layouts.owner = normalizeLayout({ groupBy: 'project' });
  const web = await serve(state);
  try {
    let page = await open(web, `/a/${state.board.ownerToken}`);
    assert.deepEqual(page.headings().map((t) => t.replace(/ · \d+$/, '')).sort(), ['需求对齐群', '设计评审', '运营周会'].sort());
    assert.doesNotMatch(page.text(), /group:/);
    const line = [...page.doc.querySelectorAll('.miss')].find((el) => el.textContent.includes('外包同事'));
    assert.match(line.textContent, /需求对齐群、运营周会/);
    assert.match(line.textContent, /只看 张三/);
    page.close();
    state.autoNames.groups[RAW_ID] = '改名后的群';
    page = await open(web, `/a/${state.board.ownerToken}`);
    assert.match(page.text(), /改名后的群/);
    assert.doesNotMatch(page.text(), /需求对齐群/);
    assert.equal(share.projects.length, 2);
    page.close();
  } finally { await web.close(); }
});

test('web board: the share editor picks groups by name with checkboxes and posts their ids', async () => {
  const state = fixture();
  const web = await serve(state);
  try {
    const page = await open(web, `/a/${state.board.ownerToken}`);
    const boxes = [...page.doc.querySelectorAll('.picks input[type=checkbox]')];
    assert.ok(boxes.length >= 3);
    const labelOf = (box) => box.parentElement.textContent.trim();
    assert.ok(boxes.some((box) => labelOf(box) === '需求对齐群' && box.value === RAW));
    assert.equal(page.doc.querySelector('input[placeholder*="chatKey"]'), null, 'no free-text chatKey field any more');
    boxes.find((box) => labelOf(box) === '设计评审').checked = true;
    boxes.find((box) => labelOf(box) === '运营周会').checked = true;
    const options = [...page.doc.querySelectorAll('#shares select option')].map((o) => o.textContent);
    assert.ok(options.some((text) => text.includes('张三')));
    page.doc.querySelector('#shares input[placeholder]').value = '新同事';
    page.doc.querySelector('#shares form').dispatchEvent(new page.dom.window.Event('submit', { cancelable: true }));
    await tick(80);
    const sent = page.posts.find((p) => p.target.endsWith('/shares'));
    assert.deepEqual(sent.body.projects.sort(), ['group:beta', 'group:gamma']);
    assert.equal(sent.body.onlyMine, false);
    assert.equal(state.board.shares.at(-1).name, '新同事');
    assert.deepEqual(state.board.shares.at(-1).projects.sort(), ['group:beta', 'group:gamma']);
    page.close();
  } finally { await web.close(); }
});

test('web board: a share sees only the groups (and names) in its scope; /api leaks nothing else', async () => {
  const state = fixture();
  const share = createShare(state, { name: '只看两个群', projects: [RAW, 'group:gamma'] });
  const solo = createShare(state, { name: '只看一个群', projects: ['group:gamma'] });
  const web = await serve(state);
  try {
    const page = await open(web, `/s/${share.token}`);
    assert.deepEqual(page.chips().map((el) => el.textContent.replace(/\s+\S+$/, '')).sort(), ['需求对齐群', '全部', '运营周会'].sort());
    for (const leak of ['设计评审', 'group:beta', '评审排期', '评审会改到周四', '张三（私聊）']) assert.ok(!page.html.includes(leak), `share page must not contain ${leak}`);
    assert.doesNotMatch(page.text(), /可能还没登记/);
    assert.equal(page.doc.querySelector('.picks'), null, 'share has no editor');
    page.chip('运营周会').click();
    await tick();
    assert.equal(state.board.layouts[share.id].group, 'group:gamma');
    // 想把布局停在范围外的群上也不行
    const forged = await web.post(`/s/${share.token}/layout`, { group: 'group:beta' });
    assert.equal(forged.body.layout.group, '');
    const api = await web.get(`/s/${share.token}/api`);
    for (const leak of ['设计评审', 'group:beta']) assert.ok(!api.text.includes(leak));
    const parsed = JSON.parse(api.text);
    assert.equal(parsed.directory, null);
    assert.deepEqual(parsed.misses, []);
    // 只有一个群的链接不显示群切换条，也不会把别的群名带进页面
    const one = await web.get(`/s/${solo.token}`);
    assert.ok(!one.text.includes('需求对齐群') && !one.text.includes('设计评审'));
    page.close();
  } finally { await web.close(); }
});

test('sidebar 看板 tab: group names, per-group switcher remembered in the layout, shares by names', async () => {
  const state = fixture();
  createShare(state, { name: '外包同事', projects: [RAW] });
  const html = await readFile(new URL('../plugin/panel.html', import.meta.url), 'utf8');
  const calls = [];
  const view = () => ({ ...panelView(state, { status: 'online', botId: 'bot-1', detail: '' }, null, new Map()), nameSync: { status: 'ready', detail: '' } });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.enso = Object.freeze({
        theme: 'dark',
        onTheme() {},
        on() {},
        async call(method, args = {}) {
          calls.push({ method, args });
          if (method === 'setBoardGroup') saveLayout(state, { kind: 'owner', id: 'owner' }, { ...state.board.layouts.owner, group: args.group });
          return view();
        },
      });
    },
  });
  try {
    await tick(50);
    const doc = dom.window.document;
    doc.querySelector('[data-act="tab"][data-tab="board"]').click();
    await tick();
    const text = () => visibleText(doc);
    assert.doesNotMatch(text(), /group:|wrFAKE00/, 'sidebar shows names, not ids');
    assert.match(text(), /需求对齐群/);
    assert.match(text(), /外包同事.*需求对齐群/);
    const pills = [...doc.querySelectorAll('[data-act="setBoardGroup"]')];
    assert.equal(pills.length, 4);
    assert.match(pills.find((el) => el.textContent.includes('需求对齐群')).textContent, /2\+1/);
    pills.find((el) => el.textContent.includes('设计评审')).click();
    await tick(50);
    assert.deepEqual(calls.filter((c) => c.method === 'setBoardGroup').map((c) => ({ ...c.args })), [{ group: 'group:beta' }]);
    assert.match(text(), /评审排期/);
    assert.doesNotMatch(text(), /商品标题规则|能不能把标题加长/);
    assert.match(text(), /评审会改到周四/);
    assert.equal(doc.querySelector('[data-act="setBoardGroup"].on').textContent.includes('设计评审'), true);
    [...doc.querySelectorAll('[data-act="setBoardGroup"]')].find((el) => el.textContent.includes('全部')).click();
    await tick(50);
    assert.match(text(), /商品标题规则/);
    assert.equal(state.board.layouts.owner.group, '');
  } finally { dom.window.close(); }
});
