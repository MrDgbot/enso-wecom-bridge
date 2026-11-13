import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AiBot from '@wecom/aibot-node-sdk';
import { activate, deactivate } from '../src/main.mjs';
import { emptyState } from '../src/core.mjs';
import './no-tunnel.mjs';

test('renaming an Enso session refreshes acknowledgements and sidebar without rebinding', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-title-'));
  const originalClient = AiBot.WSClient;
  const originalFetch = globalThis.fetch;
  const handlers = new Map();
  const signals = new EventEmitter();
  let client;
  let title = '迭代三期';
  let unavailable = false;
  const injected = [];
  const state = emptyState();
  state.bindings['group:g'] = { sessionId: 'session-1', title: '问候与开场', projectRoot: '/demo', boundAt: 123, browserDocuments: { scope: 'all', botId: 'test' } };
  await writeFile(join(dataDir, 'state.json'), JSON.stringify(state));
  AiBot.WSClient = class extends EventEmitter {
    constructor() { super(); client = this; this.isConnected = true; }
    connect() { this.emit('authenticated'); signals.emit('ready'); }
    disconnect() {}
    async replyStream(frame, id, text) { signals.emit('reply', text); }
  };
  globalThis.fetch = async url => new Response(JSON.stringify(url.endsWith('get_cli_config') ? { token: 'fake-token' } : { sessions: [] }));
  const message = async id => {
    const reply = once(signals, 'reply', { signal: AbortSignal.timeout(2000) });
    client.emit('message', { headers: { req_id: id }, body: { msgid: id, chattype: 'group', chatid: 'g', from: { userid: 'u' }, msgtype: 'text', text: { content: '测试' } } });
    return (await reply)[0];
  };
  try {
    const ready = once(signals, 'ready');
    activate({
      dataDir, config: { get: async () => ({ botId: 'test', secret: 'fake' }) },
      tools: { register() {} }, renderer: { handle: (name, fn) => handlers.set(name, fn) }, events: { on() {} },
      session: {
        list: async options => {
          assert.deepEqual(options, { scope: 'all' });
          if (unavailable) throw new Error('permission denied');
          return { sessions: title === null ? [] : [{ id: 'session-1', title }] };
        },
        inject: async input => injected.push(input.sessionId),
      },
    });
    await ready;
    assert.match(await message('m1'), /会话「迭代三期」/);
    title = '迭代四期';
    const snap = await handlers.get('snapshot')({}, { sessionId: 'session-1', projectRoot: '/demo' });
    assert.equal(snap.chats.find((chat) => chat.chatKey === 'group:g').route.title, title);
    assert.equal(snap.current.title, title);
    assert.match(await message('m2'), /会话「迭代四期」/);
    const saved = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')).bindings['group:g'];
    assert.deepEqual(saved, { ...state.bindings['group:g'], title });
    unavailable = true;
    const fallback = await message('m3');
    assert.match(fallback, /绑定的 EnsoCode 会话/);
    assert.doesNotMatch(fallback, /迭代|问候/);
    unavailable = false;
    title = null;
    assert.match(await message('m4'), /绑定的 EnsoCode 会话/);
    assert.deepEqual(injected, Array(4).fill('session-1'));
  } finally {
    deactivate();
    AiBot.WSClient = originalClient;
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});
