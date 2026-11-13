// 审核人门槛：只放纯函数，不依赖 core.mjs，这样 core.mjs / board.mjs / web-board.mjs 都能引用。
// 规则：群聊里，非审核人提出的需求先记为「待审核」，审核人同意前只能澄清、不能实现。
// 所有者本人（board.ownerUserid）永远是审核人；没单独指定审核人时，审核人就只有所有者。

export const MAX_REVIEWERS = 20;
const rootSessionId = (sessionId) => String(sessionId ?? '').split('::')[0].trim();

const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
export const isGroupKey = (chatKey) => /^group:.+/.test(String(chatKey ?? ''));

export function normalizeGates(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [chatKey, cfg] of Object.entries(raw).slice(0, 500)) {
    if (!isGroupKey(chatKey) || chatKey.length > 300 || !cfg || typeof cfg !== 'object') continue;
    const reviewers = [...new Set((Array.isArray(cfg.reviewers) ? cfg.reviewers : []).map((id) => text(id, 128)).filter(Boolean))].slice(0, MAX_REVIEWERS);
    out[chatKey] = { on: cfg.on !== false, reviewers };
  }
  return out;
}

export const ownerUserid = (state) => String(state?.board?.ownerUserid ?? '');

// 本机状态里见过这个 userid 吗（发过消息、有昵称、在任何群的成员里）。
export function knownUser(state, id) {
  if (!id) return false;
  const key = String(id);
  return Object.hasOwn(state?.autoNames?.users ?? {}, key)
    || Object.hasOwn(state?.names ?? {}, key)
    || (state?.tasks ?? []).some((task) => task?.userid === key)
    || (state?.access?.allow ?? []).includes(key)
    || (state?.access?.block ?? []).includes(key)
    || Object.values(state?.chats ?? {}).some((chat) => chat?.lastUserid === key || (chat?.userids ?? []).includes(key))
    || Object.values(state?.memberBindings ?? {}).some((users) => users && Object.hasOwn(users, key));
}

export function gateFor(state, chatKey) {
  if (!isGroupKey(chatKey)) return { on: false, reviewers: [], explicit: [], configured: false };
  const cfg = state?.board?.gates?.[chatKey];
  const explicit = cfg?.reviewers ?? [];
  const owner = ownerUserid(state);
  return {
    on: cfg ? cfg.on !== false : true,
    reviewers: [...new Set([owner, ...explicit].filter(Boolean))],
    explicit,
    configured: Boolean(cfg),
  };
}

export const isReviewer = (state, chatKey, userid) => Boolean(userid) && gateFor(state, chatKey).reviewers.includes(String(userid));

// requesterIds 为空表示不知道是谁提的：群里开着门槛时按「非审核人」处理。
export function needsReview(state, chatKey, requesterIds = []) {
  const gate = gateFor(state, chatKey);
  if (!gate.on) return false;
  const ids = requesterIds.filter(Boolean);
  if (!ids.length) return true;
  return ids.some((id) => !gate.reviewers.includes(id));
}

export function setGate(state, chatKey, patch = {}) {
  if (!isGroupKey(chatKey)) throw new Error('审核门槛只用于群聊');
  const board = state.board;
  const current = board.gates[chatKey] ?? { on: true, reviewers: [] };
  const next = { on: current.on, reviewers: current.reviewers };
  if (patch.on !== undefined) next.on = patch.on === true;
  if (patch.reviewers !== undefined) {
    if (!Array.isArray(patch.reviewers)) throw new Error('审核人需要是列表');
    const ids = [...new Set(patch.reviewers.map((id) => text(id, 128)).filter(Boolean))];
    if (ids.length > MAX_REVIEWERS) throw new Error(`审核人最多 ${MAX_REVIEWERS} 个`);
    const stranger = ids.find((id) => !knownUser(state, id));
    if (stranger) throw new Error('只能从已知成员里选审核人');
    next.reviewers = ids;
  }
  board.gates[chatKey] = next;
  return gateFor(state, chatKey);
}

export function setOwnerUserid(state, userid) {
  const id = text(userid, 128);
  if (id && !knownUser(state, id)) throw new Error('只能从已知成员里选');
  state.board.ownerUserid = id;
  return id;
}

// ---- 会话是不是早于看板工具 ----
// 工具和事件只在会话新建时挂上。可靠的信号有两个：
// 1. 这个绑定的会话调用过任何看板工具（binding.boardToolAt）→ 一定有工具。
// 2. 绑定时间早于插件第一次带着看板门槛启动（board.since），并且从没调用过 → 很可能是旧会话。
// 另外，绑定之后已经处理了几条群消息却一次都没用过看板，也提示一下。
export const SILENT_AFTER = 3;
export function bindingHealth(state, chatKey) {
  const since = Number(state?.board?.since) || 0;
  const bindings = [state?.bindings?.[chatKey], ...Object.values(state?.memberBindings?.[chatKey] ?? {})].filter(Boolean);
  for (const binding of bindings) {
    if (binding.boardToolAt) continue;
    const boundAt = Number(binding.boundAt) || 0;
    if (since && boundAt < since) {
      return {
        level: 'predates',
        boundAt,
        since,
        text: '这个聊天接的会话是在看板和审核门槛上线前绑的，会话里可能没有看板工具，需求登记不上来。请在 Enso 新建一个会话，把聊天重新绑定过去（会话里用过一次看板工具后，这条提示会自动消失）。',
      };
    }
    const handled = (state.tasks ?? []).filter((task) => task.chatKey === chatKey && !task.synthetic && ['queued', 'replied'].includes(task.status) && (task.createdAt || 0) >= boundAt).length;
    if (handled >= SILENT_AFTER) {
      return {
        level: 'silent',
        boundAt,
        since,
        text: `这个会话已经处理了 ${handled} 条消息，却一次都没用过看板工具，可能是旧会话。请在新会话里重新绑定。`,
      };
    }
  }
  return null;
}

// 模型调用任何看板工具，就说明它所在的会话有工具。
export function markBoardTool(state, sessionId, now = Date.now()) {
  let changed = false;
  const mark = (binding) => {
    if (!binding || !sessionId) return;
    if (rootSessionId(binding.sessionId) !== sessionId) return;
    if (!binding.boardToolAt) { binding.boardToolAt = now; changed = true; }
  };
  for (const binding of Object.values(state.bindings ?? {})) mark(binding);
  for (const users of Object.values(state.memberBindings ?? {})) for (const binding of Object.values(users ?? {})) mark(binding);
  return changed;
}

// 这个会话的绑定里，还有没记过看板工具的吗（用来少写盘：已经记过就不用再存一次）。
export function boardToolUnmarked(state, sessionId) {
  const all = [...Object.values(state.bindings ?? {}), ...Object.values(state.memberBindings ?? {}).flatMap((users) => Object.values(users ?? {}))];
  return all.some((binding) => binding && rootSessionId(binding.sessionId) === sessionId && !binding.boardToolAt);
}
