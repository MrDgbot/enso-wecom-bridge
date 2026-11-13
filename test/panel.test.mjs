// sidebar: 本会话 / 聊天 / 任务 / 设置 / 看板 fed by panelView(), with safety gates.
//
// DOM hooks this suite relies on (everything else is matched by visible text):
//   #top, #conn, [data-act="tab"][data-tab], #current, #outbound-status, #outbound-section,
//   #picker-q, #chat-q, #task-q, input.edit, textarea[data-doc-links], [data-doc-scope],
//   [data-act=...] buttons whose data-* attribute values carry the chatKey / userid / sessionId / mode they act on.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { test } from 'node:test';
import * as core from '../src/core.mjs';
import { grantBrowserDocuments } from '../src/browser-document.mjs';
import { rootSessionId, setOutboundMode } from '../src/outbound.mjs';

const { bind, bindMember, emptyState, markInjected, markSendFailed, mergeSessionNames, receive, setListed, setMode, setName, settle, unbind } = core;
const panelPath = new URL('../plugin/panel.html', import.meta.url);
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// harness: the host side behaves exactly like src/main.mjs, but in memory
// ---------------------------------------------------------------------------

async function mountPanel(state, opts = {}) {
  assert.equal(typeof core.panelView, 'function', 'src/core.mjs must export panelView() — the sidebar is fed by it');
  const html = await readFile(panelPath, 'utf8');
  const h = {
    ctx: opts.ctx ?? { sessionId: 'S-alpha', projectRoot: '/work/alpha/app' },
    conn: opts.conn ?? { status: 'online', botId: 'bot-1', detail: '' },
    titles: opts.titles ?? new Map([['S-alpha', 'Alpha 会话']]),
    calls: [],
    listeners: new Map(),
    errors: [],
    themeCb: null,
  };
  const view = (ctx) => ({ ...core.panelView(state, { ...h.conn }, ctx, h.titles), nameSync: { status: 'ready', detail: '' } });
  const here = () => rootSessionId(h.ctx?.sessionId);
  const binding = (sessionId) => ({ sessionId, title: h.titles.get(sessionId) || '', projectRoot: h.ctx?.projectRoot ?? null, boundAt: Date.now() });
  let fresh = 0;
  const rpc = {
    snapshot() {},
    bind: (a) => bind(state, a.chatKey, binding(here())),
    bindNew(a) {
      const sid = `S-new-${++fresh}`;
      h.titles.set(sid, `新会话 ${fresh}`);
      bind(state, a.chatKey, binding(sid));
    },
    unbind: (a) => unbind(state, a.chatKey),
    bindMember: (a) => bindMember(state, a.chatKey, String(a.userid ?? ''), binding(here())),
    resetMember: (a) => bindMember(state, a.chatKey, String(a.userid ?? ''), null),
    setSameMessageReply(a) {
      const b = state.bindings[a.chatKey];
      if (!a.chatKey.startsWith('single:') || b?.sessionId !== here()) throw new Error('请在绑定的会话中设置私聊试用');
      b.sameMessageReply = a.enabled === true;
    },
    grantBrowserDocuments: (a) => grantBrowserDocuments(state, a.chatKey, here(), h.conn.botId, a.links, a.scope),
    rename: (a) => setName(state, String(a.id ?? ''), a.name),
    setMode: (a) => setMode(state, a.mode),
    setListed: (a) => setListed(state, a.list, String(a.userid ?? ''), a.on === true),
    setOutboundMode: (a) => setOutboundMode(state, a.mode),
    refreshNames() {},
    reconnect() {},
    focus: () => ({ ok: true }),
  };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.addEventListener('error', (e) => h.errors.push(e.message));
      const enso = {
        theme: 'dark',
        onTheme(fn) { h.themeCb = fn; },
        async call(method, args = {}) {
          h.calls.push({ method, args });
          if (!Object.hasOwn(rpc, method)) throw new Error(`unknown RPC ${method}`);
          const out = rpc[method](args ?? {});
          return method === 'focus' ? out : view(h.ctx);
        },
      };
      if (opts.withOn !== false) enso.on = (ev, fn) => h.listeners.set(ev, fn);
      window.enso = Object.freeze(enso);
    },
  });
  await tick(40);
  return {
    h,
    dom,
    window: dom.window,
    document: dom.window.document,
    calls: (method) => h.calls.filter((c) => c.method === method),
    /** Same as main.mjs pushView(): a sessionless snapshot (current === null). */
    push() { h.listeners.get('state')?.(view(null)); },
    close: () => dom.window.close(),
  };
}

// ---------------------------------------------------------------------------
// DOM helpers — visibility-aware so hidden tabs never satisfy an assertion
// ---------------------------------------------------------------------------

const hiddenEl = (n) => {
  const win = n.ownerDocument.defaultView;
  return n.hidden || n.getAttribute('aria-hidden') === 'true' || win.getComputedStyle(n).display === 'none';
};

function isShown(el) {
  if (!el) return false;
  let prev = null;
  for (let n = el; n && n.nodeType === 1; prev = n, n = n.parentElement) {
    if (hiddenEl(n)) return false;
    if (n.tagName === 'DETAILS' && !n.open && n !== el && prev?.tagName !== 'SUMMARY') return false;
  }
  return true;
}

function shownText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.nodeValue;
  if (node.nodeType !== 1 || ['SCRIPT', 'STYLE', 'TEMPLATE'].includes(node.tagName) || hiddenEl(node)) return '';
  const kids = [...node.childNodes];
  const visible = node.tagName === 'DETAILS' && !node.open ? kids.filter((k) => k.tagName === 'SUMMARY') : kids;
  return visible.map(shownText).join(' ');
}

const bodyText = (document) => shownText(document.body);
const dataHas = (el, values) => values.every((v) => Object.values(el.dataset).includes(v));

function find(root, act, { has = [], text, not } = {}) {
  return [...root.querySelectorAll(`[data-act="${act}"]`)].find((el) =>
    isShown(el) && dataHas(el, has) && (!text || text.test(el.textContent.trim())) && (!not || !not.test(el.textContent.trim()))) ?? null;
}

function must(root, act, opts = {}) {
  const el = find(root, act, opts);
  assert.ok(el, `expected a visible [data-act="${act}"] ${JSON.stringify({ has: opts.has, text: opts.text?.source })}`);
  return el;
}

async function press(root, act, opts) {
  must(root, act, opts).click();
  await tick();
}

/** Filter pills / segmented buttons are matched by their visible label. */
function pill(document, re) {
  const el = [...document.querySelectorAll('button, [role="button"], [role="tab"], [data-act]')]
    .find((b) => b.dataset.act !== 'tab' && isShown(b) && re.test(b.textContent.trim()));
  assert.ok(el, `expected a visible pill ${re}`);
  return el;
}

async function openTab(document, name) {
  const t = document.querySelector(`[data-act="tab"][data-tab="${name}"]`);
  assert.ok(t, `tab ${name}`);
  t.click();
  await tick();
}

async function type(window, el, value) {
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick();
}

/** Opens the per-chat settings of a routed row on 本会话 (if it is collapsible at all). */
async function expandRoute(document, chatKey) {
  const toggle = [...document.querySelectorAll('[data-act="expand"]')].find((el) => isShown(el) && dataHas(el, [chatKey]));
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {
    toggle.click();
    await tick();
    return;
  }
  const holder = [...document.querySelectorAll('details')].find((d) => isShown(d) && d.querySelector(`[data-chat="${chatKey}"], [data-key="${chatKey}"]`));
  if (holder && !holder.open) {
    holder.open = true;
    holder.dispatchEvent(new document.defaultView.Event('toggle'));
    await tick();
  }
}

async function setDocScope(document, value) {
  const win = document.defaultView;
  const radio = [...document.querySelectorAll('input[data-doc-scope]')].find((r) => isShown(r) && r.value === value);
  const el = radio ?? [...document.querySelectorAll('select[data-doc-scope]')].find(isShown);
  assert.ok(el, 'expected a visible document scope control [data-doc-scope]');
  if (radio) radio.checked = true;
  else el.value = value;
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
  await tick();
}

const grantButton = (document) => find(document, 'grantDocs') ?? find(document, 'grantBrowserDocuments');
const distinctTasks = (document) => new Set([...bodyText(document).matchAll(/任务-(\d+)/g)].map((m) => m[1])).size;
const chat = (target, kind, extra = {}) => ({ kind, target, botId: 'bot-1', lastUserid: kind === 'single' ? target : extra.lastUserid, ...extra });

// ---------------------------------------------------------------------------
// top bar
// ---------------------------------------------------------------------------

test('top bar shows connection status, bot id and reconnect; tabs open on 本会话', async () => {
  const p = await mountPanel(emptyState());
  try {
    const { document } = p;
    assert.ok(document.querySelector('#top'), '#top bar renders');
    const conn = document.querySelector('#conn');
    assert.ok(conn, '#conn renders');
    assert.match(conn.textContent, /bot-1/);
    assert.match(conn.textContent, /在线|已连接/);
    const tabs = [...document.querySelectorAll('[data-act="tab"]')];
    assert.deepEqual(tabs.map((t) => t.dataset.tab), ['here', 'chats', 'tasks', 'settings', 'board']);
    assert.deepEqual(tabs.map((t) => t.textContent.replace(/\d+/g, '').trim()), ['本会话', '聊天', '任务', '设置', '看板']);
    assert.ok(isShown(document.querySelector('#current')), '本会话 is the default tab');
    await press(document, 'reconnect');
    assert.equal(p.calls('reconnect').length, 1);
    assert.deepEqual(p.h.errors, []);
  } finally { p.close(); }
});

test('disconnect banner explains the reason in Chinese and keeps the raw detail in a tooltip', async () => {
  const p = await mountPanel(emptyState(), { conn: { status: 'offline', botId: 'bot-1', detail: 'New connection established, server disconnected this connection' } });
  const top = () => ['#top', '#conn'].map((q) => p.document.querySelector(q)?.textContent ?? '').join(' ');
  const titles = () => [...p.document.querySelectorAll('#top [title], #conn [title]')].map((el) => el.title).join(' ');
  try {
    assert.match(top(), /踢下线/);
    assert.doesNotMatch(top(), /New connection established/);
    assert.match(titles(), /New connection established/);

    p.h.conn = { status: 'offline', botId: 'bot-1', detail: 'WebSocket closed (code: 1006)' };
    p.push();
    await tick();
    assert.match(top(), /1006/);
    assert.match(top(), /异常|自动重连/);

    p.h.conn = { status: 'error', botId: 'bot-1', detail: 'auth failed errcode=853000' };
    p.push();
    await tick();
    assert.match(top(), /Bot ID/);
    assert.match(top(), /Secret/);

    p.h.conn = { status: 'online', botId: 'bot-1', detail: '' };
    p.push();
    await tick();
    assert.doesNotMatch(top(), /踢下线|异常|Secret/);
  } finally { p.close(); }
});

// ---------------------------------------------------------------------------
// 本会话
// ---------------------------------------------------------------------------

test('本会话 hero shows the human session title, project, routed sources and outbound reach with a jump to 设置', async () => {
  const sid = '7f3c9a10-1111-2222-3333-444455556666';
  const s = emptyState();
  s.chats['single:u'] = chat('u', 'single');
  s.chats['group:g'] = chat('g', 'group', { lastUserid: 'li' });
  s.names = { u: '赵六', g: '研发群' };
  bind(s, 'single:u', { sessionId: sid, title: '', projectRoot: '/work/demo', boundAt: 1 });
  bind(s, 'group:g', { sessionId: sid, title: '', projectRoot: '/work/demo', boundAt: 1 });
  const p = await mountPanel(s, { ctx: { sessionId: sid, projectRoot: '/work/demo' }, titles: new Map([[sid, '迭代 修复会话']]) });
  try {
    const { document } = p;
    const hero = document.querySelector('#current').textContent;
    assert.match(hero, /迭代 修复会话/);
    assert.ok(!hero.includes(sid), 'never shows the raw session UUID when a title is known');
    assert.match(hero, /demo/, 'project chip');
    assert.match(hero, /2/, 'count of routed WeCom sources');
    const here = bodyText(document);
    assert.match(here, /赵六/);
    assert.match(here, /研发群/);

    const status = document.querySelector('#outbound-status');
    assert.ok(status, '#outbound-status renders');
    const jump = status.querySelector('[data-act="tab"][data-tab="settings"]');
    assert.ok(jump, 'restricted reach offers a one-click jump to 设置');
    jump.click();
    await tick();
    assert.ok(isShown(document.querySelector('#outbound-section')), '设置 tab with 主动外发范围 is now visible');
  } finally { p.close(); }
});

test('本会话 rows: same-message reply switch only for private chats; browser docs need a 1-to-1 session', async () => {
  const s = emptyState();
  s.chats['single:u'] = chat('u', 'single');
  s.chats['group:g'] = chat('g', 'group', { lastUserid: 'u' });
  bind(s, 'single:u', { sessionId: 'S-alpha', projectRoot: '/work/alpha/app' });
  bind(s, 'group:g', { sessionId: 'S-alpha', projectRoot: '/work/alpha/app' });
  const p = await mountPanel(s);
  try {
    const { document } = p;
    await expandRoute(document, 'single:u');
    await expandRoute(document, 'group:g');
    const switches = [...document.querySelectorAll('[data-act="setSameMessageReply"]')].filter(isShown);
    assert.equal(switches.length, 1, 'never offered for group chats');
    assert.ok(dataHas(switches[0], ['single:u']));
    switches[0].click();
    await tick();
    assert.equal(s.bindings['single:u'].sameMessageReply, true);
    await expandRoute(document, 'single:u');
    await press(document, 'setSameMessageReply', { has: ['single:u'] });
    assert.equal(s.bindings['single:u'].sameMessageReply, false);
    assert.equal(s.bindings['group:g'].sameMessageReply, undefined);

    assert.equal(grantButton(document), null, 'two chats share this session: no doc grant');
    assert.match(bodyText(document), /一对一|1\s*对\s*1|只绑定一个|独立会话/, 'explains why docs are unavailable');
  } finally { p.close(); }
});

test('本会话 docs grant: draft survives pushes, grant saves, revoke is a two-step confirm', async () => {
  const s = emptyState();
  s.chats['single:u'] = chat('u', 'single');
  bind(s, 'single:u', { sessionId: 'S-alpha', projectRoot: '/work/alpha/app' });
  const p = await mountPanel(s);
  try {
    const { document, window } = p;
    await expandRoute(document, 'single:u');
    await setDocScope(document, 'listed');
    const area = document.querySelector('textarea[data-doc-links]');
    assert.ok(isShown(area), 'doc links editor visible');
    await type(window, area, 'https://doc.weixin.qq.com/sheet/demo');
    p.push();
    await tick(40);
    assert.equal(document.querySelector('textarea[data-doc-links]')?.value, 'https://doc.weixin.qq.com/sheet/demo', 'push does not wipe the draft');

    const grant = grantButton(document);
    assert.ok(grant, 'grant control visible');
    grant.click();
    await tick();
    assert.deepEqual(s.bindings['single:u'].browserDocuments.paths, ['/sheet/demo']);
    assert.equal(s.bindings['single:u'].browserDocuments.scope, 'listed');

    await expandRoute(document, 'single:u');
    const label = must(document, 'revokeDocs').textContent;
    await press(document, 'revokeDocs');
    assert.deepEqual(s.bindings['single:u'].browserDocuments.paths, ['/sheet/demo'], 'first click only arms');
    assert.notEqual(must(document, 'revokeDocs').textContent, label, 'armed button asks for confirmation');
    await press(document, 'revokeDocs');
    const after = s.bindings['single:u'].browserDocuments;
    assert.ok(!after?.paths?.length && after?.scope !== 'all', 'second click revokes');
  } finally { p.close(); }
});

test('本会话 断开 is a two-step confirm and never offers a fake undo', async () => {
  const s = emptyState();
  s.chats['single:u'] = chat('u', 'single');
  bind(s, 'single:u', { sessionId: 'S-alpha', projectRoot: '/work/alpha/app' });
  const p = await mountPanel(s);
  try {
    const { document } = p;
    const label = must(document, 'unbind', { has: ['single:u'] }).textContent.trim();
    assert.match(label, /断开/);
    await press(document, 'unbind', { has: ['single:u'] });
    assert.equal(s.bindings['single:u'].sessionId, 'S-alpha', 'first click only arms');
    assert.equal(p.calls('unbind').length, 0);
    assert.notEqual(must(document, 'unbind', { has: ['single:u'] }).textContent.trim(), label);
    await press(document, 'unbind', { has: ['single:u'] });
    assert.equal(s.bindings['single:u'], undefined);
    assert.doesNotMatch(bodyText(document), /撤销断开|撤销解绑|undo/i);
  } finally { p.close(); }
});

test('an armed confirm disarms by itself after 4 seconds', async () => {
  const s = emptyState();
  s.chats['single:u'] = chat('u', 'single');
  bind(s, 'single:u', { sessionId: 'S-alpha', projectRoot: '/work/alpha/app' });
  const p = await mountPanel(s);
  try {
    const { document } = p;
    const label = must(document, 'unbind', { has: ['single:u'] }).textContent.trim();
    await press(document, 'unbind', { has: ['single:u'] });
    await tick(4300);
    assert.equal(must(document, 'unbind', { has: ['single:u'] }).textContent.trim(), label, 'label restored');
    await press(document, 'unbind', { has: ['single:u'] });
    assert.equal(s.bindings['single:u']?.sessionId, 'S-alpha', 'a click after disarm only re-arms');
  } finally { p.close(); }
});

function catalogState() {
  const s = emptyState();
  s.chats['single:u1'] = chat('u1', 'single', { lastText: 'hello', lastAt: 10 });
  s.chats['group:g1'] = chat('g1', 'group', { lastUserid: 'li', userids: ['li', 'zhang'], lastText: 'ping', lastAt: 20 });
  s.names = { u1: '赵六', g1: '需求对齐群', li: '李四', zhang: '张三' };
  bind(s, 'single:u1', { sessionId: 'S-old', title: '迭代 旧会话', projectRoot: '/work/demo', boundAt: 1 });
  bind(s, 'group:g1', { sessionId: 'S-group', title: '迭代 群默认', projectRoot: '/work/demo', boundAt: 2 });
  mergeSessionNames(s, 'bot-1', [{ chat_type: 'group', chat_id: 'g9', chat_name: '新发现群' }], 30);
  return s;
}

test('本会话 picker: searchable, lists discovered and other-project chats plus members; fresh bind is one click, stealing confirms', async () => {
  const s = catalogState();
  const p = await mountPanel(s, { ctx: { sessionId: 'S-wecom', projectRoot: '/work/wecom-cli' }, titles: new Map([['S-wecom', 'WeCom CLI 会话']]) });
  try {
    const { document, window } = p;
    await press(document, 'picker');
    const q = document.querySelector('#picker-q');
    assert.ok(isShown(q), 'picker search box');
    const listed = bodyText(document);
    for (const name of ['新发现群', '赵六', '需求对齐群', '李四']) assert.match(listed, new RegExp(name));

    await type(window, q, '新发现');
    assert.match(bodyText(document), /新发现群/);
    assert.doesNotMatch(bodyText(document), /赵六/, 'search narrows the picker');

    await press(document, 'bind', { has: ['group:g9'] });
    assert.equal(s.bindings['group:g9']?.sessionId, 'S-wecom', 'a chat nobody has @-ed yet binds in one click');
    assert.equal(s.bindings['group:g9'].projectRoot, '/work/wecom-cli');

    if (!isShown(document.querySelector('#picker-q'))) await press(document, 'picker');
    await type(window, document.querySelector('#picker-q'), '');
    await press(document, 'bindMember', { has: ['group:g1', 'li'] });
    assert.equal(s.memberBindings['group:g1'].li.sessionId, 'S-wecom');
    assert.equal(s.bindings['group:g1'].sessionId, 'S-group', 'group default untouched');

    const here = bodyText(document);
    assert.match(here, /新发现群/);
    assert.match(here, /李四/);
    const reset = must(document, 'resetMember', { has: ['group:g1', 'li'] });
    assert.match(reset.textContent, /恢复群默认/);
    await press(document, 'resetMember', { has: ['group:g1', 'li'] });
    assert.equal(s.memberBindings['group:g1'].li?.sessionId, 'S-wecom', 'first click only arms (pending member tasks would fail)');
    await press(document, 'resetMember', { has: ['group:g1', 'li'] });
    assert.equal(s.memberBindings['group:g1'].li, undefined);

    if (!isShown(document.querySelector('#picker-q'))) await press(document, 'picker');
    await press(document, 'bind', { has: ['single:u1'] });
    assert.equal(s.bindings['single:u1'].sessionId, 'S-old', 'taking a chat from another session first arms');
    await press(document, 'bind', { has: ['single:u1'] });
    assert.equal(s.bindings['single:u1'].sessionId, 'S-wecom');
  } finally { p.close(); }
});

test('本会话 group name replaces the fallback when automatic name sync pushes an update', async () => {
  const s = emptyState();
  s.chats['group:g'] = chat('g', 'group', { lastUserid: 'u' });
  bind(s, 'group:g', { sessionId: 'S-alpha', projectRoot: '/work/alpha/app' });
  const p = await mountPanel(s);
  try {
    assert.match(bodyText(p.document), /群名未获取 g/);
    mergeSessionNames(s, 'bot-1', [{ chat_type: 'group', chat_id: 'g', chat_name: '需求对齐群' }], 100);
    p.push();
    await tick(40);
    assert.match(bodyText(p.document), /需求对齐群/);
    assert.doesNotMatch(bodyText(p.document), /群名未获取/);
    assert.equal(s.names.g, undefined, 'automatic names are not stored as remarks');
  } finally { p.close(); }
});

// ---------------------------------------------------------------------------
// 聊天
// ---------------------------------------------------------------------------

test('聊天 shows every chat immediately in a brand-new workspace, marks discovered ones, and filters by pill or search', async () => {
  const s = catalogState();
  const p = await mountPanel(s, { ctx: { sessionId: 'S-blank', projectRoot: '/work/brand-new' }, titles: new Map() });
  try {
    const { document, window } = p;
    await openTab(document, 'chats');
    let text = bodyText(document);
    for (const name of ['赵六', '需求对齐群', '新发现群']) assert.match(text, new RegExp(name), `${name} visible without touching filters`);
    assert.equal(text.match(/来自最近会话/g)?.length, 1, 'only the autoNames-discovered chat carries the origin badge');

    pill(document, /^未接入/).click();
    await tick();
    text = bodyText(document);
    assert.match(text, /新发现群/);
    assert.doesNotMatch(text, /赵六/);

    pill(document, /^brand-new/).click();
    await tick();
    assert.doesNotMatch(bodyText(document), /赵六|新发现群/, 'project pill narrows to this workspace');

    pill(document, /^全部/).click();
    await tick();
    await type(window, document.querySelector('#chat-q'), '赵六');
    text = bodyText(document);
    assert.match(text, /赵六/);
    assert.doesNotMatch(text, /新发现群/);
  } finally { p.close(); }
});

test('聊天 card actions: rename keeps its draft, jump to target session, rebind, new session, two-step 断开', async () => {
  const s = catalogState();
  const p = await mountPanel(s);
  try {
    const { document, window } = p;
    await openTab(document, 'chats');

    await press(document, 'startRename', { has: ['u1'] });
    assert.equal(document.querySelectorAll('input.edit').length, 1);
    await type(window, document.querySelector('input.edit'), '赵总');
    p.push();
    await tick(40);
    assert.equal(document.querySelector('input.edit')?.value, '赵总', 'state push keeps the draft');
    document.querySelector('input.edit').dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
    document.querySelector('input.edit').dispatchEvent(new window.FocusEvent('blur'));
    await tick();
    assert.equal(document.querySelector('input.edit')?.value, '赵总', 'blur alone does not discard');
    document.querySelector('input.edit').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    assert.equal(document.querySelector('input.edit'), null, 'Escape cancels');
    assert.equal(s.names.u1, '赵六');
    await press(document, 'startRename', { has: ['u1'] });
    await type(window, document.querySelector('input.edit'), '赵总');
    document.querySelector('input.edit').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    assert.equal(s.names.u1, '赵总', 'Enter saves');
    assert.equal(document.querySelector('input.edit'), null);

    await press(document, 'focus', { has: ['S-old'] });
    assert.deepEqual(p.calls('focus').map((c) => c.args.sessionId), ['S-old']);

    assert.match(must(document, 'bind', { has: ['single:u1'] }).textContent, /改接到本会话/);
    assert.match(must(document, 'bind', { has: ['group:g9'] }).textContent.trim(), /^接到本会话/);
    await press(document, 'bindNew', { has: ['group:g9'] });
    assert.equal(s.bindings['group:g9']?.sessionId, 'S-new-1');

    await press(document, 'unbind', { has: ['group:g1'] });
    assert.equal(s.bindings['group:g1']?.sessionId, 'S-group', 'first click only arms');
    await press(document, 'unbind', { has: ['group:g1'] });
    assert.equal(s.bindings['group:g1'], undefined);
  } finally { p.close(); }
});

test('聊天 按成员分流 routes one group member here and restores the group default with confirm', async () => {
  const s = catalogState();
  const p = await mountPanel(s);
  try {
    const { document } = p;
    await openTab(document, 'chats');
    if (!find(document, 'bindMember', { has: ['group:g1', 'li'] })) {
      const opener = [...document.querySelectorAll('summary, button, [data-act]')]
        .find((el) => isShown(el) && /按成员分流/.test(el.textContent) && el.children.length < 4);
      assert.ok(opener, '按成员分流 section toggle');
      if (opener.tagName === 'SUMMARY') {
        opener.parentElement.open = true;
        opener.parentElement.dispatchEvent(new document.defaultView.Event('toggle'));
      } else opener.click();
      await tick();
    }
    await press(document, 'bindMember', { has: ['group:g1', 'li'] });
    assert.equal(s.memberBindings['group:g1'].li.sessionId, 'S-alpha');
    assert.equal(s.memberBindings['group:g1'].zhang, undefined);
    await press(document, 'resetMember', { has: ['group:g1', 'li'] });
    assert.equal(s.memberBindings['group:g1'].li?.sessionId, 'S-alpha', 'first click only arms');
    await press(document, 'resetMember', { has: ['group:g1', 'li'] });
    assert.equal(s.memberBindings['group:g1'].li, undefined);
  } finally { p.close(); }
});

test('聊天 automatic names render as text, never as markup', async () => {
  const s = emptyState();
  s.chats['single:u1'] = chat('u1', 'single', { lastAt: 1 });
  mergeSessionNames(s, 'bot-1', [{ chat_type: 'single', chat_id: 'u1', chat_name: 'Bob（测试成员）<img src=x>' }], 10);
  const p = await mountPanel(s);
  try {
    await openTab(p.document, 'chats');
    assert.match(bodyText(p.document), /Bob（测试成员）<img src=x>/);
    assert.equal(p.document.querySelector('img'), null);
  } finally { p.close(); }
});

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

function manyTasks() {
  const s = emptyState();
  bind(s, 'single:u', { sessionId: 'S-alpha', title: 'Alpha', projectRoot: '/work/alpha/app', boundAt: 1 });
  for (let i = 0; i < 22; i++) {
    const text = i === 21 ? `任务-21 ${'很长的描述'.repeat(60)}` : `任务-${i}`;
    receive(s, { msgid: `m-${i}`, chattype: 'single', from: { userid: 'u' }, msgtype: 'text', text: { content: text } }, { now: i + 1, botId: 'bot-1' });
  }
  s.chats['single:u'].lastText = 'hello';
  Object.assign(s.tasks.find((t) => t.id === 'm-20'), { status: 'replied', reply: '接口正常，无需改动。' });
  return s;
}

test('任务 pages 8 at a time, expands long text, previews the stored reply and jumps to the session', async () => {
  const s = manyTasks();
  const p = await mountPanel(s);
  try {
    const { document, window } = p;
    await openTab(document, 'tasks');
    assert.equal(distinctTasks(document), 8);
    await press(document, 'moreTasks');
    assert.equal(distinctTasks(document), 16);

    const expand = must(document, 'expand');
    const before = expand.textContent.trim();
    expand.click();
    await tick();
    assert.notEqual(must(document, 'expand').textContent.trim(), before, 'toggle flips to 收起');

    assert.match(bodyText(document), /接口正常，无需改动。/);
    await press(document, 'focus', { has: ['S-alpha'] });
    assert.deepEqual(p.calls('focus').map((c) => c.args.sessionId), ['S-alpha']);

    await type(window, document.querySelector('#task-q'), '任务-3');
    assert.equal(distinctTasks(document), 1);
  } finally { p.close(); }
});

test('任务 filter pills split active, needs-attention (incl. reply not delivered) and replied', async () => {
  const s = emptyState();
  bind(s, 'single:u', { sessionId: 'S-alpha', title: 'Alpha', projectRoot: '/work/alpha/app', boundAt: 1 });
  const send = (id, text) => receive(s, { msgid: id, chattype: 'single', from: { userid: 'u' }, msgtype: 'text', text: { content: text } }, { now: Number(id.slice(1)), botId: 'bot-1' });
  send('m1', '任务-1');
  markInjected(s, 'm1', 1);
  settle(s, 'S-alpha', '已完成', 2);
  send('m2', '任务-2');
  markInjected(s, 'm2', 2);
  settle(s, 'S-alpha', '也完成', 3);
  markSendFailed(s, ['m2'], 'errcode=93000');
  send('m3', '任务-3');
  s.access.block.push('u');
  send('m4', '任务-4');
  s.access.block = [];
  const p = await mountPanel(s);
  const shown = () => [...new Set([...bodyText(p.document).matchAll(/任务-(\d)/g)].map((m) => m[1]))].sort().join(',');
  try {
    await openTab(p.document, 'tasks');
    assert.equal(shown(), '1,2,3,4');
    pill(p.document, /^进行中/).click();
    await tick();
    assert.equal(shown(), '3');
    pill(p.document, /^需处理/).click();
    await tick();
    assert.equal(shown(), '2,4');
    assert.match(bodyText(p.document), /93000|发送失败|未送达|没发出去/);
    pill(p.document, /^已回复/).click();
    await tick();
    assert.equal(shown(), '1');
    pill(p.document, /^全部/).click();
    await tick();
    assert.equal(shown(), '1,2,3,4');
  } finally { p.close(); }
});

test('任务 attention rows carry the one-click fix: bind chat, unblock sender, allow sender', async () => {
  const s = { ...emptyState(), access: { mode: 'allowlist', allow: ['alice'], block: ['eve'] } };
  const send = (id, userid) => receive(s, { msgid: id, chattype: 'single', from: { userid }, msgtype: 'text', text: { content: `任务-${id}` } }, { now: 1, botId: 'bot-1' });
  send('1', 'alice');
  send('2', 'eve');
  send('3', 'mallory');
  const p = await mountPanel(s);
  try {
    const { document } = p;
    await openTab(document, 'tasks');
    await press(document, 'bind', { has: ['single:alice'], text: /接到本会话/ });
    assert.equal(s.bindings['single:alice']?.sessionId, 'S-alpha');

    await press(document, 'setListed', { has: ['eve'], text: /解除拉黑/ });
    assert.deepEqual(s.access.block, []);

    await press(document, 'setListed', { has: ['mallory'], text: /加入允许/ });
    assert.ok(s.access.allow.includes('mallory'));
    assert.equal(p.calls('setCanAssign').length, 0);
  } finally { p.close(); }
});

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

test('设置 谁能派活: block wins in both modes, allow and block lists stay independent, 拉黑 confirms', async () => {
  const s = emptyState();
  for (const u of ['u1', 'u2']) receive(s, { msgid: u, chattype: 'single', from: { userid: u }, msgtype: 'text', text: { content: 'hi' } }, { now: 1, botId: 'bot-1' });
  s.names = { u1: '甲', u2: '乙' };
  const p = await mountPanel(s);
  const blockBtn = (u) => ({ has: [u], text: /拉黑/, not: /解除/ });
  const allowSwitch = (u) => [...p.document.querySelectorAll('[data-act="setListed"]')].find((el) => isShown(el) && dataHas(el, [u]) && !/拉黑/.test(el.textContent)) ?? null;
  try {
    const { document } = p;
    await openTab(document, 'settings');
    assert.ok(pill(document, /^所有人/));

    await press(document, 'setListed', blockBtn('u1'));
    assert.deepEqual(s.access.block, [], '拉黑 first click only arms');
    await press(document, 'setListed', blockBtn('u1'));
    assert.deepEqual(s.access.block, ['u1']);
    assert.match(bodyText(document), /已拉黑/);

    pill(document, /^只有我允许的人/).click();
    await tick();
    assert.equal(s.access.mode, 'allowlist');
    assert.equal(allowSwitch('u1'), null, 'a blocked person shows 解除拉黑, not an allow switch');
    const sw = allowSwitch('u2');
    assert.ok(sw, 'allow switch for u2');
    sw.click();
    await tick();
    assert.deepEqual(s.access.allow, ['u2']);

    await press(document, 'setListed', blockBtn('u2'));
    await press(document, 'setListed', blockBtn('u2'));
    assert.deepEqual(s.access.block, ['u1', 'u2']);
    assert.deepEqual(s.access.allow, ['u2'], 'blocking never silently drops the allow entry');

    await press(document, 'setListed', { has: ['u2'], text: /解除拉黑/ });
    assert.deepEqual(s.access.block, ['u1']);
    assert.deepEqual(s.access.allow, ['u2']);

    await press(document, 'refreshNames');
    assert.equal(p.calls('refreshNames').length, 1);
    assert.equal(p.calls('setCanAssign').length, 0, 'no setCanAssign RPC exists');
  } finally { p.close(); }
});

test('设置 主动外发范围 radio cards switch the policy without touching bindings', async () => {
  const s = emptyState();
  s.chats['group:g'] = chat('g', 'group', { lastUserid: 'li', lastAt: 1 });
  bind(s, 'group:g', { sessionId: 'S-group', title: 'Group', projectRoot: '/work/g' });
  const before = JSON.stringify(s.bindings);
  const p = await mountPanel(s, { ctx: { sessionId: 'S-local', projectRoot: '/work/local' } });
  try {
    const { document } = p;
    assert.match(document.querySelector('#outbound-status').textContent, /任意/);
    await openTab(document, 'settings');
    assert.ok(isShown(document.querySelector('#outbound-section')));
    for (const mode of ['local-sessions', 'all-sessions', 'bound-only']) must(document, 'setOutboundMode', { has: [mode] });
    await press(document, 'setOutboundMode', { has: ['bound-only'] });
    assert.equal(s.outbound.mode, 'bound-only');
    await openTab(document, 'here');
    assert.match(document.querySelector('#outbound-status').textContent, /已绑定/);
    await openTab(document, 'settings');
    await press(document, 'setOutboundMode', { has: ['all-sessions'] });
    assert.equal(s.outbound.mode, 'all-sessions');
    assert.equal(JSON.stringify(s.bindings), before);
  } finally { p.close(); }
});

// ---------------------------------------------------------------------------
// refresh paths
// ---------------------------------------------------------------------------

test('switching Enso sessions: a sessionless state push makes the panel re-fetch its snapshot', async () => {
  const s = emptyState();
  s.chats['single:u'] = chat('u', 'single');
  bind(s, 'single:u', { sessionId: 'S-alpha', title: 'Alpha 会话', projectRoot: '/work/alpha/app' });
  const titles = new Map([['S-alpha', 'Alpha 会话'], ['S-beta', 'Beta 会话']]);
  const p = await mountPanel(s, { titles });
  try {
    const { document } = p;
    assert.match(document.querySelector('#current').textContent, /Alpha 会话/);
    assert.match(document.querySelector('#outbound-status').textContent, /已接入企微|已绑定/);
    const before = p.calls('snapshot').length;
    p.h.ctx = { sessionId: 'S-beta', projectRoot: '/work/beta' };
    p.push();
    await tick(50);
    assert.ok(p.calls('snapshot').length > before, 'current === null in a push triggers snapshot');
    assert.match(document.querySelector('#current').textContent, /Beta 会话/);
    assert.doesNotMatch(document.querySelector('#current').textContent, /Alpha 会话/);
    assert.match(document.querySelector('#outbound-status').textContent, /任意/);
  } finally { p.close(); }
});

test('without enso.on the panel syncs theme, refreshes on visibility and every 4s, keeping open rows and doc drafts', async () => {
  const s = emptyState();
  s.chats['single:u'] = chat('u', 'single');
  bind(s, 'single:u', { sessionId: 'S-alpha', projectRoot: '/work/alpha/app' });
  const p = await mountPanel(s, { withOn: false });
  try {
    const { document, window } = p;
    assert.equal(typeof window.enso.on, 'undefined');
    assert.equal(document.documentElement.dataset.theme, 'dark');
    p.h.themeCb?.('light');
    assert.equal(document.documentElement.dataset.theme, 'light');

    await expandRoute(document, 'single:u');
    await setDocScope(document, 'listed');
    await type(window, document.querySelector('textarea[data-doc-links]'), 'https://doc.weixin.qq.com/sheet/unsaved-draft');
    document.body.focus();

    p.h.titles.set('S-alpha', 'Alpha 改名一次');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
    await tick(50);
    assert.match(document.querySelector('#current').textContent, /Alpha 改名一次/);
    assert.ok(isShown(document.querySelector('textarea[data-doc-links]')), 'expanded row stays open');
    assert.equal(document.querySelector('textarea[data-doc-links]').value, 'https://doc.weixin.qq.com/sheet/unsaved-draft');

    p.h.titles.set('S-alpha', 'Alpha 改名两次');
    await tick(4300);
    assert.match(document.querySelector('#current').textContent, /Alpha 改名两次/, '4s polling refreshes');
    assert.equal(document.querySelector('textarea[data-doc-links]').value, 'https://doc.weixin.qq.com/sheet/unsaved-draft');
    assert.deepEqual(p.h.errors, []);
  } finally { p.close(); }
});
