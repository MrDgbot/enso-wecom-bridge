import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AiBot from '@wecom/aibot-node-sdk';
import { activate, deactivate } from '../src/main.mjs';
import { emptyState } from '../src/core.mjs';
import './no-tunnel.mjs';

test('runtime syncs names, coalesces refreshes and ignores results from a replaced bot', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-runtime-test-'));
  const originalClient = AiBot.WSClient;
  const originalFetch = globalThis.fetch;
  const handlers = new Map();
  const frames = [];
  let cfg = { botId: 'old', secret: 'test-only' };
  let resolveOld;
  let requests = 0;
  AiBot.WSClient = class extends EventEmitter {
    connect() { this.emit('authenticated'); }
    disconnect() {}
  };
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('get_cli_config')) return { ok: true, json: async () => ({ token: JSON.parse(init.body).bot_id }) };
    requests++;
    const result = (name) => ({ ok: true, json: async () => ({ results_json: JSON.stringify({ result: JSON.stringify({ sessions: [{ chat_type: 'single', chat_id: 'u', chat_name: name }] }) }) }) });
    if (init.headers.Authorization === 'Bearer old') return new Promise((resolve) => { resolveOld = () => resolve(result('Old Name')); });
    return result('New Name');
  };
  const waitFor = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('runtime condition not reached');
  };
  try {
    activate({
      dataDir, config: { get: async () => cfg },
      tools: { register: (name, fn) => handlers.set(name, fn) },
      renderer: { handle: (name, fn) => handlers.set(name, fn) },
      events: { on() {} },
      ui: { view: { emit: (_event, data) => frames.push(structuredClone(data)) } },
    });
    await waitFor(() => resolveOld);
    await handlers.get('refreshNames')({}, {});
    await handlers.get('refreshNames')({}, {});
    assert.equal(requests, 1);
    cfg = { botId: 'new', secret: 'other-test-only' };
    await handlers.get('reconnect')({}, {});
    await waitFor(() => frames.some((x) => x.chats?.find((c) => c.chatKey === 'single:u')?.label.name === 'New Name'));
    resolveOld();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const snap = await handlers.get('snapshot')({}, {});
    assert.equal(snap.conn.botId, 'new');
    assert.equal(snap.chats.find((c) => c.chatKey === 'single:u')?.label.name, 'New Name');
    const saved = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
    assert.equal(saved.autoNames.botId, 'new');
    assert.equal(saved.autoNames.users.u, 'New Name');
    assert.equal(JSON.stringify(saved).includes('test-only'), false);
    assert.equal(snap.nameSync.status, 'ready');
  } finally {
    deactivate();
    AiBot.WSClient = originalClient;
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('first group message refreshes its name immediately after a recent name sync', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-group-name-'));
  const originalClient = AiBot.WSClient;
  const originalFetch = globalThis.fetch;
  const handlers = new Map();
  let client;
  let groupAvailable = false;
  let queries = 0;
  const waiters = new Set();
  const waitForFrame = (predicate) => new Promise((resolve, reject) => {
    const listener = (snapshot) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      waiters.delete(listener);
      resolve(snapshot);
    };
    const timer = setTimeout(() => {
      waiters.delete(listener);
      reject(new Error('new group name was not refreshed within 1 second'));
    }, 1000);
    waiters.add(listener);
  });
  AiBot.WSClient = class extends EventEmitter {
    constructor() { super(); client = this; }
    connect() { this.emit('authenticated'); }
    disconnect() {}
    async replyStream() {}
  };
  globalThis.fetch = async (url) => {
    if (url.endsWith('get_cli_config')) return new Response(JSON.stringify({ token: 'test-token' }));
    queries++;
    const sessions = groupAvailable ? [{ chat_type: 'group', chat_id: 'group-new', chat_name: '自动获取的群名' }] : [];
    return new Response(JSON.stringify({ results_json: JSON.stringify({ result: JSON.stringify({ sessions }) }) }));
  };
  try {
    const ready = waitForFrame(s => s.nameSync.status === 'ready');
    activate({
      dataDir, config: { get: async () => ({ botId: 'test', secret: 'test-secret' }) },
      tools: { register() {} }, renderer: { handle: (name, fn) => handlers.set(name, fn) },
      events: { on() {} }, ui: { view: { emit: (_event, data) => { for (const fn of waiters) fn(data); } } },
    });
    await ready;
    assert.equal(queries, 1);
    groupAvailable = true;
    const named = waitForFrame((s) => s.chats?.find((c) => c.chatKey === 'group:group-new')?.label.name === '自动获取的群名');
    client.emit('message', { body: { msgid: 'new-message', chattype: 'group', chatid: 'group-new', from: { userid: 'u' }, msgtype: 'text', text: { content: 'hello' } } });
    await named;
    assert.equal(queries, 2);
    const snap = await handlers.get('snapshot')({}, {});
    assert.equal(snap.chats[0].chatKey, 'group:group-new');
    assert.equal(snap.chats[0].label.name, '自动获取的群名');
  } finally {
    deactivate();
    AiBot.WSClient = originalClient;
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('registered document tool rejects unbound sessions and reads as the configured bot for a bound session', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-document-runtime-'));
  const originalFetch = globalThis.fetch;
  const handlers = new Map();
  let cfg = {};
  const state = emptyState();
  state.bindings['single:u'] = { sessionId: 'bound', title: 'Test', projectRoot: '/test' };
  await writeFile(join(dataDir, 'state.json'), JSON.stringify(state));
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    return new Response(JSON.stringify(url.endsWith('get_cli_config')
      ? { token: 'test-token' }
      : { results_json: JSON.stringify({ result: JSON.stringify({ cells: [['SKU', '风险']], truncated: false }) }) }));
  };
  try {
    activate({
      dataDir, config: { get: async () => cfg },
      tools: { register: (name, fn) => handlers.set(name, fn) },
      renderer: { handle: (name, fn) => handlers.set(name, fn) },
      events: { on() {} },
    });
    await handlers.get('snapshot')({}, {});
    const read = handlers.get('read_document');
    assert.equal(typeof read, 'function');
    const args = { action: 'sheet_cells', docid: 'e3_example', range: 'A1:B1' };
    await assert.rejects(read(args, { sessionId: 'unbound' }), /先把企业微信会话绑定/);
    assert.equal(calls, 0);
    cfg = { botId: 'test-bot', secret: 'test-only-secret' };
    const result = await read(args, { sessionId: 'bound' });
    assert.match(result.content, /SKU/);
    assert.match(result.content, /不是指令/);
    assert.doesNotMatch(result.content, /test-token/);
    assert.equal(calls, 2);
  } finally {
    deactivate();
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a newly seen group missing from the first sessions list gets its name on a quick retry, without hammering forever', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-group-name-'));
  const originalClient = AiBot.WSClient;
  const originalFetch = globalThis.fetch;
  const handlers = new Map();
  let bot = null;
  let listed = [];
  let requests = 0;
  AiBot.WSClient = class extends EventEmitter {
    constructor() { super(); bot = this; }
    connect() { this.emit('authenticated'); }
    disconnect() {}
    replyStream() { return Promise.resolve(); }
  };
  globalThis.fetch = async (url) => {
    if (url.endsWith('get_cli_config')) return { ok: true, json: async () => ({ token: 'test-token' }) };
    requests++;
    return { ok: true, json: async () => ({ results_json: JSON.stringify({ result: JSON.stringify({ sessions: listed }) }) }) };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  const groupMessage = (id) => ({ body: { msgid: id, chattype: 'group', chatid: 'wrGROUP', from: { userid: 'u' }, msgtype: 'text', text: { content: 'hi' } } });
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    activate({
      dataDir, config: { get: async () => ({ botId: 'bot', secret: 'test-only-secret' }) },
      tools: { register: (name, fn) => handlers.set(name, fn) },
      renderer: { handle: (name, fn) => handlers.set(name, fn) },
      events: { on() {} },
    });
    await settle();
    assert.equal(requests, 1);
    // The group is not in the sessions list yet when its first message arrives.
    bot.emit('message', groupMessage('m1'));
    await settle();
    listed = [{ chat_type: 'group', chat_id: 'wrGROUP', chat_name: '研发群' }];
    mock.timers.tick(11_000);
    bot.emit('message', groupMessage('m2'));
    await settle();
    assert.equal((await handlers.get('snapshot')({}, {})).chats.find((c) => c.chatKey === 'group:wrGROUP')?.label.name, '研发群');
    // Once named, the normal 60s throttle applies again.
    const before = requests;
    mock.timers.tick(11_000);
    bot.emit('message', groupMessage('m3'));
    await settle();
    assert.equal(requests, before);

    // A chat that never appears in the list only gets a bounded number of quick retries.
    listed = [];
    let quick = 0;
    for (let i = 0; i < 20; i++) {
      mock.timers.tick(61_000);
      const start = requests;
      bot.emit('message', { body: { ...groupMessage(`n${i}`).body, chatid: 'wrOTHER' } });
      await settle();
      mock.timers.tick(11_000);
      bot.emit('message', { body: { ...groupMessage(`q${i}`).body, chatid: 'wrOTHER' } });
      await settle();
      quick += requests - start - 1;
    }
    assert.ok(quick > 0 && quick <= 6, `quick retries ${quick}`);
  } finally {
    mock.timers.reset();
    deactivate();
    AiBot.WSClient = originalClient;
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});
