import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AiBot from '@wecom/aibot-node-sdk';
import { activate, deactivate } from '../src/main.mjs';
import { emptyState } from '../src/core.mjs';
import './no-tunnel.mjs';

const until = async (predicate, label) => {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(label || 'timed out');
};

test('connect is single-flight and does not construct two sockets', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-flight-'));
  const original = AiBot.WSClient;
  let constructed = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  AiBot.WSClient = class extends EventEmitter {
    constructor() { super(); constructed += 1; this.isConnected = true; }
    connect() {}
    disconnect() {}
    removeAllListeners() { super.removeAllListeners(); }
  };
  const handlers = new Map();
  try {
    activate({
      dataDir,
      config: { get: () => gate },
      tools: { register() {} },
      events: { on() {} },
      renderer: { handle: (name, fn) => handlers.set(name, fn) },
      ui: { view: { emit() {} } },
      session: { list: async () => ({ sessions: [] }), inject: async () => ({}) },
    });
    const first = handlers.get('reconnect')();
    const second = handlers.get('reconnect')();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(constructed, 0);
    release({ botId: 'bot', secret: 'secret' });
    await Promise.all([first, second]);
    assert.equal(constructed, 1);
  } finally {
    deactivate();
    AiBot.WSClient = original;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a busy session queues the next message, injection retries, and an empty run is not delivered', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-retry-'));
  const original = AiBot.WSClient;
  const events = new Map();
  const handlers = new Map();
  const replies = [];
  const pushes = [];
  const injections = [];
  let client;
  let injects = 0;
  let releaseInject;
  const state = emptyState();
  state.bindings['group:g'] = { sessionId: 'S', title: '项目会话', projectRoot: '/work' };
  await writeFile(join(dataDir, 'state.json'), JSON.stringify(state));
  AiBot.WSClient = class extends EventEmitter {
    constructor() { super(); client = this; this.isConnected = true; }
    connect() { this.emit('authenticated'); }
    disconnect() {}
    async replyStream(_frame, _id, text) { replies.push(text); }
    async sendMessage(_chat, body) { pushes.push(body.markdown.content); }
  };
  globalThis.fetch = async (url) => new Response(JSON.stringify(url.endsWith('get_cli_config') ? { token: 't' } : { results_json: JSON.stringify({ result: { sessions: [] } }) }));
  const originalFetch = globalThis.fetch;
  try {
    activate({
      dataDir,
      config: { get: async () => ({ botId: 'bot', secret: 'secret' }) },
      tools: { register: (name, fn) => handlers.set(name, fn) },
      events: { on: (name, fn) => events.set(name, fn) },
      renderer: { handle: (name, fn) => handlers.set(name, fn) },
      ui: { view: { emit() {} } },
      session: { list: async () => ({ sessions: [{ id: 'S', title: '项目会话' }] }), inject: async (input) => {
        injections.push(input.text);
        injects += 1;
        if (injects === 1) {
          await new Promise((resolve) => { releaseInject = resolve; });
          return {};
        }
        if (injects === 2) throw Object.assign(new Error('rate'), { code: 'RATE_LIMITED' });
        return {};
      } },
    });
    await until(() => client, 'socket');
    const emit = (id, text) => client.emit('message', { headers: { req_id: id }, body: { msgid: id, chattype: 'group', chatid: 'g', from: { userid: 'u' }, msgtype: 'text', text: { content: text } } });
    emit('m1', '先确认操作台');
    await until(() => injections.length === 1, 'first inject');
    emit('m2', '再确认主题');
    releaseInject();
    await until(() => replies.some((text) => text.includes('已排队')), 'busy ack');
    assert.ok(replies.some((text) => text.includes('已交给')));
    await until(() => injections.length >= 3, 'retried inject');
    assert.match(injections.at(-1), /先确认操作台/);
    assert.match(injections.at(-1), /再确认主题/);
    await events.get('agent_end')({ text: '' }, { sessionId: 'S' });
    await until(async () => {
      const saved = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
      return saved.tasks.find((task) => task.id === 'm2')?.status !== 'replied';
    }, 'empty run leaves the task unsettled');
    assert.equal(pushes.some((text) => text.includes('本轮没有文字回复')), false);
    const saved = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
    assert.notEqual(saved.tasks.find((task) => task.id === 'm2').status, 'replied');
    assert.equal((await stat(join(dataDir, 'state.json'))).mode & 0o777, 0o600);
    await assert.rejects(handlers.get('board_add')({ title: '本地需求', chatKey: 'group:g', source: 'local' }, { sessionId: 'S', agent: { kind: 'subagent' } }), /子代理/);
  } finally {
    deactivate();
    AiBot.WSClient = original;
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an unreadable state file is backed up and not overwritten', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-corrupt-'));
  const original = AiBot.WSClient;
  AiBot.WSClient = class extends EventEmitter {
    connect() {}
    disconnect() {}
  };
  const file = join(dataDir, 'state.json');
  await writeFile(file, '{');
  try {
    activate({
      dataDir,
      config: { get: async () => ({ botId: '', secret: '' }) },
      tools: { register() {} },
      events: { on() {} },
      renderer: { handle() {} },
      ui: { view: { emit() {} } },
    });
    await until(async () => {
      const names = await import('node:fs/promises').then((fs) => fs.readdir(dataDir));
      return names.some((name) => name.startsWith('state.json.corrupt-'));
    }, 'backup');
    assert.equal(await readFile(file, 'utf8'), '{');
  } finally {
    deactivate();
    AiBot.WSClient = original;
    await rm(dataDir, { recursive: true, force: true });
  }
});
