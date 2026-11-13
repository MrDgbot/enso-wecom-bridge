import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AiBot from '@wecom/aibot-node-sdk';
import { activate, deactivate } from '../src/main.mjs';
import { bind, emptyState, normalizeState, receive, snapshotData } from '../src/core.mjs';
import { requireBrowserGrant } from '../src/browser-document.mjs';
import { listTargets, outboundSummary } from '../src/outbound.mjs';
import './no-tunnel.mjs';

async function runtime(state, sessions, botId = 'bot') {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-direct-send-'));
  await writeFile(join(dataDir, 'state.json'), JSON.stringify(state));
  const originalClient = AiBot.WSClient, originalFetch = globalThis.fetch;
  const handlers = new Map(), pushes = [];
  let client = null;
  AiBot.WSClient = class extends EventEmitter {
    constructor() { super(); client = this; this.isConnected = true; }
    connect() { this.emit('authenticated'); }
    disconnect() {}
    async replyStream() {}
    async sendMessage(chat, body) { pushes.push({ chat, text: body.markdown.content }); }
  };
  globalThis.fetch = async (url) => new Response(JSON.stringify(url.endsWith('get_cli_config')
    ? { token: 'test-token' } : { results_json: JSON.stringify({ result: { sessions } }) }));
  activate({
    dataDir, config: { get: async () => ({ botId, secret: 'fake' }) },
    tools: { register: (name, fn) => handlers.set(name, fn) },
    renderer: { handle: (name, fn) => handlers.set(name, fn) },
    events: { on() {} },
    session: { list: async () => ({ sessions: [] }), inject: async () => {} },
  });
  for (let i = 0; i < 100 && !client; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  return {
    pushes,
    call: (name, args, ctx) => handlers.get(name)(args, ctx),
    send: (args, ctx) => handlers.get('send_reply')({ confirmed: true, text: '对齐链接 https://doc.weixin.qq.com/sheet/x', ...args }, ctx),
    targets: async (args, ctx) => JSON.parse((await handlers.get('reply_targets')(args, ctx)).content),
    saved: async () => JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')),
    async close() {
      deactivate();
      AiBot.WSClient = originalClient;
      globalThis.fetch = originalFetch;
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

const groupBoundToB = () => {
  const state = emptyState();
  state.chats['group:g'] = { kind: 'group', target: 'g', lastUserid: 'li', userids: ['li'], lastAt: 5 };
  state.names.g = '研发群';
  bind(state, 'group:g', { sessionId: 'B', title: 'B', projectRoot: '/B', browserDocuments: { botId: 'bot', scope: 'all', paths: [] } });
  return state;
};
const demo = { chat_type: 'group', chat_id: 'demo', chat_name: '需求对齐群' };

test('an unbound local session sends to a group known only from the session list, by name, without touching routing', async () => {
  const rt = await runtime(groupBoundToB(), [demo]);
  try {
    const before = await rt.saved();
    const found = await rt.targets({ query: '需求对齐群' }, { sessionId: '梳理业务' });
    assert.deepEqual(found, [{ chatKey: 'group:demo', name: '需求对齐群', kind: 'group', bound: false }]);

    const reply = await rt.send({ chatKey: '需求对齐群', requestId: 'demo-001' }, { sessionId: '梳理业务::view' });
    assert.match(reply.content, /需求对齐群/);
    assert.deepEqual(rt.pushes.map((p) => p.chat), ['demo']);
    assert.match(rt.pushes[0].text, /doc\.weixin\.qq\.com/);

    await rt.send({ chatKey: '需求对齐群', requestId: 'demo-001' }, { sessionId: '梳理业务' });
    assert.equal(rt.pushes.length, 1, 'same requestId from the root session is not sent twice');

    const after = await rt.saved();
    assert.deepEqual(after.bindings, before.bindings);
    assert.deepEqual(after.memberBindings, before.memberBindings);
    assert.equal(requireBrowserGrant(after, 'B', 'bot', 'https://doc.weixin.qq.com/sheet/x').chatKey, 'group:g');
    assert.equal(outboundSummary(normalizeState(after, { botId: 'bot' }), '梳理业务', 'bot').scope, 'any', 'sending does not expose the session');
  } finally { await rt.close(); }
});

test('duplicate group names are never guessed; the exact chatKey with the same requestId then sends once', async () => {
  const state = emptyState();
  state.names = { g1: '周会', g2: '周会' };
  for (const id of ['g1', 'g2']) state.chats[`group:${id}`] = { kind: 'group', target: id, lastUserid: 'li' };
  const rt = await runtime(state, []);
  try {
    await assert.rejects(rt.send({ chatKey: '周会群', requestId: 'weekly-0001' }, { sessionId: 'L' }), (error) => {
      assert.match(error.message, /多个/);
      assert.match(error.message, /group:g1/);
      assert.match(error.message, /group:g2/);
      return true;
    });
    assert.equal(rt.pushes.length, 0);
    await rt.send({ chatKey: 'group:g2', requestId: 'weekly-0001' }, { sessionId: 'L' });
    assert.deepEqual(rt.pushes.map((p) => p.chat), ['g2']);
    await assert.rejects(rt.send({ chatKey: '不存在的群', requestId: 'weekly-0002' }, { sessionId: 'L' }), /未找到/);
  } finally { await rt.close(); }
});

test('a session that ever received WeCom work stays limited to its own targets until the operator widens the policy', async () => {
  const rt = await runtime(groupBoundToB(), [demo]);
  const ctx = { sessionId: 'B' };
  try {
    assert.deepEqual((await rt.targets({}, ctx)).map((t) => t.chatKey), ['group:g']);
    await assert.rejects(rt.send({ chatKey: '需求对齐群', requestId: 'exposed-001' }, ctx), /禁止跨会话/);
    await rt.call('unbind', { chatKey: 'group:g' }, ctx);
    await assert.rejects(rt.send({ chatKey: '需求对齐群', requestId: 'exposed-002' }, ctx), /禁止跨会话/, 'unbinding does not lift the restriction');
    assert.equal(rt.pushes.length, 0);

    const widened = await rt.call('setOutboundMode', { mode: 'all-sessions' }, ctx);
    assert.equal(widened.outbound.scope, 'any');
    await rt.send({ chatKey: '需求对齐群', requestId: 'exposed-003' }, ctx);
    assert.deepEqual(rt.pushes.map((p) => p.chat), ['demo']);

    await rt.call('setOutboundMode', { mode: 'bound-only' }, ctx);
    await assert.rejects(rt.send({ chatKey: '需求对齐群', requestId: 'local-0001' }, { sessionId: 'L' }), /禁止跨会话/);
    await assert.rejects(rt.call('setOutboundMode', { mode: 'everyone' }, ctx), /未知/);
    assert.equal((await rt.saved()).outbound.mode, 'bound-only');
  } finally { await rt.close(); }
});

test('exposure is restored from stored bindings and tasks and survives losing both', () => {
  const s = normalizeState({ tasks: [{ id: 't', chatKey: 'single:u', userid: 'u', status: 'replied', sessionId: 'T::sub' }] });
  assert.equal(outboundSummary(s, 'T').scope, 'bound');
  assert.equal(outboundSummary(s, 'fresh').scope, 'any');
  bind(s, 'single:u', { sessionId: 'U' });
  delete s.bindings['single:u'];
  assert.equal(outboundSummary(s, 'U').why, 'exposed');
  bind(s, 'single:v', { sessionId: 'V' });
  const r = receive(s, { msgid: 'm', chattype: 'single', from: { userid: 'v' }, msgtype: 'text', text: { content: 'hi' } }, { now: 1 });
  assert.equal(r.decision, 'inject');
  const reloaded = normalizeState(JSON.parse(JSON.stringify({ ...s, bindings: {}, tasks: [] })));
  assert.equal(snapshotData(reloaded, { status: 'online' }, { sessionId: 'V' }).outbound.why, 'exposed');
  assert.equal(snapshotData(reloaded, { status: 'online' }, { sessionId: 'fresh' }).outbound.scope, 'any');
});

test('targets of another bot are excluded and a malformed stored policy fails closed', () => {
  const raw = { chats: { 'group:a': { kind: 'group', target: 'a', botId: 'bot-A' } }, autoNames: { botId: 'bot-A', users: {}, groups: { a: 'A 群' } } };
  assert.deepEqual(listTargets(normalizeState(raw, { botId: 'bot-A' }), 'L', { botId: 'bot-A' }).map((t) => t.chatKey), ['group:a']);
  assert.deepEqual(listTargets(normalizeState(raw, { botId: 'bot-B' }), 'L', { botId: 'bot-B' }), []);

  const legacy = { chats: { 'group:old': { kind: 'group', target: 'old' } }, autoNames: { botId: 'bot-A', users: {}, groups: {} } };
  assert.deepEqual(listTargets(normalizeState(legacy, { botId: 'bot-A' }), 'L', { botId: 'bot-A' }).map((t) => t.chatKey), ['group:old']);
  assert.deepEqual(listTargets(normalizeState(legacy, { botId: 'bot-B' }), 'L', { botId: 'bot-B' }), []);

  const known = { chats: { 'group:x': { kind: 'group', target: 'x' } } };
  assert.equal(normalizeState(known).outbound.mode, 'local-sessions');
  const broken = normalizeState({ ...known, outbound: { mode: 'wide-open' } });
  assert.equal(broken.outbound.mode, 'bound-only');
  assert.deepEqual(listTargets(broken, 'L'), []);
  assert.deepEqual(listTargets(normalizeState(known), 'L').map((t) => t.chatKey), ['group:x']);
});
