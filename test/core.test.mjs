import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as core from '../src/core.mjs';
import { targetCatalog } from '../src/outbound.mjs';
import {
  bind,
  bindMember,
  buildPrompt,
  clipBytes,
  displayName,
  emptyState,
  extractContent,
  failQueued,
  knownProjects,
  markInjected,
  markSendFailed,
  matchesProject,
  mergeSessionNames,
  members,
  normalizeState,
  receive,
  setListed,
  setMode,
  setName,
  settle,
  snapshotData,
  taskProject,
  unbind,
} from '../src/core.mjs';

const groupMsg = (msgid, userid, content) => ({
  msgid,
  chattype: 'group',
  chatid: 'wrGROUP',
  from: { userid },
  msgtype: 'text',
  text: { content },
});
const aliceOnly = () => ({ ...emptyState(), access: { mode: 'allowlist', allow: ['alice'], block: [] } });

test('group @ from allowed user reaches the bound session with the mention stripped', () => {
  const s = aliceOnly();
  bind(s, 'group:wrGROUP', { sessionId: 'S1', title: 'demo', projectRoot: '/p', boundAt: 0 });
  const r = receive(s, groupMsg('m1', 'alice', '@小助手 修一下登录 bug'), { now: 1 });
  assert.equal(r.decision, 'inject');
  assert.equal(r.binding.sessionId, 'S1');
  assert.equal(r.content.text, '修一下登录 bug');
});

test('unknown sender is denied and unbound chat is reported, both recorded for the panel', () => {
  const s = aliceOnly();
  assert.equal(receive(s, groupMsg('m1', 'mallory', '@bot rm -rf'), { now: 1 }).decision, 'denied');
  assert.equal(receive(s, groupMsg('m2', 'alice', '@bot hi'), { now: 2 }).decision, 'unbound');
  assert.deepEqual(s.tasks.map((t) => t.status), ['denied', 'unbound']);
  assert.equal(s.chats['group:wrGROUP'].lastUserid, 'alice');
});

test('redelivered msgid is ignored', () => {
  const s = aliceOnly();
  receive(s, groupMsg('m1', 'alice', 'x'), { now: 1 });
  assert.equal(receive(s, groupMsg('m1', 'alice', 'x'), { now: 2 }).decision, 'duplicate');
});

test('a non-empty agent_end settles one combined reply per chat; empty or aborted runs settle nothing', () => {
  const s = aliceOnly();
  bind(s, 'group:wrGROUP', { sessionId: 'S1', title: 'demo', projectRoot: '/p', boundAt: 0 });
  bind(s, 'single:alice', { sessionId: 'S1', title: 'demo', projectRoot: '/p', boundAt: 0 });
  for (const [id, msg] of [
    ['m1', groupMsg('m1', 'alice', 'a')],
    ['m2', groupMsg('m2', 'alice', 'b')],
    ['m3', { msgid: 'm3', chattype: 'single', from: { userid: 'alice' }, msgtype: 'text', text: { content: 'c' } }],
  ]) {
    receive(s, msg, { now: 1 });
    markInjected(s, id, 2);
  }
  assert.deepEqual(settle(s, 'S2', 'other session', 3), []);
  assert.deepEqual(settle(s, 'S1', '', 3), [], 'empty runs do not close the queue');
  assert.deepEqual(settle(s, 'S1', '中止了', 3, { aborted: true }), []);
  assert.equal(s.tasks.every((t) => t.status === 'queued'), true);
  const replies = settle(s, 'S1', 'done', 3);
  assert.deepEqual(replies, [
    { chatKey: 'group:wrGROUP', taskIds: ['m1', 'm2'] },
    { chatKey: 'single:alice', taskIds: ['m3'] },
  ]);
  assert.deepEqual(settle(s, 'S1', 'again', 4), [], 'a later turn does not reply twice');
});

test('settle only closes the batch the run actually read', () => {
  const s = aliceOnly();
  bind(s, 'group:wrGROUP', { sessionId: 'S1', title: 'demo', projectRoot: '/p', boundAt: 0 });
  receive(s, groupMsg('m1', 'alice', 'a'), { now: 1 });
  receive(s, groupMsg('m2', 'alice', 'b'), { now: 1 });
  markInjected(s, 'm1', 2, undefined, { batchId: 'read' });
  markInjected(s, 'm2', 2, undefined, { batchId: 'later' });
  assert.deepEqual(settle(s, 'S1', '合并回复', 3, { batchId: 'read' }), [{ chatKey: 'group:wrGROUP', taskIds: ['m1'] }]);
  assert.equal(s.tasks.find((t) => t.id === 'm2').status, 'queued');
});

test('failed inject never waits for agent_end; session error fails queued tasks', () => {
  const s = aliceOnly();
  bind(s, 'group:wrGROUP', { sessionId: 'S1', title: 'demo', projectRoot: '/p', boundAt: 0 });
  receive(s, groupMsg('m1', 'alice', 'a'), { now: 1 });
  markInjected(s, 'm1', 2, 'denied');
  receive(s, groupMsg('m2', 'alice', 'b'), { now: 1 });
  markInjected(s, 'm2', 2);
  assert.deepEqual(failQueued(s, 'S1', 'boom', 3), ['group:wrGROUP']);
  assert.deepEqual(settle(s, 'S1', 'late', 4), []);
  assert.deepEqual(s.tasks.map((t) => t.status), ['failed', 'failed']);
});

test('mixed message keeps text and images, quote text is carried', () => {
  const c = extractContent({
    chattype: 'single',
    msgtype: 'mixed',
    mixed: { msg_item: [{ msgtype: 'text', text: { content: '看图' } }, { msgtype: 'image', image: { url: 'u', aeskey: 'k' } }] },
    quote: { msgtype: 'text', text: { content: '上一条' } },
  });
  assert.equal(c.text, '看图');
  assert.equal(c.quote, '上一条');
  assert.equal(c.images.length, 1);
});

test('clipBytes keeps replies under the byte limit without splitting a character', () => {
  const out = clipBytes('中'.repeat(3000), 100, '…');
  assert.ok(Buffer.byteLength(out) <= 100);
  assert.ok(!out.includes('\uFFFD'));
});

test('a named sender shows by name in the prompt and panel; unnamed falls back to a short id', () => {
  const s = aliceOnly();
  const r = receive(s, groupMsg('m1', 'woFAKE0000000000000000000000user', '@bot 看下 README'), { now: 1 });
  assert.equal(displayName(s, 'woFAKE0000000000000000000000user'), '姓名未获取 woFA…user');
  setName(s, 'woFAKE0000000000000000000000user', '  赵六 ');
  setName(s, 'wrGROUP', '研发群');
  const prompt = buildPrompt(s, { chatKey: r.task.chatKey, userid: r.task.userid, content: { text: 'x', quote: '', images: [] } });
  assert.match(prompt, /群聊「研发群」 · 发送人 赵六\]/);
  setName(s, 'woFAKE0000000000000000000000user', '');
  assert.match(buildPrompt(s, { chatKey: 'single:x', userid: 'woFAKE0000000000000000000000user', content: { text: 'x', quote: '', images: [] } }), /姓名未获取/);
  assert.throws(() => setName(s, 'nobody', 'x'), /没有这个成员或群/);
});

test('all WeCom prompts request plain-language final replies without dropping facts or technical requests', () => {
  for (const chatKey of ['single:u', 'group:g']) {
    const prompt = buildPrompt(emptyState(), { chatKey, userid: 'u', content: { text: '解释一下，也给我代码', quote: '', images: [] } });
    assert.match(prompt, /回复风格按 bro/);
    assert.match(prompt, /默认提问者不是技术人员/);
    assert.match(prompt, /默认回复 3～5 句、总计 150 字以内/);
    assert.match(prompt, /不凑句数/);
    assert.match(prompt, /不汇报执行过程/);
    assert.match(prompt, /必要事实放不下时允许超过默认长度/);
    assert.match(prompt, /用户追问细节或明确要求完整清单、长文时可以展开/);
    assert.match(prompt, /先说结果/);
    assert.match(prompt, /保留重要数字、风险和不确定性/);
    assert.match(prompt, /用户明确要代码或技术细节时再展开/);
    assert.match(prompt, /解释一下，也给我代码/);
  }
});

test('blocklist mode lets everyone in except blocked; block wins over allow in allowlist mode', () => {
  const s = emptyState();
  const send = (id, userid) => receive(s, groupMsg(id, userid, '@bot hi'), { now: 1 });
  assert.equal(send('a', 'stranger').decision, 'unbound', 'default mode is open to everyone');
  send('b', 'eve');
  setListed(s, 'block', 'eve', true);
  const blocked = send('c', 'eve');
  assert.equal(blocked.decision, 'denied');
  assert.equal(blocked.blocked, true);
  setMode(s, 'allowlist');
  assert.equal(send('d', 'stranger').decision, 'denied');
  setListed(s, 'allow', 'stranger', true);
  setListed(s, 'allow', 'eve', true);
  assert.equal(send('e', 'stranger').decision, 'unbound');
  assert.equal(send('f', 'eve').decision, 'denied', 'blocked wins over allowed');
  assert.throws(() => setListed(s, 'allow', 'nobody', true), /没有这个成员/);
  assert.throws(() => setMode(s, 'open'), /未知的派活模式/);
});

test('members carry the access verdict for the panel, newest first', () => {
  const s = emptyState();
  receive(s, groupMsg('a', 'old', 'x'), { now: 1 });
  receive(s, groupMsg('b', 'new', 'x'), { now: 2 });
  setListed(s, 'block', 'old', true);
  assert.deepEqual(members(s), [
    { userid: 'new', allowed: false, blocked: false, canAssign: true },
    { userid: 'old', allowed: false, blocked: true, canAssign: false },
  ]);
});

test('group speakers and member-route overrides remain in members() and stay blockable/renamable after MAX_TASKS rollover', () => {
  const s = emptyState();
  bind(s, 'group:wrGROUP', { sessionId: 'S1', title: 'demo', projectRoot: '/p', boundAt: 0 });
  receive(s, groupMsg('early-speaker', 'speaker-a', '@bot early'), { now: 1 });
  for (let i = 0; i < 105; i++) {
    receive(s, groupMsg(`fill-${i}`, 'speaker-b', `@bot ${i}`), { now: 10 + i });
  }
  s.memberBindings['group:wrGROUP'] = {
    'override-only': { sessionId: 'S2', title: 'override', projectRoot: '/p', boundAt: 5 },
  };
  const ids = members(s).map((m) => m.userid);
  assert.ok(ids.includes('speaker-a'), 'early group speaker retained via chat.userids');
  assert.ok(ids.includes('override-only'), 'member override speaker retained via memberBindings');
  setListed(s, 'block', 'speaker-a', true);
  setName(s, 'override-only', '专人备注');
  assert.equal(s.access.block.includes('speaker-a'), true);
  assert.equal(s.names['override-only'], '专人备注');
});

test('upgrading from 0.1.3 carries the hand-typed config lists into state once', () => {
  const legacy = { accessMode: '白名单模式：只有名单里的人能派活', allowedUserIds: 'alice, bob', blockedUserIds: 'eve' };
  const s = normalizeState({ tasks: [] }, legacy);
  assert.deepEqual(s.access, { mode: 'allowlist', allow: ['alice', 'bob'], block: ['eve'] });
  assert.equal(members(s).length, 3, 'listed people show up in the panel even before they speak');
  const saved = { access: { mode: 'blocklist', allow: [], block: [] } };
  assert.deepEqual(normalizeState(saved, legacy).access, saved.access, 'saved state wins over legacy config');
  assert.equal(normalizeState(null, {}).access.mode, 'blocklist');
});

test('task projectRoot is immutable across rebind, unbind, null project, and JSON reload', () => {
  const s = aliceOnly();
  bind(s, 'group:wrGROUP', { sessionId: 'S1', title: 'projA', projectRoot: '/work/proj-a', boundAt: 1 });
  receive(s, groupMsg('t-a', 'alice', '@bot task for A'), { now: 10 });

  bind(s, 'group:wrGROUP', { sessionId: 'S2', title: 'projB', projectRoot: '/work/proj-b', boundAt: 20 });
  receive(s, groupMsg('t-b', 'alice', '@bot task for B'), { now: 21 });

  bind(s, 'group:wrGROUP', { sessionId: 'S3', title: 'scratch', projectRoot: null, boundAt: 30 });
  receive(s, groupMsg('t-null', 'alice', '@bot task with null project'), { now: 31 });

  unbind(s, 'group:wrGROUP');
  receive(s, groupMsg('t-unbound', 'alice', '@bot unbound task'), { now: 40 });

  const reloaded = normalizeState(JSON.parse(JSON.stringify(s)));
  const byId = Object.fromEntries(reloaded.tasks.map((t) => [t.id, taskProject(reloaded, t)]));
  assert.deepEqual(byId['t-a'], { projectRoot: '/work/proj-a', inferred: false });
  assert.deepEqual(byId['t-b'], { projectRoot: '/work/proj-b', inferred: false });
  assert.deepEqual(byId['t-null'], { projectRoot: null, inferred: false });
  assert.deepEqual(byId['t-unbound'], { projectRoot: null, inferred: false });
  assert.deepEqual(knownProjects(reloaded, '/work/cur'), ['/work/cur', '/work/proj-a', '/work/proj-b']);
});

test('legacy tasks without projectRoot infer only when sessionId matches current binding', () => {
  const raw = {
    bindings: {
      'group:wrGROUP': { sessionId: 'S-current', title: 'cur', projectRoot: '/work/current', boundAt: 50 },
    },
    chats: {
      'group:wrGROUP': { kind: 'group', target: 'wrGROUP', lastUserid: 'alice', lastText: 'hi', lastAt: 50 },
    },
    tasks: [
      { id: 'legacy-match', chatKey: 'group:wrGROUP', userid: 'alice', text: '1', status: 'replied', sessionId: 'S-current', createdAt: 10 },
      { id: 'legacy-rebound', chatKey: 'group:wrGROUP', userid: 'alice', text: '2', status: 'replied', sessionId: 'S-old', createdAt: 20 },
      { id: 'legacy-unbound', chatKey: 'group:wrGROUP', userid: 'alice', text: '3', status: 'unbound', createdAt: 30 },
    ],
  };
  const s = normalizeState(raw);
  assert.deepEqual(taskProject(s, s.tasks[0]), { projectRoot: '/work/current', inferred: true });
  assert.deepEqual(taskProject(s, s.tasks[1]), { projectRoot: null, inferred: false });
  assert.deepEqual(taskProject(s, s.tasks[2]), { projectRoot: null, inferred: false });

  unbind(s, 'group:wrGROUP');
  assert.deepEqual(taskProject(s, s.tasks[0]), { projectRoot: null, inferred: false });
});

test('snapshotData sends all retained tasks up to MAX_TASKS so project filtering is not starved by 30 recent tasks', () => {
  const s = aliceOnly();
  bind(s, 'group:wrGROUP', { sessionId: 'S1', title: 'p1', projectRoot: '/work/p1', boundAt: 1 });
  receive(s, groupMsg('early-p1', 'alice', '@bot p1 task'), { now: 1 });

  bind(s, 'group:wrGROUP', { sessionId: 'S2', title: 'p2', projectRoot: '/work/p2', boundAt: 2 });
  for (let i = 0; i < 45; i++) {
    receive(s, groupMsg(`later-p2-${i}`, 'alice', `@bot p2 ${i}`), { now: 10 + i });
  }

  const snap = snapshotData(s, { status: 'online' }, { sessionId: 'S1', projectRoot: '/work/p1' });
  assert.equal(snap.tasks.length, 46);
  const p1Tasks = snap.tasks.filter((t) => matchesProject(t.projectRoot, '/work/p1'));
  assert.equal(p1Tasks.length, 1);
  assert.equal(p1Tasks[0].id, 'early-p1');
  const unassigned = snap.tasks.filter((t) => matchesProject(t.projectRoot, '__unassigned__'));
  assert.equal(unassigned.length, 0);
});

// ---------------------------------------------------------------------------
// 0.1.23 sidebar projection: label / sessionRef / panelView
// ---------------------------------------------------------------------------

const need = (name) => {
  assert.equal(typeof core[name], 'function', `src/core.mjs must export ${name}()`);
  return core[name];
};
const single = (msgid, userid, content = 'hi') => ({ msgid, chattype: 'single', from: { userid }, msgtype: 'text', text: { content } });
const ONLINE = { status: 'online', botId: 'bot-1', detail: '' };

test('label resolves remark, then bot-scoped automatic name, then a kind-specific fallback', () => {
  const label = need('label');
  const s = emptyState();
  receive(s, single('m1', 'u1'), { now: 1, botId: 'bot-1' });
  mergeSessionNames(s, 'bot-1', [
    { chat_type: 'single', chat_id: 'u1', chat_name: '王五' },
    { chat_type: 'group', chat_id: 'g1', chat_name: '发布群' },
  ], 5);

  const auto = label(s, 'u1');
  assert.equal(auto.id, 'u1');
  assert.equal(auto.name, '王五');
  assert.equal(auto.source, 'auto');
  assert.ok(!auto.remark, 'no manual remark yet');
  assert.equal(label(s, 'g1', 'group').name, '发布群');

  setName(s, 'u1', '小王');
  assert.deepEqual(
    { name: label(s, 'u1').name, remark: label(s, 'u1').remark, source: label(s, 'u1').source },
    { name: '小王', remark: '小王', source: 'remark' },
  );

  const otherBot = label(s, 'g1', 'group', 'bot-2');
  assert.equal(otherBot.source, 'fallback', 'automatic names of another bot are never shown');
  assert.equal(otherBot.name, '群名未获取 g1');
  const longId = 'woFAKE0000000000000000000000user';
  assert.deepEqual({ ...label(s, longId) }, { id: longId, name: '姓名未获取 woFA…user', remark: label(s, longId).remark, source: 'fallback' });
});

test('sessionRef prefers live titles, then the stored binding title, then a short id, normalizing subagent ids', () => {
  const sessionRef = need('sessionRef');
  const titles = new Map([['S-live-0001', '迭代 修复'], ['S-empty-0002', '  ']]);
  const ref = sessionRef(titles, 'S-live-0001::subagent-7');

  assert.deepEqual(ref({ sessionId: 'S-live-0001', title: '旧标题', projectRoot: '/work/demo' }),
    { sessionId: 'S-live-0001', title: '迭代 修复', projectRoot: '/work/demo', isCurrent: true });
  assert.deepEqual(ref({ sessionId: 'S-empty-0002', title: '存储标题' }),
    { sessionId: 'S-empty-0002', title: '存储标题', projectRoot: null, isCurrent: false }, 'blank live title falls through');
  assert.deepEqual(ref({ sessionId: 'abcdef0123456789', title: '' }),
    { sessionId: 'abcdef0123456789', title: '会话 abcdef01', projectRoot: null, isCurrent: false });
  const sub = ref({ sessionId: 'S-live-0001::subagent-2', title: '' });
  assert.equal(sub.sessionId, 'S-live-0001');
  assert.equal(sub.title, '迭代 修复');
  assert.equal(sub.isCurrent, true);
});

test('panelView chats are the unified target catalog: discovered chats are visible and bindable before anyone @s the bot', () => {
  const panelView = need('panelView');
  const s = emptyState();
  receive(s, groupMsg('m1', 'li', '@bot 早'), { now: 10, botId: 'bot-1' });
  receive(s, single('m2', 'stranger'), { now: 20, botId: 'bot-2' });
  mergeSessionNames(s, 'bot-1', [
    { chat_type: 'group', chat_id: 'wrNEW', chat_name: '新发现群' },
    { chat_type: 'single', chat_id: 'u9', chat_name: '王五' },
  ], 30);

  const view = panelView(s, ONLINE, { sessionId: 'S-alpha', projectRoot: '/work/alpha' }, new Map());
  const keys = view.chats.map((c) => c.chatKey);
  assert.deepEqual([...keys].sort(), targetCatalog(s, 'bot-1').map((t) => t.chatKey).sort());
  assert.ok(!keys.includes('single:stranger'), 'chats of another bot are excluded');
  assert.equal(keys[0], 'group:wrGROUP', 'most recent activity first');
  assert.deepEqual(keys.slice(1), ['group:wrNEW', 'single:u9'], 'no activity: ordered by chatKey');

  const inbound = view.chats.find((c) => c.chatKey === 'group:wrGROUP');
  assert.equal(inbound.origin, 'inbound');
  assert.equal(inbound.kind, 'group');
  assert.equal(inbound.last.at, 10);
  assert.equal(inbound.last.text, '早');
  assert.equal(inbound.last.sender.id, 'li');
  assert.equal(inbound.route, null);
  assert.equal(inbound.projectRoot, null);
  assert.equal(inbound.settings, null);

  const discovered = view.chats.find((c) => c.chatKey === 'group:wrNEW');
  assert.equal(discovered.origin, 'discovered');
  assert.equal(discovered.label.name, '新发现群');
  assert.equal(discovered.label.source, 'auto');
  assert.equal(discovered.last, null);
  assert.deepEqual(discovered.members, []);
  assert.equal(view.chats.find((c) => c.chatKey === 'single:u9').origin, 'discovered');

  assert.deepEqual(view.counts, { chats: 3, unboundChats: 3, active: 0, attention: 2 }, 'both unbound messages need attention');
  assert.deepEqual(view.conn, { status: 'online', botId: 'bot-1', detail: '' });
  assert.deepEqual(view.names, { updatedAt: 30 });
  assert.deepEqual(view.access, { mode: 'blocklist' });

  const fallback = panelView(s, null, null);
  assert.deepEqual(fallback.conn, { status: 'idle', botId: 'bot-1', detail: '' }, 'botId falls back to the name scope');
  assert.equal(panelView(s, { status: 'online', botId: 'bot-2' }, null).names.updatedAt, 0, 'names of another bot are not reported as synced');
});

test('panelView current session lists every WeCom source routed into it and its outbound reach; sessionless views keep outbound.mode', () => {
  const panelView = need('panelView');
  const s = emptyState();
  receive(s, groupMsg('m1', 'li', '@bot a'), { now: 1, botId: 'bot-1' });
  receive(s, { ...groupMsg('m2', 'li', '@bot b'), chatid: 'wrOTHER' }, { now: 2, botId: 'bot-1' });
  setName(s, 'wrGROUP', '研发群');
  setName(s, 'wrOTHER', '运营群');
  setName(s, 'li', '李四');
  bind(s, 'group:wrGROUP', { sessionId: 'S-alpha', title: '存储的 Alpha', projectRoot: '/work/alpha', boundAt: 1 });
  bind(s, 'group:wrOTHER', { sessionId: 'S-ops', title: 'Ops', projectRoot: '/work/ops', boundAt: 1 });
  bindMember(s, 'group:wrOTHER', 'li', { sessionId: 'S-alpha', title: '存储的 Alpha', projectRoot: '/work/alpha', boundAt: 2 });

  const live = panelView(s, ONLINE, { sessionId: 'S-alpha::sub', projectRoot: '/work/alpha' }, new Map([['S-alpha', 'Alpha 实时标题']]));
  assert.equal(live.current.sessionId, 'S-alpha');
  assert.equal(live.current.title, 'Alpha 实时标题');
  assert.equal(live.current.projectRoot, '/work/alpha');
  assert.equal(live.current.routes.length, 2);
  assert.deepEqual(live.current.routes.find((r) => r.kind === 'group'),
    { chatKey: 'group:wrGROUP', kind: 'group', chatName: '研发群', memberName: '', userid: null });
  assert.deepEqual(live.current.routes.find((r) => r.kind === 'member'),
    { chatKey: 'group:wrOTHER', kind: 'member', chatName: '运营群', memberName: '李四', userid: 'li' });
  assert.equal(live.current.reach.scope, 'bound', 'a session that receives WeCom work is restricted by default');
  assert.equal(live.current.reach.why, 'exposed');
  assert.equal(live.current.reach.boundCount, 2);

  assert.equal(panelView(s, ONLINE, { sessionId: 'S-alpha' }, new Map()).current.title, '存储的 Alpha', 'stored binding title when no live title');
  const blank = panelView(s, ONLINE, { sessionId: '0123456789abcdef' }, new Map());
  assert.equal(blank.current.title, '会话 01234567');
  assert.deepEqual(blank.current.routes, []);
  assert.equal(blank.current.projectRoot, null);

  const sessionless = panelView(s, ONLINE, null, new Map());
  assert.equal(sessionless.current, null);
  assert.equal(sessionless.outbound.mode, 'local-sessions');
  assert.equal(panelView(s, ONLINE, { sessionId: '  ' }).current, null);
});

test('panelView chat settings exist only for chats routed to the current session; docs need a 1-to-1 session', () => {
  const panelView = need('panelView');
  const s = emptyState();
  receive(s, single('m1', 'u'), { now: 3, botId: 'bot-1' });
  receive(s, single('m2', 'v'), { now: 2, botId: 'bot-1' });
  receive(s, groupMsg('m3', 'li', '@bot x'), { now: 1, botId: 'bot-1' });
  s.chats['group:wrGROUP'].userids = ['li', 'zhang'];
  bind(s, 'single:u', { sessionId: 'S-alpha', title: 'Alpha', projectRoot: '/work/alpha', boundAt: 1 });
  bind(s, 'group:wrGROUP', { sessionId: 'S-alpha', title: 'Alpha', projectRoot: '/work/alpha', boundAt: 1 });
  bind(s, 'single:v', { sessionId: 'S-beta', title: 'Beta', projectRoot: '/work/beta', boundAt: 1 });
  s.bindings['single:u'].sameMessageReply = true;
  bindMember(s, 'group:wrGROUP', 'li', { sessionId: 'S-gamma', title: 'Gamma', projectRoot: null, boundAt: 2 });

  const ctx = { sessionId: 'S-alpha', projectRoot: '/work/alpha' };
  const view = panelView(s, ONLINE, ctx, new Map());
  const byKey = Object.fromEntries(view.chats.map((c) => [c.chatKey, c]));
  for (const c of view.chats) assert.equal(c.settings !== null, c.route?.isCurrent === true, `${c.chatKey}: settings iff routed here`);

  assert.deepEqual(byKey['single:u'].route, { sessionId: 'S-alpha', title: 'Alpha', projectRoot: '/work/alpha', isCurrent: true });
  assert.equal(byKey['single:u'].projectRoot, '/work/alpha');
  assert.deepEqual(byKey['single:u'].settings, { sameMessageReply: true, docs: null, docsAvailable: false });
  assert.equal(byKey['group:wrGROUP'].settings.sameMessageReply, null, 'same-message reply is private-chat only');
  assert.equal(byKey['single:v'].settings, null);
  assert.equal(byKey['single:v'].route.isCurrent, false);
  assert.equal(byKey['single:v'].origin, 'inbound');

  const groupMembers = byKey['group:wrGROUP'].members;
  assert.deepEqual(groupMembers.map((m) => m.label.id).sort(), ['li', 'zhang']);
  assert.equal(groupMembers.find((m) => m.label.id === 'li').override.sessionId, 'S-gamma');
  assert.equal(groupMembers.find((m) => m.label.id === 'li').override.isCurrent, false);
  assert.equal(groupMembers.find((m) => m.label.id === 'zhang').override, null);

  unbind(s, 'group:wrGROUP');
  s.bindings['single:u'].browserDocuments = { botId: 'bot-1', scope: 'listed', paths: ['/sheet/a'] };
  const sole = panelView(s, ONLINE, ctx, new Map()).chats.find((c) => c.chatKey === 'single:u');
  assert.deepEqual(sole.settings, { sameMessageReply: true, docs: { scope: 'listed', paths: ['/sheet/a'] }, docsAvailable: true });

  receive(s, groupMsg('m4', 'li', '@bot y'), { now: 4, botId: 'bot-1' });
  bind(s, 'group:wrGROUP', { sessionId: 'S-beta', title: 'Beta', projectRoot: '/work/beta', boundAt: 3 });
  bindMember(s, 'group:wrGROUP', 'li', { sessionId: 'S-alpha', title: 'Alpha', projectRoot: '/work/alpha', boundAt: 4 });
  const shared = panelView(s, ONLINE, ctx, new Map()).chats.find((c) => c.chatKey === 'single:u');
  assert.equal(shared.settings.docsAvailable, false, 'a member override routed here also breaks the 1-to-1 rule');
});

test('panelView tasks are bucketed for the user and carry the one-click fix that would unblock them', () => {
  const panelView = need('panelView');
  const s = { ...emptyState(), access: { mode: 'allowlist', allow: ['alice'], block: ['eve'] } };
  receive(s, single('t-mallory', 'mallory'), { now: 1, botId: 'bot-1' });
  receive(s, single('t-eve', 'eve'), { now: 2, botId: 'bot-1' });
  receive(s, single('t-unbound', 'alice'), { now: 3, botId: 'bot-1' });
  bind(s, 'group:wrGROUP', { sessionId: 'S-alpha', title: 'Alpha 存储', projectRoot: '/work/alpha', boundAt: 4 });
  receive(s, groupMsg('t-pending', 'alice', '@bot p'), { now: 5, botId: 'bot-1' });
  receive(s, groupMsg('t-queued', 'alice', '@bot q'), { now: 6, botId: 'bot-1' });
  markInjected(s, 't-queued', 6);
  receive(s, groupMsg('t-replied', 'alice', '@bot r'), { now: 7, botId: 'bot-1' });
  markInjected(s, 't-replied', 7);
  receive(s, groupMsg('t-sendfail', 'alice', '@bot s'), { now: 8, botId: 'bot-1' });
  markInjected(s, 't-sendfail', 8);
  markInjected(s, 't-pending', 8);
  // settle replies everything queued in S-alpha; re-open t-pending/t-queued afterwards
  settle(s, 'S-alpha', '完成了', 9);
  markSendFailed(s, ['t-sendfail'], 'errcode=93000');
  for (const id of ['t-pending', 't-queued']) Object.assign(s.tasks.find((t) => t.id === id), { status: id === 't-pending' ? 'pending' : 'queued', reply: undefined });
  receive(s, groupMsg('t-failed', 'alice', '@bot f'), { now: 10, botId: 'bot-1' });
  markInjected(s, 't-failed', 10, '会话已关闭');
  receive(s, { ...groupMsg('t-gone', 'alice', '@bot g'), chatid: 'wrGONE' }, { now: 11, botId: 'bot-1' });
  bind(s, 'group:wrGONE', { sessionId: 'abcdef0123456789', title: '', projectRoot: null, boundAt: 11 });
  Object.assign(s.tasks.at(-1), { status: 'replied', sessionId: 'abcdef0123456789', reply: 'ok' });
  unbind(s, 'group:wrGONE');

  const view = panelView(s, ONLINE, { sessionId: 'S-alpha' }, new Map([['S-alpha', 'Alpha 实时']]));
  const byId = Object.fromEntries(view.tasks.map((t) => [t.id, t]));
  assert.equal(view.tasks[0].id, 't-gone', 'newest first');
  assert.equal(view.tasks.length, s.tasks.length);

  assert.deepEqual([byId['t-pending'].bucket, byId['t-queued'].bucket], ['active', 'active']);
  assert.equal(byId['t-replied'].bucket, 'done');
  assert.equal(byId['t-replied'].reply, '完成了');
  assert.equal(byId['t-replied'].sendError, '');
  assert.equal(byId['t-sendfail'].status, 'replied');
  assert.equal(byId['t-sendfail'].bucket, 'attention', 'a reply that never reached WeCom needs attention');
  assert.equal(byId['t-sendfail'].sendError, 'errcode=93000');
  assert.equal(byId['t-failed'].bucket, 'attention');
  assert.equal(byId['t-failed'].error, '会话已关闭');

  assert.equal(byId['t-mallory'].fix, 'allowSender');
  assert.equal(byId['t-eve'].fix, 'unblockSender');
  assert.equal(byId['t-unbound'].fix, 'bindChat');
  for (const id of ['t-mallory', 't-eve', 't-unbound']) assert.equal(byId[id].bucket, 'attention');
  for (const id of ['t-pending', 't-replied', 't-sendfail', 't-failed']) assert.equal(byId[id].fix, null, `${id} has no one-click fix`);

  assert.deepEqual(byId['t-pending'].chat, { chatKey: 'group:wrGROUP', kind: 'group', name: '群名未获取 wrGROUP' });
  assert.equal(byId['t-pending'].sender.id, 'alice');
  assert.deepEqual(byId['t-pending'].session, { sessionId: 'S-alpha', title: 'Alpha 实时', projectRoot: '/work/alpha', isCurrent: true });
  assert.equal(byId['t-pending'].projectRoot, '/work/alpha');
  assert.equal(byId['t-pending'].inferred, false);
  assert.equal(byId['t-pending'].text, 'p');
  assert.equal(byId['t-gone'].session.title, '会话 abcdef01');
  assert.equal(byId['t-gone'].session.isCurrent, false);
  assert.equal(byId['t-unbound'].session ?? null, null);
  assert.equal(view.counts.active, 2);
  assert.equal(view.counts.attention, 5);

  const people = Object.fromEntries(view.people.map((p) => [p.label.id, p]));
  assert.deepEqual({ ...people.eve, label: undefined }, { label: undefined, canAssign: false, allowed: false, blocked: true });
  assert.deepEqual({ ...people.alice, label: undefined }, { label: undefined, canAssign: true, allowed: true, blocked: false });
  assert.equal(view.access.mode, 'allowlist');

  setListed(s, 'allow', 'mallory', true);
  setListed(s, 'block', 'eve', false);
  bind(s, 'single:alice', { sessionId: 'S-alpha', title: 'Alpha', projectRoot: null, boundAt: 12 });
  const after = Object.fromEntries(panelView(s, ONLINE, null).tasks.map((t) => [t.id, t]));
  assert.equal(after['t-mallory'].fix, null, 'allowed sender no longer needs a fix');
  assert.equal(after['t-eve'].fix, 'allowSender', 'unblocked but still not on the allowlist');
  assert.equal(after['t-unbound'].fix, null, 'chat is bound now');
  assert.equal(after['t-unbound'].bucket, 'attention', 'history stays honest: the task itself was not delivered');
});

test('panelView preserves legacy scope-less browser grants as listed and includes discovered DM users in people', () => {
  const panelView = need('panelView');
  const s = emptyState();
  bind(s, 'single:u', { sessionId: 'S-alpha', title: 'Alpha', projectRoot: '/work/alpha', boundAt: 1 });
  s.bindings['single:u'].browserDocuments = { botId: 'bot-1', paths: ['/sheet/legacy'] };
  mergeSessionNames(s, 'bot-1', [{ chat_type: 'single', chat_id: 'u-disc', chat_name: '孙七' }], 10);

  const view = panelView(s, ONLINE, { sessionId: 'S-alpha', projectRoot: '/work/alpha' }, new Map());
  assert.deepEqual(view.chats.find((c) => c.chatKey === 'single:u').settings.docs, { scope: 'listed', paths: ['/sheet/legacy'] });
  assert.equal(view.people.find((p) => p.label.id === 'u-disc')?.label.name, '孙七');
  setListed(s, 'block', 'u-disc', true);
  assert.equal(panelView(s, ONLINE, { sessionId: 'S-alpha' }).people.find((p) => p.label.id === 'u-disc')?.blocked, true);
});
