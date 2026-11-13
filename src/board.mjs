import { randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeGates } from './gate.mjs';

export const BOARD_APPEND_MAX_BYTES = 8 * 1024;
export const MISS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const STATUS_LABEL = {
  pending_review: '待审核',
  pending_decision: '待决定',
  todo: '待做',
  doing: '进行中',
  done: '完成',
  dropped: '放弃',
};
export const DELIVERY_LABEL = {
  pending: '待回复',
  delivered: '回复已送达',
  undelivered: '未送达',
  empty: '空回复',
};
const STATUS_ALIAS = {
  ...Object.fromEntries(Object.keys(STATUS_LABEL).map((k) => [k, k])),
  ...Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, v]) => [v, k])),
};
const OPEN = new Set(['pending_review', 'pending_decision', 'todo', 'doing']);
// 待审核只能由审核人（页面、群消息）移出，所以任何通用的状态改动都不能进出这个状态。
const TRANSITIONS = {
  pending_review: new Set(['pending_review']),
  pending_decision: new Set(['pending_decision', 'todo', 'doing', 'done', 'dropped']),
  todo: new Set(['todo', 'pending_decision', 'doing', 'done', 'dropped']),
  doing: new Set(['doing', 'todo', 'pending_decision', 'done', 'dropped']),
  done: new Set(['done', 'todo', 'doing', 'dropped']),
  dropped: new Set(['dropped', 'todo', 'pending_decision']),
};
const START_WORK = /开始做|都要做|都做|全部做|全做/;

const token = () => randomBytes(24).toString('base64url');
const idOf = (prefix) => `${prefix}_${randomBytes(4).toString('hex')}`;

export function emptyBoard() {
  return {
    items: [],
    shares: [],
    layouts: {},
    accessLog: [],
    misses: [],
    gates: {},
    ownerUserid: '',
    seq: {},
    since: 0,
    checkedAt: 0,
    ownerToken: token(),
    tunnelMode: '',
    lastCheck: null,
  };
}

const cleanText = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

export function normalizeTitle(title) {
  return cleanText(title, 200).normalize('NFKC').toLowerCase().replace(/\s+/g, '').replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 80);
}

const asOptions = (value) => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((item, index) => {
    if (typeof item === 'string') return { id: `o${index + 1}`, label: cleanText(item, 80) };
    return { id: cleanText(item?.id, 32) || `o${index + 1}`, label: cleanText(item?.label ?? item?.text, 80) };
  }).filter((item) => item.label);
};

const asStatus = (value, fallback) => STATUS_ALIAS[cleanText(value, 32)] || fallback;

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanText(raw.title, 120);
  const chatKey = cleanText(raw.chatKey, 300);
  if (!title || !/^(group|single):.+/.test(chatKey)) return null;
  const status = asStatus(raw.status, 'todo');
  if (!STATUS_LABEL[status]) return null;
  const requesterId = cleanText(raw.requester?.id ?? raw.requesterId, 128);
  return {
    id: cleanText(raw.id, 40) || idOf('b'),
    no: Number.isInteger(raw.no) && raw.no > 0 ? raw.no : 0,
    gated: raw.gated === true,
    review: ['approved', 'rejected'].includes(raw.review) ? raw.review : '',
    reviewVia: ['page', 'share', 'group'].includes(raw.reviewVia) ? raw.reviewVia : '',
    chatKey,
    title,
    detail: cleanText(raw.detail, 2000),
    options: asOptions(raw.options),
    status,
    waitingOn: cleanText(raw.waitingOn, 80),
    decision: cleanText(raw.decision, 500),
    decidedBy: cleanText(raw.decidedBy, 80),
    decidedAt: Number(raw.decidedAt) || 0,
    requester: { id: requesterId, name: cleanText(raw.requester?.name ?? raw.requesterName, 80) },
    source: raw.source === 'local' ? 'local' : 'wecom',
    project: {
      chatKey,
      name: cleanText(raw.project?.name ?? raw.projectName, 80),
    },
    taskIds: [...new Set((Array.isArray(raw.taskIds) ? raw.taskIds : []).map((id) => cleanText(id, 80)).filter(Boolean))].slice(0, 20),
    delivery: DELIVERY_LABEL[raw.delivery] ? raw.delivery : 'pending',
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
    dedupKey: normalizeTitle(title),
  };
}

function normalizeShare(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const shareToken = cleanText(raw.token, 80);
  if (!shareToken) return null;
  return {
    id: cleanText(raw.id, 40) || idOf('s'),
    token: shareToken,
    name: cleanText(raw.name, 40) || '未命名',
    role: raw.role === 'decide' ? 'decide' : 'read',
    projects: [...new Set((Array.isArray(raw.projects) ? raw.projects : []).map((k) => cleanText(k, 300)).filter((k) => /^(group|single):.+/.test(k)))].slice(0, 50),
    onlyMine: raw.onlyMine === true,
    requesterId: cleanText(raw.requesterId, 128),
    revoked: raw.revoked === true,
    createdAt: Number(raw.createdAt) || 0,
  };
}

// 每个聊天里的需求按提出顺序编号（#1、#2…），群里审核人说「同意 3」就是指这个编号。
// 编号只增不减，条目被清理后也不会复用。旧状态里没有编号的条目按创建时间补上。
function numberItems(board) {
  const byChat = new Map();
  for (const item of board.items) byChat.set(item.chatKey, [...(byChat.get(item.chatKey) ?? []), item]);
  for (const [chatKey, items] of byChat) {
    let top = Math.max(board.seq[chatKey] ?? 0, ...items.map((item) => item.no));
    const taken = new Set();
    for (const item of items) {
      if (item.no && !taken.has(item.no)) taken.add(item.no);
      else item.no = 0;
    }
    for (const item of [...items].filter((entry) => !entry.no).sort((a, b) => a.createdAt - b.createdAt)) {
      top += 1;
      item.no = top;
    }
    board.seq[chatKey] = top;
  }
}

export function normalizeBoard(raw) {
  const board = emptyBoard();
  if (!raw || typeof raw !== 'object') return board;
  if (typeof raw.ownerToken === 'string' && raw.ownerToken.length >= 16) board.ownerToken = raw.ownerToken.slice(0, 120);
  board.items = (Array.isArray(raw.items) ? raw.items : []).map(normalizeItem).filter(Boolean).slice(-500);
  board.shares = (Array.isArray(raw.shares) ? raw.shares : []).map(normalizeShare).filter(Boolean).slice(-100);
  board.layouts = raw.layouts && typeof raw.layouts === 'object' ? raw.layouts : {};
  board.accessLog = Array.isArray(raw.accessLog) ? raw.accessLog.slice(-200) : [];
  board.misses = Array.isArray(raw.misses) ? raw.misses.slice(-100) : [];
  board.gates = normalizeGates(raw.gates);
  board.ownerUserid = cleanText(raw.ownerUserid, 128);
  board.since = Number(raw.since) || 0;
  board.seq = {};
  for (const [chatKey, value] of Object.entries(raw.seq && typeof raw.seq === 'object' ? raw.seq : {})) {
    if (/^(group|single):.+/.test(chatKey) && Number.isInteger(value) && value > 0) board.seq[chatKey] = value;
  }
  numberItems(board);
  board.checkedAt = Number(raw.checkedAt) || 0;
  board.tunnelMode = cleanText(raw.tunnelMode, 20);
  board.lastCheck = raw.lastCheck && typeof raw.lastCheck === 'object' ? raw.lastCheck : null;
  return board;
}

export function presentItem(item) {
  const blocked = item.delivery === 'empty' || item.delivery === 'undelivered';
  const displayStatus = blocked && item.status === 'done' ? 'doing' : item.status;
  return {
    ...item,
    statusLabel: STATUS_LABEL[displayStatus] || displayStatus,
    storedStatusLabel: STATUS_LABEL[item.status] || item.status,
    deliveryLabel: DELIVERY_LABEL[item.delivery] || DELIVERY_LABEL.pending,
    displayStatus,
    replyOutstanding: blocked,
  };
}

function ensureBoard(state) {
  if (!state.board) state.board = emptyBoard();
  return state.board;
}

const nextNo = (board, chatKey) => {
  const top = Math.max(board.seq[chatKey] ?? 0, ...board.items.filter((item) => item.chatKey === chatKey).map((item) => item.no));
  board.seq[chatKey] = top + 1;
  return top + 1;
};

// opts.gated：这条需求来自群里的非审核人，新条目一律记为「待审核」；
// opts.createdAt：补登记时沿用原消息的时间。
// 状态能不能改，只看这里和 boardUpdate 的规则；谁是审核人由调用方（main/web）判断。
export function boardAdd(state, input, now = Date.now(), opts = {}) {
  const board = ensureBoard(state);
  const gated = opts.gated === true;
  const item = normalizeItem({
    ...input,
    id: input.id,
    createdAt: opts.createdAt || now,
    updatedAt: now,
    requester: input.requester ?? { id: input.requesterId, name: input.requesterName },
    project: { name: input.projectName },
  });
  if (!item) throw new Error('登记需求需要标题，以及 group: 或 single: 开头的聊天');
  if (input.status && item.status === 'pending_review') throw new Error('「待审核」由插件按审核门槛自动设置，不能手动指定');
  // 同一条企微消息（同一个任务编号）里常常有好几个需求，所以任务编号相同不能当作同一件事；
  // 只有标题也对得上，才按任务编号找回原条目（包括已完成、已放弃的）。
  const taskHit = item.taskIds.length
    ? board.items.find((existing) => existing.chatKey === item.chatKey && existing.dedupKey === item.dedupKey && existing.taskIds.some((id) => item.taskIds.includes(id)))
    : null;
  const titleHit = board.items.find((existing) => existing.chatKey === item.chatKey && existing.dedupKey === item.dedupKey && OPEN.has(existing.status));
  const existing = taskHit || titleHit;
  if (existing) {
    // 先决定状态，再改字段：状态非法时不能留下改了一半的条目。
    let nextStatus = null;
    if (input.status) {
      const fresh = item.taskIds.some((id) => !existing.taskIds.includes(id));
      if (existing.status === 'pending_review') nextStatus = null; // 待审核期间，登记只补充信息，不能改状态
      else if (existing.review === 'rejected' && !(gated && fresh)) nextStatus = null; // 驳回过的条目，不能借重新登记复活；只有提出人新发了一条消息才重新排队审核
      else if (gated && fresh && ['done', 'dropped'].includes(existing.status)) nextStatus = 'pending_review';
      else { assertTransition(existing.status, item.status); nextStatus = item.status; }
    }
    existing.detail = item.detail || existing.detail;
    existing.options = item.options.length ? item.options : existing.options;
    existing.waitingOn = item.waitingOn || existing.waitingOn;
    existing.requester = existing.requester.id ? existing.requester : item.requester;
    existing.taskIds = [...new Set([...existing.taskIds, ...item.taskIds])].slice(0, 20);
    if (item.project.name) existing.project.name = item.project.name;
    if (nextStatus === 'pending_review' && existing.status !== 'pending_review') {
      existing.status = 'pending_review';
      existing.gated = true;
      existing.review = '';
      existing.reviewVia = '';
      existing.decision = '';
      existing.decidedBy = '';
      existing.decidedAt = 0;
    } else if (nextStatus) {
      existing.status = nextStatus;
    }
    existing.updatedAt = now;
    return { item: existing, created: false };
  }
  item.no = nextNo(board, item.chatKey);
  if (gated) {
    item.status = 'pending_review';
    item.gated = true;
  }
  board.items.push(item);
  if (board.items.length > 500) board.items.splice(0, board.items.length - 500);
  return { item, created: true };
}

function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.has(to)) throw new Error(`不能从「${STATUS_LABEL[from] || from}」改成「${STATUS_LABEL[to] || to}」`);
}

// actor: 'model' 是会话里的助手（默认，最严格）；'page' 是管理页/分享链接里的人。
export function boardUpdate(state, input, now = Date.now(), opts = {}) {
  const board = ensureBoard(state);
  const actor = opts.actor === 'page' ? 'page' : 'model';
  const item = board.items.find((entry) => entry.id === cleanText(input.id, 40));
  if (!item) throw new Error('看板上没有这条需求');
  // 先校验状态再改别的字段，免得状态非法时前面的字段已经改了一半。
  let nextStatus = null;
  if (input.status) {
    nextStatus = asStatus(input.status, '');
    if (!STATUS_LABEL[nextStatus]) throw new Error('未知的看板状态');
    if (item.status === 'pending_review' && nextStatus !== 'pending_review') throw new Error('这条需求还在待审核，只有审核人同意后才能开始或改状态（在管理页点同意，或审核人在群里回复同意）。现在只能澄清，不能实现。');
    assertTransition(item.status, nextStatus);
    if (actor === 'model' && item.review === 'rejected' && nextStatus !== item.status && OPEN.has(nextStatus)) throw new Error('这条需求被审核人驳回了，不能重新开始；需要所有者在管理页改回。');
  }
  if (input.title) {
    item.title = cleanText(input.title, 120);
    item.dedupKey = normalizeTitle(item.title);
  }
  if (input.detail !== undefined) item.detail = cleanText(input.detail, 2000);
  if (input.options) item.options = asOptions(input.options);
  if (input.waitingOn !== undefined) item.waitingOn = cleanText(input.waitingOn, 80);
  if (input.decision !== undefined) item.decision = cleanText(input.decision, 500);
  if (input.decidedBy !== undefined) item.decidedBy = cleanText(input.decidedBy, 80);
  if (nextStatus) {
    // 所有者在页面上把被驳回的条目改回进行中：等于所有者复核通过，别再显示成「已驳回」。
    if (item.review === 'rejected' && nextStatus !== item.status && OPEN.has(nextStatus)) { item.review = 'approved'; item.reviewVia = 'page'; }
    item.status = nextStatus;
    if (nextStatus !== 'pending_decision' && item.decision) item.decidedAt = item.decidedAt || now;
  }
  if (input.taskIds) item.taskIds = [...new Set([...item.taskIds, ...input.taskIds.map((id) => cleanText(id, 80)).filter(Boolean)])].slice(0, 20);
  if (input.delivery && DELIVERY_LABEL[input.delivery]) item.delivery = input.delivery;
  item.updatedAt = now;
  return item;
}

export function boardList(state, filter = {}) {
  const board = ensureBoard(state);
  const chatKey = cleanText(filter.chatKey, 300);
  const status = filter.status ? asStatus(filter.status, '') : '';
  return board.items.filter((item) => (!chatKey || item.chatKey === chatKey) && (!status || item.status === status)).map(presentItem);
}

export function syncDelivery(state, taskIds, delivery, now = Date.now()) {
  if (!DELIVERY_LABEL[delivery]) return [];
  const ids = new Set(taskIds);
  const touched = [];
  for (const item of ensureBoard(state).items) {
    if (!item.taskIds.some((id) => ids.has(id))) continue;
    item.delivery = delivery;
    item.updatedAt = now;
    if ((delivery === 'empty' || delivery === 'undelivered') && item.status === 'done') {
      item.status = 'doing';
    }
    touched.push(item.id);
  }
  return touched;
}

const looksLikeRequirement = (text) => {
  const value = String(text ?? '').trim();
  if (value.length < 6) return false;
  if (/^(好的|收到|嗯+|ok|谢谢|知道了)[!！。.\s]*$/i.test(value)) return false;
  return /[?？]|做|决定|能不能|是否|要不要|怎么|为什么|规则|改成|支持|确认/.test(value) || value.length >= 12;
};

export function findMisses(state, now = Date.now(), windowMs = MISS_WINDOW_MS) {
  const board = ensureBoard(state);
  const linked = new Set(board.items.flatMap((item) => item.taskIds));
  const keys = board.items.map((item) => item.dedupKey).filter((key) => key.length >= 6);
  return state.tasks.filter((task) => {
    if (!task?.text || task.synthetic || task.reviewed || now - (task.createdAt || 0) > windowMs) return false;
    if (['denied', 'unbound'].includes(task.status)) return false;
    if (linked.has(task.id)) return false;
    if (!looksLikeRequirement(task.text)) return false;
    const key = normalizeTitle(task.text);
    if (key && keys.some((existing) => existing === key || (existing.length >= 8 && (key.includes(existing) || existing.includes(key))))) return false;
    return true;
  }).slice(-50).map((task) => ({
    taskId: task.id,
    chatKey: task.chatKey,
    text: cleanText(task.text, 160),
    requesterId: task.userid || '',
    createdAt: task.createdAt || 0,
    status: task.status,
  }));
}

export function refreshMisses(state, now = Date.now()) {
  const board = ensureBoard(state);
  board.misses = findMisses(state, now);
  board.checkedAt = now;
  return board.misses;
}

function clipBytes(text, maxBytes, suffix) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const room = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  let cut = buf.subarray(0, room).toString('utf8');
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  return cut + suffix;
}

export function boardLines(state, { chatKey = '', statuses = ['pending_decision', 'todo'] } = {}) {
  return boardList(state, { chatKey }).filter((item) => statuses.includes(item.status));
}

// 看板空不等于没有事做：模型可能漏登记了。别让它得出「没事可做」的结论。
const NO_REGISTERED_WORK = '看板上没有登记待做或待决定的条目，这不代表没有事做：请回看这个聊天最近的讨论，自己列出已经确认要做的事再动手，并说明哪些没登记。';

const lineOf = (item) => `${item.statusLabel} ${item.id} #${item.no} ${item.title}${item.waitingOn ? `（待 ${item.waitingOn}）` : ''}`;
const REVIEW_NOTE = '（待审核的需求审核人还没同意，只能澄清，不能实现，也不在「开始做」范围内）';

export function formatWorkList(state, chatKey = '') {
  const items = boardLines(state, { chatKey, statuses: ['todo', 'doing', 'pending_decision'] });
  const waiting = boardLines(state, { chatKey, statuses: ['pending_review'] });
  const note = waiting.length ? `\n${REVIEW_NOTE}不要做：\n${waiting.map(lineOf).join('\n')}` : '';
  if (!items.length) return NO_REGISTERED_WORK + note;
  return items.map(lineOf).join('\n') + note;
}

export function boardAppend(state, { chatKeys = [], startWork = false, gateLines = [] } = {}) {
  const wanted = new Set(chatKeys.filter(Boolean));
  const items = boardList(state).filter((item) => ['pending_decision', 'todo', 'doing'].includes(item.status));
  const scoped = wanted.size ? items.filter((item) => wanted.has(item.chatKey)) : items;
  const waitingAll = boardList(state).filter((item) => item.status === 'pending_review');
  const waiting = wanted.size ? waitingAll.filter((item) => wanted.has(item.chatKey)) : waitingAll;
  const rules = [
    '【需求看板】回复前先登记：已经确认要做的用 board_add 记为待做，还没拍板的记为待决定（写上选项和待谁拍板）。同一件事再次出现就更新原条目，不要另建一条。',
    '用户说「开始做 / 都做 / 都要做」时，必须先列出下面全部待做条目，逐条处理；做不到的要在回复里点名跳过哪一条、为什么。不要只做最后讨论的一条。',
    '在 Enso 会话里本地提出的需求也要登记，source 填 local。不要把看板条数、链接或「待定」状态发进企微；群里的回复只写结论。',
    '回复如果是空的或没送到，看板会标成空回复或未送达，不要把这种条目当成完成。',
    '【审核门槛】群里非审核人提出的需求或 bug，用 board_add 登记后会被插件自动记为「待审核」。待审核的条目审核人还没同意：只能澄清、答疑，不能实现、不能改代码、不能开始做，用户说「开始做 / 都做」也不包括它们；你也不能把它改成待做或进行中，只有审核人在管理页或群里同意后才会变成待做，由插件另行通知你。回复里写明「已登记，等审核人确认」，群里会自动附上编号和审核方式，不用你重复。',
    ...gateLines,
  ];
  if (startWork) {
    rules.push(`用户这轮在说开始做。待处理全文：\n${scoped.length ? scoped.map(lineOf).join('\n') : NO_REGISTERED_WORK}${waiting.length ? `\n${REVIEW_NOTE}不要做，点名跳过：\n${waiting.map(lineOf).join('\n')}` : ''}`);
  }
  const body = scoped.map((item) => `${item.statusLabel} ${item.id} #${item.no} ${item.title}`).join('\n');
  const omitted = Math.max(0, items.length - scoped.length);
  const text = [
    ...rules,
    scoped.length ? `当前未完成（${scoped.length}）：\n${body}` : '当前没有未完成条目。',
    waiting.length ? `待审核，不得实现（${waiting.length}）：\n${waiting.map((item) => `#${item.no} ${item.id} ${item.title}`).join('\n')}` : '',
    omitted ? `另有 ${omitted} 条不在本轮聊天里。` : '',
  ].filter(Boolean).join('\n');
  return clipBytes(text, BOARD_APPEND_MAX_BYTES, '\n…（看板摘要已截断）');
}

export function mentionsStartWork(text) {
  return START_WORK.test(String(text ?? ''));
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function authenticateBoard(state, secret) {
  const board = ensureBoard(state);
  if (!secret || !sameSecret(secret, board.ownerToken)) {
    const share = board.shares.find((item) => !item.revoked && sameSecret(item.token, secret));
    if (!share) return null;
    return { kind: 'share', role: share.role, share, id: share.id };
  }
  return { kind: 'owner', role: 'owner', id: 'owner' };
}

export function visibleItems(state, auth) {
  const items = boardList(state);
  if (!auth || auth.kind === 'owner') return items;
  return items.filter((item) => {
    const projects = auth.share.projects;
    if (!projects.length && !auth.share.onlyMine) return false;
    if (projects.length && !projects.includes(item.chatKey)) return false;
    if (auth.share.onlyMine && item.requester.id !== auth.share.requesterId) return false;
    return true;
  });
}

const LAYOUT_FIELDS = ['detail', 'requester', 'waitingOn', 'decision', 'delivery', 'source', 'options'];
const LAYOUT_GROUPS = ['status', 'project', 'requester'];
const LAYOUT_SORTS = ['updated', 'created', 'status'];

export function normalizeLayout(raw) {
  const layout = {
    groupBy: 'status',
    group: '',
    sort: 'updated',
    fields: ['detail', 'requester', 'waitingOn', 'decision', 'delivery', 'source'],
    columns: ['pending_review', 'pending_decision', 'todo', 'doing', 'done', 'dropped'],
  };
  if (!raw || typeof raw !== 'object') return layout;
  if (LAYOUT_GROUPS.includes(raw.groupBy)) layout.groupBy = raw.groupBy;
  if (LAYOUT_SORTS.includes(raw.sort)) layout.sort = raw.sort;
  // 当前看哪个群：空表示全部；只认 group:/single: 开头的聊天 id，范围由读取方按权限再核对。
  if (typeof raw.group === 'string' && /^(group|single):.{1,300}$/.test(raw.group)) layout.group = raw.group;
  if (Array.isArray(raw.fields)) layout.fields = raw.fields.filter((field) => LAYOUT_FIELDS.includes(field));
  if (Array.isArray(raw.columns)) {
    const columns = raw.columns.filter((status) => STATUS_LABEL[status]);
    // 待审核永远显示：旧布局里没有这一列，不能让待审核的条目看不见。
    if (columns.length) layout.columns = columns.includes('pending_review') ? columns : ['pending_review', ...columns];
  }
  return layout;
}

// 分享链接只能停在自己授权范围内的群上；范围改了或收窄了，记住的群不在范围里就退回“全部”。
function inScope(layout, auth) {
  if (!layout.group || auth?.kind !== 'share') return layout;
  const projects = auth.share?.projects || [];
  return projects.length && !projects.includes(layout.group) ? { ...layout, group: '' } : layout;
}

export function layoutFor(state, auth) {
  return inScope(normalizeLayout(ensureBoard(state).layouts?.[auth?.id]), auth);
}

export function saveLayout(state, auth, layout) {
  const board = ensureBoard(state);
  board.layouts[auth.id] = inScope(normalizeLayout(layout), auth);
  return board.layouts[auth.id];
}

export function logAccess(state, entry, now = Date.now()) {
  const board = ensureBoard(state);
  board.accessLog.push({
    at: now,
    who: entry.who || 'anonymous',
    action: cleanText(entry.action, 40) || 'read',
    ip: cleanText(entry.ip, 64),
  });
  if (board.accessLog.length > 200) board.accessLog.splice(0, board.accessLog.length - 200);
}

export function createShare(state, input, now = Date.now()) {
  const board = ensureBoard(state);
  const projects = [...new Set((Array.isArray(input.projects) ? input.projects : [input.project].filter(Boolean)).map((key) => cleanText(key, 300)))].filter((key) => /^(group|single):.+/.test(key));
  const onlyMine = input.onlyMine === true;
  const requesterId = cleanText(input.requesterId, 128);
  if (!projects.length && !onlyMine) throw new Error('请至少选择一个项目，或勾选只看本人提出的需求');
  if (onlyMine && !requesterId) throw new Error('只看本人提出的需求时，要填写企微用户 id');
  const share = normalizeShare({
    id: idOf('s'),
    token: token(),
    name: cleanText(input.name, 40) || '协作者',
    role: input.role === 'decide' ? 'decide' : 'read',
    projects,
    onlyMine,
    requesterId,
    revoked: false,
    createdAt: now,
  });
  board.shares.push(share);
  return share;
}

export function revokeShare(state, shareId) {
  const share = ensureBoard(state).shares.find((item) => item.id === shareId);
  if (!share) throw new Error('没有这条分享链接');
  share.revoked = true;
  return share;
}

export function publicShare(share) {
  if (!share) return null;
  return {
    id: share.id,
    name: share.name,
    role: share.role,
    projects: share.projects,
    onlyMine: share.onlyMine,
    requesterId: share.requesterId,
    revoked: share.revoked,
    createdAt: share.createdAt,
  };
}
