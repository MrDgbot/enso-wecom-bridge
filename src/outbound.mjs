import { bindingEntries, displayName, ownName, targetOf } from './core.mjs';

export const OUTBOUND_MODES = ['local-sessions', 'all-sessions', 'bound-only'];
export const REPLY_MAX_BYTES = 4000;
const STRICT_OUTBOUND_MODE = 'bound-only';
const CHAT_KEY = /^(group|single):.+/;

export const rootSessionId = (sessionId) => String(sessionId ?? '').split('::')[0].trim();

const resolveMode = (mode) => (OUTBOUND_MODES.includes(mode) ? mode : STRICT_OUTBOUND_MODE);

export const parseOutbound = (raw) =>
  raw === undefined ? { mode: 'local-sessions' } : { mode: resolveMode(raw?.mode) };

export function exposeSession(state, sessionId) {
  const sid = rootSessionId(sessionId);
  if (sid) state.exposedSessions[sid] = true;
}

export function setOutboundMode(state, mode) {
  if (!OUTBOUND_MODES.includes(mode)) throw new Error('未知的外发范围模式');
  state.outbound = { mode };
}

export const boundChatKeys = (state, sessionId) => [...new Set(bindingEntries(state)
  .filter(({ binding }) => rootSessionId(binding?.sessionId) === rootSessionId(sessionId))
  .map(({ chatKey }) => chatKey))];

export function sendScope(state, sessionId) {
  const sid = rootSessionId(sessionId);
  const bound = new Set(boundChatKeys(state, sid));
  const mode = resolveMode(state.outbound?.mode);
  if (mode === 'all-sessions') return { kind: 'any', mode, bound };
  if (mode === 'bound-only') return { kind: 'bound', mode, why: 'policy', bound };
  if (Object.hasOwn(state.exposedSessions ?? {}, sid)) return { kind: 'bound', mode, why: 'exposed', bound };
  return { kind: 'any', mode, bound };
}

const kindOf = (chatKey) => (chatKey.startsWith('group:') ? 'group' : 'single');

export function targetCatalog(state, currentBotId = '') {
  const scoped = (state.autoNames?.botId ?? '') === currentBotId;
  const keys = new Set([
    ...Object.entries(state.chats ?? {}).filter(([, c]) => (c?.botId ?? '') === currentBotId).map(([k]) => k),
    ...(scoped ? Object.keys(state.autoNames?.groups ?? {}).map((id) => `group:${id}`) : []),
    ...(scoped ? Object.keys(state.autoNames?.users ?? {}).map((id) => `single:${id}`) : []),
    ...((!currentBotId || !state.autoNames?.botId || scoped)
      ? bindingEntries(state).map(({ chatKey }) => chatKey).filter((k) => !state.chats?.[k])
      : []),
  ]);
  return [...keys].map((chatKey) => {
    const kind = kindOf(chatKey);
    const target = targetOf(chatKey);
    const manualName = ownName(state.names, target);
    const autoName = scoped ? ownName(state.autoNames?.[kind === 'group' ? 'groups' : 'users'], target) : '';
    return {
      chatKey, kind, target, manualName, autoName,
      name: displayName(state, target, '名称未获取', kind),
      aliases: [...new Set([manualName, autoName].filter(Boolean))],
      lastAt: Number(state.chats?.[chatKey]?.lastAt) || 0,
    };
  }).sort((a, b) => b.lastAt - a.lastAt || (a.chatKey < b.chatKey ? -1 : a.chatKey > b.chatKey ? 1 : 0));
}

const normName = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const stripGroupSuffix = (n) => n.replace(/群聊?$/, '') || n;
const forms = (item, raw) => (item.kind === 'group' ? stripGroupSuffix(normName(raw)) : normName(raw));

export function resolveTarget(catalog, input) {
  const raw = String(input ?? '').trim();
  if (CHAT_KEY.test(raw)) {
    const hit = catalog.find((item) => item.chatKey === raw);
    return hit ? { kind: 'one', target: hit } : { kind: 'none', matches: [] };
  }
  if (!normName(raw)) return { kind: 'none', matches: [] };
  const pick = (matches) => (matches.length === 1 ? { kind: 'one', target: matches[0] } : matches.length ? { kind: 'many', matches } : null);
  const exact = catalog.filter((item) => item.aliases.some((a) => forms(item, a) === forms(item, raw)));
  const partial = catalog.filter((item) => forms(item, raw).length >= 2 && item.aliases.some((a) => normName(a).includes(forms(item, raw))));
  return pick(exact) ?? pick(partial) ?? { kind: 'none', matches: [] };
}

export function listTargets(state, sessionId, { botId = '', query = '' } = {}) {
  const scope = sendScope(state, sessionId);
  const allowed = targetCatalog(state, botId).filter((item) => scope.kind === 'any' || scope.bound.has(item.chatKey));
  const q = String(query ?? '').trim();
  const shown = q
    ? allowed.filter((item) => item.chatKey === q || [...item.aliases, item.chatKey].some((a) => normName(a).includes(forms(item, q))))
    : allowed;
  return shown
    .map((item) => ({ chatKey: item.chatKey, name: item.name, kind: item.kind, bound: scope.bound.has(item.chatKey) }))
    .sort((a, b) => Number(b.bound) - Number(a.bound));
}

const crossSessionError = (scope) => new Error(scope.why === 'exposed'
  ? '目标未绑定当前会话，禁止跨会话发送（此会话已接入企微消息，如需跨会话外发请在侧栏「主动外发范围」切换为所有会话）'
  : '目标未绑定当前会话，禁止跨会话发送（当前外发范围为「仅已绑定目标」，可在侧栏切换）');

export function pickSendTarget(state, sessionId, botId, input) {
  const scope = sendScope(state, sessionId);
  const raw = String(input ?? '').trim();
  const found = resolveTarget(targetCatalog(state, botId), raw);
  const allowed = (item) => scope.kind === 'any' || scope.bound.has(item.chatKey);
  if (found.kind === 'one') {
    if (!allowed(found.target)) throw crossSessionError(scope);
    return found.target;
  }
  if (found.kind === 'many') {
    const matches = found.matches.filter(allowed);
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw crossSessionError(scope);
    throw new Error('匹配到多个企微会话，请先向用户确认具体目标后再用精确 chatKey 发送：' +
      JSON.stringify(matches.map((m) => ({ chatKey: m.chatKey, name: m.name, kind: m.kind }))));
  }
  if (CHAT_KEY.test(raw) && scope.kind === 'bound') throw crossSessionError(scope);
  throw new Error(`未找到匹配的企微会话「${raw}」。请先用 reply_targets 查询可用目标，或先在企微群里 @机器人 一次再试`);
}

export function outboundSummary(state, sessionId, botId = '') {
  const sid = rootSessionId(sessionId);
  if (!sid) {
    return { mode: resolveMode(state.outbound?.mode), scope: null, why: null, exposed: false, knownCount: targetCatalog(state, botId).length, boundCount: 0 };
  }
  const scope = sendScope(state, sid);
  return {
    mode: scope.mode,
    scope: scope.kind,
    why: scope.why ?? null,
    exposed: Boolean(sid && Object.hasOwn(state.exposedSessions ?? {}, sid)),
    knownCount: targetCatalog(state, botId).length,
    boundCount: scope.bound.size,
  };
}
