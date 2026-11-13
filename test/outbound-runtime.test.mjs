import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AiBot from '@wecom/aibot-node-sdk';
import { activate, deactivate } from '../src/main.mjs';
import { emptyState } from '../src/core.mjs';
import './no-tunnel.mjs';

test('runtime routes group members separately and explicit follow-up sends are scoped, deduplicated and failure-aware', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-outbound-'));
  const originalClient = AiBot.WSClient, originalFetch = globalThis.fetch;
  const handlers = new Map(), events = new Map();
  const pushes = [], injections = [], acknowledgements = [];
  let client, fail = false;
  const state = emptyState();
  state.chats['group:g'] = { kind: 'group', target: 'g', lastUserid: 'li' };
  state.bindings['group:g'] = { sessionId: 'B', title: 'B', projectRoot: '/B' };
  state.bindings['single:li'] = { sessionId: 'A', title: 'A' };
  await writeFile(join(dataDir, 'state.json'), JSON.stringify(state));
  AiBot.WSClient = class extends EventEmitter {
    constructor() { super(); client = this; this.isConnected = true; }
    connect() { this.emit('authenticated'); }
    disconnect() {}
    async replyStream(frame) { acknowledgements.push(frame.headers.req_id); }
    async sendMessage(chat, body) { if (fail) throw new Error('timeout'); pushes.push({ chat, body }); }
  };
  globalThis.fetch = async url => new Response(JSON.stringify(url.endsWith('get_cli_config')
    ? { token: 'test-token' } : { results_json: JSON.stringify({ result: { sessions: [] } }) }));
  const until = async predicate => {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('runtime did not reach expected state');
  };
  const host = {
    dataDir, config: { get: async () => ({ botId: 'bot', secret: 'fake' }) },
    tools: { register: (name, fn) => handlers.set(name, fn) },
    renderer: { handle: (name, fn) => handlers.set(name, fn) },
    events: { on: (name, fn) => events.set(name, fn) },
    session: { list: async () => ({ sessions: ['A', 'B', 'C'].map(id => ({ id, title: id })) }), inject: async input => injections.push(input) },
  };
  const emit = (id, userid, group = true) => client.emit('message', { headers: { req_id: id }, body: {
    msgid: id, chattype: group ? 'group' : 'single', chatid: 'g', from: { userid }, msgtype: 'text', text: { content: '检查代码' },
  } });
  try {
    activate(host);
    await until(() => client);
    await handlers.get('bindMember')({ chatKey: 'group:g', userid: 'li' }, { sessionId: 'C', projectRoot: '/C' });
    emit('li-group', 'li');
    emit('zhang-group', 'zhang');
    emit('li-dm', 'li', false);
    await until(() => acknowledgements.length === 3);
    assert.deepEqual(injections.map(i => i.sessionId).sort(), ['A', 'B', 'C']);
    const args = { chatKey: 'group:g', text: '补充一条已核实的结论', requestId: 'followup-001', confirmed: true };
    const send = (...a) => handlers.get('send_reply')(...a);
    await assert.rejects(send(args, { sessionId: 'C' }), /自动回传/);
    await events.get('agent_end')({ text: 'C 的结果' }, { sessionId: 'C' });
    assert.equal(pushes.at(-1).chat, 'g');
    await events.get('agent_end')({ text: '本地讨论不外发' }, { sessionId: 'C' });
    assert.equal(pushes.length, 1);
    await events.get('agent_end')({ text: 'B 的结果' }, { sessionId: 'B' });
    await events.get('agent_end')({ text: 'A 的结果' }, { sessionId: 'A' });
    assert.deepEqual(pushes.map(p => p.chat), ['g', 'g', 'li']);
    await assert.rejects(send({ ...args, confirmed: false }, { sessionId: 'C' }), /明确要求/);
    await assert.rejects(send(args, { sessionId: 'A' }), /禁止跨会话/);
    await assert.rejects(send(args, { sessionId: 'C', agent: { kind: 'subagent' } }), /主会话/);
    await assert.rejects(send({ ...args, text: '字'.repeat(1400) }, { sessionId: 'C' }), /4000/);
    await assert.rejects(send(args, { sessionId: 'C', signal: AbortSignal.abort() }), /取消/);
    const targets = JSON.parse((await handlers.get('reply_targets')({}, { sessionId: 'C' })).content);
    assert.deepEqual(targets.map(t => t.chatKey), ['group:g']);
    await Promise.all([send(args, { sessionId: 'C' }), send(args, { sessionId: 'C' })]);
    assert.equal(pushes.length, 4);
    await events.get('agent_end')({ text: '已发送' }, { sessionId: 'C' });
    assert.equal(pushes.length, 4);
    await assert.rejects(send({ ...args, text: '换正文' }, { sessionId: 'C' }), /不同消息/);
    deactivate();
    client = null;
    activate(host);
    await until(() => client);
    await send(args, { sessionId: 'C' });
    assert.equal(pushes.length, 4);
    fail = true;
    await assert.rejects(send({ ...args, requestId: 'followup-002' }, { sessionId: 'C' }), /结果不确定/);
    fail = false;
    await assert.rejects(send({ ...args, requestId: 'followup-002' }, { sessionId: 'C' }), /结果不确定/);
    assert.equal(pushes.length, 4);
    assert.equal(JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')).outbox.at(-1).status, 'unknown');
    await handlers.get('resetMember')({ chatKey: 'group:g', userid: 'li' }, { sessionId: 'C' });
    await assert.rejects(send({ ...args, requestId: 'followup-003' }, { sessionId: 'C' }), /禁止跨会话/);
    emit('li-default', 'li');
    await until(() => acknowledgements.includes('li-default'));
    assert.equal(injections.at(-1).sessionId, 'B');
  } finally {
    deactivate();
    AiBot.WSClient = originalClient;
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});
