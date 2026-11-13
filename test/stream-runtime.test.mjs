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

test('runtime enables only the selected DM, updates waiting/final/error messages and keeps groups unchanged', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-stream-runtime-'));
  const originalClient = AiBot.WSClient;
  const originalFetch = globalThis.fetch;
  const handlers = new Map();
  const events = new Map();
  const replies = [];
  const pushes = [];
  let client;
  let injectError = false;
  let instant = false;
  const state = emptyState();
  for (const key of ['single:u', 'single:other', 'group:g']) state.bindings[key] = { sessionId: key, title: key };
  await writeFile(join(dataDir, 'state.json'), JSON.stringify(state));
  AiBot.WSClient = class extends EventEmitter {
    constructor() { super(); client = this; this.isConnected = true; }
    connect() { this.emit('authenticated'); }
    disconnect() {}
    async replyStream(frame, id, text, finish) { replies.push({ req: frame.headers.req_id, id, text, finish }); }
    async sendMessage(chat, body) { pushes.push({ chat, body }); }
  };
  globalThis.fetch = async url => new Response(JSON.stringify(url.endsWith('get_cli_config') ? { token: 'test-token' } : { sessions: [] }));
  const until = async predicate => {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('runtime did not reach expected state');
  };
  const snapshot = () => handlers.get('snapshot')({}, {});
  const emit = (id, chatKey) => client.emit('message', {
    headers: { req_id: id }, body: { msgid: id, chattype: chatKey.startsWith('group:') ? 'group' : 'single', chatid: 'g',
      from: { userid: chatKey.startsWith('group:') ? 'u' : chatKey.slice(7) }, msgtype: 'text', text: { content: '测试' } },
  });
  try {
    activate({
      dataDir, config: { get: async () => ({ botId: 'test', secret: 'fake' }) },
      tools: { register() {} }, renderer: { handle: (name, fn) => handlers.set(name, fn) },
      events: { on: (name, fn) => events.set(name, fn) },
      session: { inject: async ({ sessionId }) => {
        if (injectError) throw new Error('inject failed');
        if (instant) await events.get('agent_end')({ text: '立即完成' }, { sessionId });
      } },
    });
    await until(() => client);
    await assert.rejects(handlers.get('setSameMessageReply')({ chatKey: 'group:g', enabled: true }, { sessionId: 'group:g' }), /私聊试用/);
    await assert.rejects(handlers.get('setSameMessageReply')({ chatKey: 'single:u', enabled: true }, { sessionId: 'wrong' }), /私聊试用/);
    await handlers.get('setSameMessageReply')({ chatKey: 'single:u', enabled: true }, { sessionId: 'single:u' });
    assert.equal(JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')).bindings['single:u'].sameMessageReply, true);
    emit('dm1', 'single:u');
    await until(async () => (await snapshot()).tasks.some(t => t.id === 'dm1' && t.status === 'queued'));
    await events.get('session_status')({ sessionId: 'single:u', state: 'waiting', previous: 'running', pendingApprovals: 1 });
    await events.get('agent_end')({ text: '完成' }, { sessionId: 'single:u' });
    assert.equal(replies[0].text, '<think></think>');
    assert.match(replies[1].text, /^<think>.*审批工具调用.*<\/think>$/);
    assert.equal(replies[2].text, '完成');
    assert.deepEqual(replies.map(r => r.finish), [false, false, true]);
    assert.equal(new Set(replies.map(r => r.id)).size, 1);
    assert.equal(pushes.length, 0);
    for (const key of ['single:other', 'group:g']) {
      emit(key, key);
      await until(() => replies.some(r => r.req === key));
      assert.equal(replies.find(r => r.req === key).finish, true);
      await events.get('agent_end')({ text: '普通结果' }, { sessionId: key });
    }
    assert.equal(pushes.length, 2);
    injectError = true;
    emit('failed', 'single:u');
    await until(() => replies.some(r => r.req === 'failed' && r.finish));
    assert.match(replies.at(-1).text, /转交 EnsoCode 失败/);
    assert.equal((await snapshot()).tasks.find(t => t.id === 'failed').status, 'failed');
    injectError = false;
    instant = true;
    emit('instant', 'single:u');
    await until(() => replies.some(r => r.req === 'instant' && r.finish));
    assert.equal(replies.at(-1).text, '立即完成');
    assert.equal(pushes.length, 2);
    instant = false;
    emit('error', 'single:u');
    await until(async () => (await snapshot()).tasks.some(t => t.id === 'error' && t.status === 'queued'));
    await events.get('session_status')({ sessionId: 'single:u', state: 'error', previous: 'running' });
    assert.equal(replies.at(-1).finish, true);
    assert.match(replies.at(-1).text, /出错/);
    assert.equal(pushes.length, 2);
  } finally {
    deactivate();
    AiBot.WSClient = originalClient;
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});
