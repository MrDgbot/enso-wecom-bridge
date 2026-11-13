import { createServer } from 'node:http';
import {
  authenticateBoard,
  createShare,
  layoutFor,
  logAccess,
  presentItem,
  publicShare,
  revokeShare,
  saveLayout,
  visibleItems,
  boardUpdate,
  STATUS_LABEL,
} from './board.mjs';
import { boardScope, namedAccessLog, namedItem, namedMiss, namedShare } from './core.mjs';
import { setGate, setOwnerUserid } from './gate.mjs';
import { applyReview, importMisses } from './review.mjs';

const MAX_BODY = 64 * 1024;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      }
      catch { reject(Object.assign(new Error('请求格式无效'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// 页面和 /api 共用同一份数据；名字都在这里按权限解析，分享链接拿不到范围外的群名和人名。
function boardPayload(state, auth, extras = {}) {
  const owner = auth.kind === 'owner';
  const scope = boardScope(state, auth);
  return {
    role: auth.role,
    kind: auth.kind,
    items: scope.items.map((item) => namedItem(state, item)),
    layout: layoutFor(state, auth),
    statuses: STATUS_LABEL,
    groups: scope.groups,
    gates: owner ? scope.gates : [],
    owner: owner ? scope.owner : null,
    directory: owner ? scope.directory : null,
    misses: owner ? (state.board.misses || []).map((miss) => namedMiss(state, miss)) : [],
    shares: owner ? state.board.shares.map((share) => namedShare(state, { ...publicShare(share), path: share.revoked ? '' : `/s/${share.token}` })) : [],
    projects: owner ? (extras.projects ?? []) : [],
    accessLog: owner ? namedAccessLog(state, state.board.accessLog.slice(-20)) : [],
  };
}

function page(auth, payload) {
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${auth.kind === 'owner' ? '需求看板管理' : '需求看板'}</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f1ea; --card:#fffdf8; --ink:#241c14; --line:#e4d8c8; --brand:#9a3412; --muted:#6b5c4d; }
  @media (prefers-color-scheme: dark) { :root { --bg:#1c1712; --card:#2a241c; --ink:#f6efe4; --line:#3d342a; --brand:#fdba74; --muted:#cbbba6; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 "Songti SC","Source Han Serif SC",serif; background:var(--bg); color:var(--ink); }
  header, main { width:min(1100px, calc(100% - 28px)); margin:0 auto; }
  header { padding:22px 0 8px; display:flex; gap:12px; flex-wrap:wrap; align-items:end; justify-content:space-between; }
  h1 { font-size:28px; margin:0; letter-spacing:.04em; }
  .sub { color:var(--muted); font:13px/1.4 "IBM Plex Sans","PingFang SC",sans-serif; }
  .bar, .card, .miss { background:var(--card); border:1px solid var(--line); border-radius:14px; }
  .bar { padding:10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:12px 0; }
  select, button, input { font:13px/1.2 "IBM Plex Sans","PingFang SC",sans-serif; }
  select, input { background:transparent; color:inherit; border:1px solid var(--line); border-radius:8px; padding:6px 8px; }
  button { background:var(--brand); color:#fff; border:0; border-radius:8px; padding:7px 10px; cursor:pointer; }
  button.ghost { background:transparent; color:inherit; border:1px solid var(--line); }
  .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; padding-bottom:32px; }
  .col h2 { font-size:14px; margin:0 0 8px; }
  .card { padding:12px; margin:0 0 10px; }
  .card h3 { margin:0 0 6px; font-size:16px; }
  .meta { color:var(--muted); font:12px/1.45 "IBM Plex Sans","PingFang SC",sans-serif; display:flex; gap:6px; flex-wrap:wrap; }
  .pill { border:1px solid var(--line); border-radius:999px; padding:1px 7px; }
  .warn { color:#9a3412; }
  .miss { padding:10px 12px; margin:8px 0; }
  .chips { display:flex; gap:6px; flex-wrap:wrap; margin:12px 0 0; }
  .chip { background:var(--card); color:inherit; border:1px solid var(--line); border-radius:999px; padding:5px 12px; }
  .chip.on { background:var(--brand); color:#fff; border-color:var(--brand); }
  .chip .n { opacity:.75; font-size:12px; }
  .banner { border:1px solid var(--brand); border-radius:12px; padding:8px 12px; margin:10px 0; background:var(--card); }
  .banner.soft { border-color:var(--line); }
  .review { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
  .pillw { color:#9a3412; border-color:#9a3412; }
  details.gate { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:8px 12px; margin:8px 0; }
  details.gate summary { cursor:pointer; }
  .picks { display:flex; gap:6px; flex-wrap:wrap; max-height:150px; overflow:auto; width:100%; }
  .pick { cursor:pointer; display:inline-flex; align-items:center; gap:3px; }
  details.sub { margin:6px 0 24px; }
  form.inline { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
  @media (max-width:640px) { h1 { font-size:22px; } header, main { width:min(100% - 16px, 1100px); } }
</style></head><body>
<header><div><h1>需求看板</h1><div class="sub">${auth.kind === 'owner' ? '所有者管理页。分享链接可以单独收回。' : (auth.role === 'decide' ? '你可以查看并拍板授权范围内的需求。' : '这个链接只能查看授权范围内的需求。')}</div></div></header>
<main>
  <div id="health"></div>
  <div class="chips" id="groups"></div>
  <div id="review"></div>
  <div class="bar" id="controls"></div>
  <div id="misses"></div>
  <div id="gates"></div>
  <div id="shares"></div>
  <div class="cols" id="board"></div>
</main>
<script>const DATA = ${data}; const base = location.pathname.replace(/\\/$/, '');
const $ = (id) => document.getElementById(id);
function h(tag, attrs, children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const child of children || []) el.append(child);
  return el;
}
function field(name) { return DATA.layout.fields.includes(name); }
// 记住的群不在当前范围里（链接范围收窄、群没有需求了）就当作“全部”。
function currentGroup() { const g = DATA.layout.group; return g && DATA.groups.some((x) => x.chatKey === g) ? g : ''; }
function inGroup(entry) { const g = currentGroup(); return !g || entry.chatKey === g; }
const ui = { onlyPending: false };
function canReview() { return DATA.role === 'owner' || DATA.role === 'decide'; }
function post(path, body) {
  return fetch(base + path, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body || {}) });
}
function pendingIn() { return DATA.items.filter((item) => item.status === 'pending_review' && inGroup(item)).length; }
function when(at) { return at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : ''; }
function sortItems(list) {
  const rank = { pending_review:-1, pending_decision:0, todo:1, doing:2, done:3, dropped:4 };
  return [...list].sort((a, b) => DATA.layout.sort === 'created' ? a.createdAt - b.createdAt : DATA.layout.sort === 'status' ? (rank[a.displayStatus] - rank[b.displayStatus]) || (b.updatedAt - a.updatedAt) : b.updatedAt - a.updatedAt);
}
function postLayout(layout) {
  return fetch(base + '/layout', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(layout) });
}
function pickGroup(chatKey) {
  DATA.layout = Object.assign({}, DATA.layout, { group: chatKey });
  renderGroups(); renderReview(); renderMisses(); renderGates(); renderBoard();
  postLayout(DATA.layout).catch(() => {});
}
function renderGroups() {
  const bar = $('groups');
  bar.replaceChildren();
  if (DATA.groups.length < 2) return;
  const total = DATA.groups.reduce((n, g) => n + g.count, 0);
  const chip = (key, text, count, tip) => h('button', { type:'button', class: 'chip' + (currentGroup() === key ? ' on' : ''), title: tip, onclick: () => pickGroup(key) }, [document.createTextNode(text + ' '), h('span', { class:'n', text: count })]);
  bar.append(chip('', '全部', String(total), '所有群'));
  for (const g of DATA.groups) bar.append(chip(g.chatKey, g.title, String(g.count) + (g.pending ? ' · ' + g.pending + ' 待审核' : '') + (g.misses ? ' · ' + g.misses + ' 待登记' : ''), g.chatKey));
}
function renderReview() {
  const root = $('review');
  root.replaceChildren();
  const n = pendingIn();
  if (!n && !ui.onlyPending) return;
  const text = (currentGroup() ? '这个群' : '当前范围') + '有 ' + n + ' 条需求待审核：审核人同意前只能澄清，不会开始做。';
  root.append(h('div', { class:'banner' }, [
    h('b', { text }),
    document.createTextNode(' '),
    h('button', { type:'button', class:'ghost', text: ui.onlyPending ? '看全部' : '只看待审核', onclick: () => { ui.onlyPending = !ui.onlyPending; renderReview(); renderBoard(); } }),
  ]));
}
function renderHealth() {
  const root = $('health');
  root.replaceChildren();
  if (DATA.kind !== 'owner') return;
  const bad = (DATA.gates || []).filter((g) => g.health);
  if (!bad.length) return;
  const box = h('div', { class:'banner' }, [h('b', { text:'这些群接的会话可能没有看板工具，需求登记不上来：' })]);
  for (const g of bad) box.append(h('div', { class:'sub', title: g.chatKey, text: g.title + '：' + g.health.text + (g.health.boundAt ? '（绑定于 ' + when(g.health.boundAt) + '）' : '') }));
  root.append(box);
}
function renderControls() {
  const bar = $('controls');
  bar.replaceChildren();
  const group = h('select', { id:'groupBy' }, []);
  for (const [value, label] of [['status','按状态'],['project','按群'],['requester','按提出人']]) {
    const opt = h('option', { value, text: label });
    if (DATA.layout.groupBy === value) opt.selected = true;
    group.append(opt);
  }
  const sort = h('select', { id:'sort' });
  for (const [value, label] of [['updated','最近更新'],['created','提出时间'],['status','状态']]) {
    const opt = h('option', { value, text: label });
    if (DATA.layout.sort === value) opt.selected = true;
    sort.append(opt);
  }
  bar.append(h('span', { class:'sub', text:'分组' }), group, h('span', { class:'sub', text:'排序' }), sort);
  for (const [value, label] of [['detail','详情'],['requester','提出人'],['waitingOn','待谁拍板'],['decision','结论'],['delivery','回复'],['source','来源'],['options','选项']]) {
    const box = h('input', { type:'checkbox', value });
    box.checked = field(value);
    bar.append(h('label', { class:'sub' }, [box, document.createTextNode(label)]));
  }
  const only = h('input', { type:'checkbox' });
  only.checked = ui.onlyPending;
  only.addEventListener('change', () => { ui.onlyPending = only.checked; renderReview(); renderBoard(); });
  bar.append(h('label', { class:'sub' }, [only, document.createTextNode('只看待审核')]));
  bar.append(h('button', { type:'button', text:'记住这个布局', onclick: saveLayout }));
}
function groupsOf(items) {
  const by = DATA.layout.groupBy;
  const keyOf = (item) => by === 'project' ? { key: item.chatKey, title: item.chatTitle, tip: item.chatKey } : by === 'requester' ? { key: item.requester?.id || item.requesterName, title: item.requesterName, tip: item.requester?.id || '' } : { key: item.displayStatus, title: item.statusLabel || item.displayStatus, tip: '' };
  const map = new Map();
  for (const item of items) {
    const k = keyOf(item);
    const entry = map.get(k.key) || { title: k.title, tip: k.tip, list: [] };
    entry.list.push(item);
    map.set(k.key, entry);
  }
  return [...map.values()];
}
function card(item) {
  const bits = [h('h3', { text: (item.no ? '#' + item.no + ' ' : '') + item.title })];
  const meta = [h('span', { class: item.status === 'pending_review' ? 'pill pillw' : 'pill', text: item.statusLabel })];
  if (!currentGroup() && DATA.layout.groupBy !== 'project') meta.push(h('span', { class:'pill', title: item.chatKey, text: item.chatTitle }));
  if (field('delivery')) meta.push(h('span', { class: item.replyOutstanding ? 'pill warn' : 'pill', text: item.deliveryLabel }));
  if (field('requester')) meta.push(h('span', { class:'pill', title: item.requester?.id || '', text: item.requesterName }));
  if (field('waitingOn') && item.waitingOn) meta.push(h('span', { class:'pill', text: '待 ' + item.waitingOn }));
  if (field('source')) meta.push(h('span', { class:'pill', text: item.source === 'local' ? '会话里提出' : '企微' }));
  bits.push(h('div', { class:'meta' }, meta));
  if (field('detail') && item.detail) bits.push(h('p', { text: item.detail }));
  if (field('options') && item.options?.length) bits.push(h('p', { class:'sub', text: '选项：' + item.options.map((o) => o.label).join(' / ') }));
  if (field('decision') && item.decision) bits.push(h('p', { text: '结论：' + item.decision + (item.decidedBy ? '（' + item.decidedBy + '）' : '') }));
  if (item.review === 'rejected' && item.decidedBy) bits.push(h('p', { class:'sub', text:'已被 ' + item.decidedBy + ' 驳回' }));
  if (canReview() && item.status === 'pending_review') {
    const reason = h('input', { placeholder:'驳回原因（可选）' });
    const act = (verdict) => async () => {
      const res = await post('/items/' + encodeURIComponent(item.id) + '/review', { verdict, reason: reason.value });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return alert(body.error || '没有处理成功');
      location.reload();
    };
    bits.push(h('div', { class:'review' }, [
      h('button', { type:'button', text:'同意，开始做', onclick: act('approve') }),
      reason,
      h('button', { type:'button', class:'ghost', text:'驳回', onclick: act('reject') }),
    ]));
  } else if (canReview()) {
    const status = h('select');
    for (const [value, label] of Object.entries(DATA.statuses)) if (value !== 'pending_review') status.append(h('option', { value, text: label }));
    status.value = item.displayStatus;
    const decision = h('input', { placeholder:'拍板结论', value: item.decision || '' });
    const save = h('button', { type:'button', class:'ghost', text:'保存', onclick: async () => {
      const res = await post('/items/' + encodeURIComponent(item.id), { status: status.value, decision: decision.value });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return alert(body.error || '没有改成');
      location.reload();
    }});
    bits.push(h('form', { class:'inline' }, [status, decision, save]));
  }
  return h('article', { class:'card' }, bits);
}
function renderBoard() {
  const root = $('board');
  root.replaceChildren();
  const shown = sortItems(DATA.items.filter(inGroup)).filter((item) => !ui.onlyPending || item.status === 'pending_review').filter((item) => DATA.layout.columns.includes(item.displayStatus) || DATA.layout.groupBy !== 'status');
  if (!shown.length) { root.append(h('p', { class:'sub', text: ui.onlyPending ? '没有待审核的需求。' : (currentGroup() ? '这个群里还没有需求。' : '这个范围内还没有需求。') })); return; }
  for (const entry of groupsOf(shown)) {
    root.append(h('section', { class:'col' }, [h('h2', { title: entry.tip, text: entry.title + ' · ' + entry.list.length }), ...sortItems(entry.list).map(card)]));
  }
}
async function saveLayout() {
  const fields = [...document.querySelectorAll('#controls input[type=checkbox]:checked')].map((el) => el.value);
  const layout = { groupBy: $('groupBy').value, group: currentGroup(), sort: $('sort').value, fields, columns: DATA.layout.columns };
  const res = await postLayout(layout);
  if (!res.ok) return alert('布局没有记住');
  DATA.layout = layout;
  renderGroups(); renderReview(); renderBoard();
}
function renderMisses() {
  const root = $('misses');
  root.replaceChildren();
  if (DATA.kind !== 'owner') return;
  const list = (DATA.misses || []).filter(inGroup);
  if (!list.length) return;
  const head = h('h2', { text:'可能还没登记 · ' + list.length });
  root.append(head);
  root.append(h('button', { type:'button', text:'补登记 ' + list.length + ' 条' + (currentGroup() ? '（只这个群）' : ''), onclick: async () => {
    const res = await post('/misses/import', { chatKey: currentGroup() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return alert(body.error || '没有补登记成功');
    alert('已补登记 ' + body.imported + ' 条' + (body.pending ? '，其中 ' + body.pending + ' 条待审核' : '') + (body.skipped ? '；跳过 ' + body.skipped + ' 条（已在看板上）' : ''));
    location.reload();
  }}));
  const byChat = new Map();
  for (const miss of list) byChat.set(miss.chatKey, [...(byChat.get(miss.chatKey) || []), miss]);
  for (const [chatKey, entries] of byChat) {
    if (!currentGroup()) root.append(h('div', { class:'sub', title: chatKey, text: entries[0].chatTitle + ' · ' + entries.length }));
    for (const miss of entries) root.append(h('div', { class:'miss' }, [h('b', { text: miss.text }), h('div', { class:'sub', title: '任务 ' + miss.taskId + ' · ' + chatKey, text: [miss.requesterName, when(miss.createdAt)].filter(Boolean).join(' · ') })]));
  }
}
const ACTION = { view:'查看', api:'读取', layout:'改布局', decide:'拍板', review:'审核', gate:'改审核设置', import:'补登记', share:'创建分享', revoke:'收回分享', denied:'被拒绝' };
function renderGates() {
  if (DATA.kind !== 'owner') return;
  const root = $('gates');
  root.replaceChildren();
  root.append(h('h2', { text:'需求审核人' }));
  const users = (DATA.directory && DATA.directory.users) || [];
  const nameOf = (id) => { const u = users.find((x) => x.id === id); return u ? u.name : id; };
  const mine = h('select');
  mine.append(h('option', { value:'', text:'还没设置' }));
  for (const u of users) { const o = h('option', { value: u.id, text: u.name }); if (DATA.owner && DATA.owner.id === u.id) o.selected = true; mine.append(o); }
  mine.addEventListener('change', async () => {
    const res = await post('/owner', { userid: mine.value });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return alert(body.error || '没有保存');
    location.reload();
  });
  root.append(h('div', { class: DATA.owner && DATA.owner.id ? 'sub' : 'banner' }, [
    document.createTextNode('我自己的企微账号（永远是审核人，我提的需求不用审核）：'), mine,
    h('div', { class:'sub', text: DATA.owner && DATA.owner.id ? '' : '还没设置：在这里选一下，否则你自己在群里提的需求也会待审核。' }),
  ]));
  const wanted = (DATA.gates || []).filter((g) => !currentGroup() || g.chatKey === currentGroup());
  if (!wanted.length) root.append(h('p', { class:'sub', text:'还没有群。' }));
  for (const g of wanted) {
    const summary = g.title + ' · 门槛' + (g.on ? '开' : '关') + ' · 审核人 ' + g.effective.map((p) => p.name).join('、') + (g.pending ? ' · ' + g.pending + ' 条待审核' : '');
    const box = h('details', { class:'gate', title: g.chatKey }, [h('summary', { text: summary })]);
    if (currentGroup() === g.chatKey || wanted.length === 1) box.setAttribute('open', '');
    if (g.health) box.append(h('div', { class:'banner', text: g.health.text }));
    const on = h('input', { type:'checkbox' });
    on.checked = g.on;
    box.append(h('label', { class:'sub' }, [on, document.createTextNode('开启审核门槛：非审核人提的需求先待审核，同意前只能澄清')]));
    const picks = h('div', { class:'picks' });
    const members = new Set(g.memberIds);
    const shown = new Set([...g.memberIds, ...g.reviewers]);
    const addPick = (id, checked) => {
      const box2 = h('input', { type:'checkbox', value: id });
      box2.checked = checked;
      if (DATA.owner && id === DATA.owner.id) { box2.checked = true; box2.disabled = true; }
      picks.append(h('label', { class:'pill pick', title: id }, [box2, document.createTextNode(' ' + nameOf(id) + (members.has(id) ? '' : '（不在已知成员里）'))]));
    };
    for (const id of shown) addPick(id, g.reviewers.includes(id));
    const more = h('select');
    more.append(h('option', { value:'', text:'加入其他联系人…' }));
    for (const u of users) if (!shown.has(u.id)) more.append(h('option', { value: u.id, text: u.name }));
    more.addEventListener('change', () => { if (more.value) { addPick(more.value, true); more.remove(more.selectedIndex); more.value = ''; } });
    box.append(h('div', { class:'sub', text:'审核人（可多选，不选就只有我）：' }), picks, more);
    box.append(h('button', { type:'button', text:'保存审核设置', onclick: async () => {
      const reviewers = [...picks.querySelectorAll('input:checked:not(:disabled)')].map((el) => el.value);
      const res = await post('/gates', { chatKey: g.chatKey, on: on.checked, reviewers });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return alert(body.error || '没有保存');
      location.reload();
    }}));
    root.append(box);
  }
}
function renderShares() {
  if (DATA.kind !== 'owner') return;
  const root = $('shares');
  root.append(h('h2', { text:'分享链接' }));
  for (const share of DATA.shares || []) {
    const scope = (share.projectNames || []).map((p) => p.title).join('、') || '不限群';
    const line = h('div', { class:'miss' }, [
      h('b', { text: share.name + (share.revoked ? '（已收回）' : '') }),
      h('div', { class:'sub', title: (share.projects || []).join(' '), text: (share.role === 'decide' ? '可拍板' : '只读') + ' · ' + scope + (share.onlyMine ? ' · 只看 ' + (share.requesterName || '指定的人') : '') }),
    ]);
    if (!share.revoked && share.path) line.append(h('div', { class:'sub', text: share.path }));
    if (!share.revoked) line.append(h('button', { class:'ghost', type:'button', text:'收回', onclick: async () => {
      const res = await fetch(base + '/shares/' + encodeURIComponent(share.id) + '/revoke', { method:'POST', headers:{'content-type':'application/json'}, body:'{}' });
      if (res.ok) location.reload();
    }}));
    root.append(line);
  }
  const name = h('input', { placeholder:'对方怎么称呼' });
  const role = h('select');
  role.append(h('option', { value:'read', text:'只读' }), h('option', { value:'decide', text:'可拍板' }));
  const picks = h('div', { class:'picks' });
  for (const g of (DATA.directory?.groups || [])) {
    const box = h('input', { type:'checkbox', value: g.chatKey });
    picks.append(h('label', { class:'pill pick', title: g.chatKey }, [box, document.createTextNode(' ' + g.title)]));
  }
  if (!picks.children.length) picks.append(h('span', { class:'sub', text:'还没有群可选。' }));
  const requester = h('select');
  requester.append(h('option', { value:'', text:'不限提出人' }));
  for (const user of (DATA.directory?.users || [])) requester.append(h('option', { value: user.id, text: '只看 ' + user.name + ' 提出的' }));
  root.append(h('form', { class:'inline', onsubmit: async (event) => {
    event.preventDefault();
    const projects = [...picks.querySelectorAll('input:checked')].map((el) => el.value);
    const res = await fetch(base + '/shares', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name: name.value, role: role.value, projects, onlyMine: Boolean(requester.value), requesterId: requester.value }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return alert(body.error || '没有创建');
    alert('新链接：' + location.origin + '/s/' + body.token);
    location.reload();
  }}, [name, role, h('div', { class:'sub', text:'可以看到哪些群：' }), picks, requester, h('button', { type:'submit', text:'创建分享链接' })]));
  const log = DATA.accessLog || [];
  if (log.length) {
    const list = h('details', { class:'sub' }, [h('summary', { text:'最近访问 ' + log.length + ' 条，最近一次 ' + (log.at(-1).whoName || '') })]);
    for (const entry of [...log].reverse()) list.append(h('div', { title: entry.who || '', text: when(entry.at) + ' · ' + (entry.whoName || '') + ' · ' + (ACTION[entry.action] || entry.action) }));
    root.append(list);
  }
}
renderHealth(); renderGroups(); renderReview(); renderControls(); renderMisses(); renderGates(); renderShares(); renderBoard();
</script></body></html>`;
}

function send(res, status, body, type) {
  const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'content-type': type || (typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'),
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(payload);
}

// 令牌都是 base64url；形状不对的请求不必碰状态文件，也不记入访问日志。
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,120}$/;

function secretFrom(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if ((parts[0] === 'a' || parts[0] === 's') && parts[1]) {
    let secret = '';
    try { secret = decodeURIComponent(parts[1]); } catch { return null; }
    return { prefix: parts[0], secret, rest: parts.slice(2) };
  }
  return null;
}

export function createBoardHandler({ getState, update, projects, onReviewed, now = Date.now }) {
  const lastLogged = new Map();
  // 同一个动作在窗口内只记一次；返回 true 表示这次该记。
  const quiet = (key, windowMs) => {
    const at = now();
    if (at - (lastLogged.get(key) ?? -Infinity) < windowMs) return false;
    lastLogged.set(key, at);
    if (lastLogged.size > 500) lastLogged.delete(lastLogged.keys().next().value);
    return true;
  };
  const stale = (auth) => auth.kind === 'share' && auth.share.revoked
    ? Object.assign(new Error('链接无效或已收回'), { status: 401 })
    : null;
  return async function handle(req, res) {
    try {
      let url;
      try { url = new URL(req.url || '/', 'http://127.0.0.1'); }
      catch { send(res, 400, { error: '请求地址无效' }); return; }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        send(res, 200, { ok: true, service: 'wecom-board' });
        return;
      }
      const located = secretFrom(url);
      if (!located || !TOKEN_SHAPE.test(located.secret)) {
        send(res, 401, { error: located ? '链接无效或已收回' : '需要访问链接' });
        return;
      }
      const state = await getState();
      if (!state) {
        send(res, 503, { error: '看板状态不可用' });
        return;
      }
      const auth = authenticateBoard(state, located.secret);
      if (!auth || (located.prefix === 'a' && auth.kind !== 'owner') || (located.prefix === 's' && auth.kind !== 'share')) {
        // 公网上任何人都能打这里：被拒的请求最多每分钟落盘一次，避免把状态文件写爆、把真实访问日志挤掉。
        if (quiet('denied', 60_000)) await update((current) => logAccess(current, { who: 'rejected', action: 'denied', ip: req.socket?.remoteAddress || '' }));
        send(res, 401, { error: '链接无效或已收回' });
        return;
      }
      const ip = req.socket?.remoteAddress || '';
      const items = () => visibleItems(state, auth);
      if (req.method === 'GET' && located.rest.length === 0) {
        if (quiet(`${auth.id}:view`, 30_000)) await update((current) => logAccess(current, { who: auth.id, action: 'view', ip }));
        send(res, 200, page(auth, boardPayload(state, auth, { projects: projects?.(state) })));
        return;
      }
      if (req.method === 'GET' && located.rest[0] === 'api') {
        if (quiet(`${auth.id}:api`, 30_000)) await update((current) => logAccess(current, { who: auth.id, action: 'api', ip }));
        const body = boardPayload(state, auth, { projects: projects?.(state) });
        send(res, 200, body);
        return;
      }
      if (req.method === 'POST' && located.rest[0] === 'layout') {
        const requested = await readBody(req);
        const layout = await update((current) => {
          const gone = stale(auth);
          if (gone) throw gone;
          const saved = saveLayout(current, auth, requested);
          logAccess(current, { who: auth.id, action: 'layout', ip });
          return saved;
        });
        send(res, 200, { ok: true, layout });
        return;
      }
      if (req.method === 'POST' && located.rest[0] === 'items' && located.rest[1] && located.rest.length === 2) {
        if (auth.role === 'read') {
          send(res, 403, { error: '只读链接不能拍板或改状态' });
          return;
        }
        const patch = await readBody(req);
        const allowed = new Set(items().map((item) => item.id));
        if (!allowed.has(located.rest[1])) {
          send(res, 404, { error: '这条需求不在你的范围内' });
          return;
        }
        const item = await update((current) => {
          const gone = stale(auth);
          if (gone) throw gone;
          const visible = new Set(visibleItems(current, auth).map((entry) => entry.id));
          if (!visible.has(located.rest[1])) throw Object.assign(new Error('这条需求不在你的范围内'), { status: 404 });
          let next;
          try {
            next = boardUpdate(current, {
              id: located.rest[1],
              status: patch.status,
              decision: patch.decision,
              // 拍板人只由服务端按登录身份记：分享链接是链接自己的名字，所有者是「所有者」，页面请求里填的名字一律不认。
              decidedBy: auth.kind === 'share' ? auth.share.name : '所有者',
              waitingOn: patch.waitingOn,
            }, undefined, { actor: 'page' });
          } catch (error) {
            throw Object.assign(error, { status: error.status || 400 });
          }
          logAccess(current, { who: auth.id, action: 'decide', ip });
          return presentItem(next);
        });
        send(res, 200, { ok: true, item });
        return;
      }
      if (req.method === 'POST' && located.rest[0] === 'items' && located.rest[1] && located.rest[2] === 'review') {
        if (auth.role === 'read') {
          send(res, 403, { error: '只读链接不能审核需求' });
          return;
        }
        const body = await readBody(req);
        const id = located.rest[1];
        const info = await update((current) => {
          const gone = stale(auth);
          if (gone) throw gone;
          if (!visibleItems(current, auth).some((entry) => entry.id === id)) throw Object.assign(new Error('这条需求不在你的范围内'), { status: 404 });
          // 审核人的名字只来自这次登录的身份：所有者，或者这条分享链接自己的名字。body 里的 decidedBy 等一律不看。
          const who = auth.kind === 'owner' ? { name: '所有者', via: 'page' } : { name: auth.share.name, via: 'share' };
          const done = applyReview(current, id, body.verdict, who, now(), body.reason);
          logAccess(current, { who: auth.id, action: 'review', ip });
          return { item: presentItem(done.item), task: done.task, text: done.text };
        });
        try { await onReviewed?.(info); } catch (error) { console.error('[board] onReviewed', error?.message ?? error); }
        send(res, 200, { ok: true, item: info.item });
        return;
      }
      if (req.method === 'POST' && auth.kind === 'owner' && located.rest[0] === 'gates' && located.rest.length === 1) {
        const body = await readBody(req);
        const gate = await update((current) => {
          try { setGate(current, String(body.chatKey ?? ''), { on: body.on === undefined ? undefined : body.on === true, reviewers: body.reviewers }); }
          catch (error) { throw Object.assign(error, { status: 400 }); }
          logAccess(current, { who: 'owner', action: 'gate', ip });
          return current.board.gates[String(body.chatKey)];
        });
        send(res, 200, { ok: true, gate });
        return;
      }
      if (req.method === 'POST' && auth.kind === 'owner' && located.rest[0] === 'owner' && located.rest.length === 1) {
        const body = await readBody(req);
        await update((current) => {
          try { setOwnerUserid(current, body.userid); }
          catch (error) { throw Object.assign(error, { status: 400 }); }
          logAccess(current, { who: 'owner', action: 'gate', ip });
        });
        send(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && auth.kind === 'owner' && located.rest[0] === 'misses' && located.rest[1] === 'import') {
        const body = await readBody(req);
        const chatKey = /^(group|single):.+/.test(String(body.chatKey ?? '')) ? String(body.chatKey) : '';
        const result = await update((current) => {
          const out = importMisses(current, { chatKey }, now());
          logAccess(current, { who: 'owner', action: 'import', ip });
          return out;
        });
        send(res, 200, { ok: true, ...result });
        return;
      }
      if (req.method === 'POST' && located.rest[0] === 'shares' && auth.kind === 'owner' && located.rest.length === 1) {
        const requested = await readBody(req);
        const created = await update((current) => {
          const share = createShare(current, requested);
          logAccess(current, { who: 'owner', action: 'share', ip });
          return { ...publicShare(share), token: share.token };
        });
        send(res, 200, created);
        return;
      }
      if (req.method === 'POST' && auth.kind === 'owner' && located.rest[0] === 'shares' && located.rest[2] === 'revoke') {
        await update((current) => { revokeShare(current, located.rest[1]); logAccess(current, { who: 'owner', action: 'revoke', ip }); });
        send(res, 200, { ok: true });
        return;
      }
      send(res, 404, { error: '没有这个页面' });
    } catch (error) {
      send(res, error.status || 500, { error: error.message || '看板请求失败' });
    }
  };
}

export function createBoardServer(options) {
  const server = createServer(createBoardHandler(options));
  server.on('error', (error) => console.error('[board] http', error?.message ?? error));
  return server;
}
