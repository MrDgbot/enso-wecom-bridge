import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import AiBot from '@wecom/aibot-node-sdk';
import { activate, deactivate } from '../src/main.mjs';
import { emptyState } from '../src/core.mjs';
import './no-tunnel.mjs';

const until = async (predicate, label) => {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(label || 'timed out');
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot({ bindings, inject, download, tasks } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-review-'));
  const original = AiBot.WSClient;
  const originalFetch = globalThis.fetch;
  const ctx = { events: new Map(), handlers: new Map(), replies: [], pushes: [], injections: [], dataDir, client: null };
  const state = emptyState();
  state.bindings = bindings ?? { 'group:g': { sessionId: 'S', title: '项目会话', projectRoot: '/work' } };
  if (tasks) state.tasks = tasks;
  await writeFile(join(dataDir, 'state.json'), JSON.stringify(state));
  AiBot.WSClient = class extends EventEmitter {
    constructor() { super(); ctx.client = this; this.isConnected = true; }
    connect() { this.emit('authenticated'); }
    disconnect() {}
    async replyStream(_frame, _id, text) { ctx.replies.push(text); }
    async sendMessage(_chat, body) { ctx.pushes.push({ chat: _chat, text: body.markdown.content }); }
    async downloadFile(...args) { return download(...args); }
  };
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith('get_cli_config') ? { token: 't' } : { results_json: JSON.stringify({ result: { sessions: [] } }) }));
  activate({
    dataDir,
    config: { get: async () => ({ botId: 'bot', secret: 'secret' }) },
    tools: { register: (name, fn) => ctx.handlers.set(name, fn) },
    events: { on: (name, fn) => ctx.events.set(name, fn) },
    renderer: { handle: (name, fn) => ctx.handlers.set(name, fn) },
    ui: { view: { emit() {} } },
    session: {
      list: async () => ({ sessions: [{ id: 'S', title: '项目会话' }] }),
      inject: async (input) => {
        ctx.injections.push(input);
        return inject ? inject(input, ctx.injections.length) : {};
      },
    },
  });
  await until(() => ctx.client, 'socket');
  ctx.emit = (id, text, { chat = 'group', chatid = 'g', userid = 'u', image } = {}) => ctx.client.emit('message', {
    headers: { req_id: id },
    body: image
      ? { msgid: id, chattype: chat, chatid, from: { userid }, msgtype: 'mixed', mixed: { msg_item: [{ msgtype: 'text', text: { content: text } }, { msgtype: 'image', image }] } }
      : { msgid: id, chattype: chat, chatid, from: { userid }, msgtype: 'text', text: { content: text } },
  });
  ctx.saved = async () => JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
  ctx.close = async () => {
    deactivate();
    AiBot.WSClient = original;
    globalThis.fetch = originalFetch;
    await sleep(30);
    await rm(dataDir, { recursive: true, force: true });
  };
  return ctx;
}

test('a re-inject triggered from agent_end does not inherit the finished event invocation', async () => {
  const als = new AsyncLocalStorage();
  const seen = [];
  const rt = await boot({ inject: async () => { seen.push(als.getStore() ?? null); return {}; } });
  try {
    rt.emit('m1', '先确认操作台');
    await until(() => rt.injections.length === 1, 'first inject');
    // 宿主调用事件 handler 时处于一个 invocation 里；handler 结束后这个 invocation 就失效。
    await als.run('event-invocation', () => rt.events.get('agent_end')({ text: '' }, { sessionId: 'S' }));
    await until(() => rt.injections.length === 2, 're-inject after the empty run');
    assert.deepEqual(seen, [null, null]);
  } finally {
    await rt.close();
  }
});

test('an agent_end that arrives before the next batch starts injecting does not settle it with the old answer', async () => {
  const rt = await boot();
  try {
    rt.emit('m1', '先确认操作台');
    await until(() => rt.injections.length === 1, 'first inject');
    await until(async () => (await rt.saved()).tasks.find((task) => task.id === 'm1')?.status === 'queued', 'm1 queued');
    await sleep(8);
    const eventTime = Date.now();
    await sleep(8);
    rt.emit('m2', '再确认主题');
    await until(() => rt.injections.length === 2, 'second inject');
    // 上一轮的 agent_end 其实在 m2 开始注入之前就发出了，只是插件这边晚处理。
    const realNow = Date.now;
    Date.now = () => eventTime;
    let late;
    try { late = rt.events.get('agent_end')({ text: '方案A的回答' }, { sessionId: 'S' }); } finally { Date.now = realNow; }
    await late;
    const afterFirst = await rt.saved();
    assert.equal(afterFirst.tasks.find((task) => task.id === 'm1').status, 'replied');
    assert.equal(afterFirst.tasks.find((task) => task.id === 'm2').status, 'queued');
    assert.deepEqual(rt.pushes.map((push) => push.text), ['方案A的回答']);
    await rt.events.get('agent_end')({ text: '方案B的回答' }, { sessionId: 'S' });
    const after = await rt.saved();
    assert.equal(after.tasks.find((task) => task.id === 'm2').status, 'replied');
    assert.deepEqual(rt.pushes.map((push) => push.text), ['方案A的回答', '方案B的回答']);
  } finally {
    await rt.close();
  }
});

test('two empty runs in a row tell the chat instead of leaving it on the acknowledgement', async () => {
  const rt = await boot();
  try {
    rt.emit('m1', '小数点是否必须精确到两位');
    await until(() => rt.injections.length === 1, 'first inject');
    await rt.events.get('agent_end')({ text: '' }, { sessionId: 'S' });
    await until(() => rt.injections.length === 2, 'one retry');
    assert.deepEqual(rt.pushes, []);
    await rt.events.get('agent_end')({ text: '  ' }, { sessionId: 'S' });
    await until(() => rt.pushes.length === 1, 'give-up notice');
    assert.match(rt.pushes[0].text, /没有给出文字回复/);
    const saved = await rt.saved();
    assert.equal(saved.tasks[0].status, 'failed');
    assert.equal(rt.injections.length, 2);
  } finally {
    await rt.close();
  }
});

test('a message whose image is still downloading is not injected without it', async () => {
  let releaseImage;
  const gate = new Promise((resolve) => { releaseImage = resolve; });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16)]);
  const rt = await boot({
    bindings: { 'group:g': { sessionId: 'S', title: '项目会话' }, 'single:u': { sessionId: 'S', title: '项目会话' } },
    download: async () => { await gate; return { buffer: png }; },
  });
  try {
    rt.emit('img', '看这张图', { image: { url: 'https://x/y', aeskey: 'k' } });
    await until(async () => (await rt.saved()).tasks.some((task) => task.id === 'img'), 'image task recorded');
    rt.emit('txt', '另一个人的问题', { chat: 'single', userid: 'u' });
    await until(() => rt.injections.length === 1, 'text-only batch');
    assert.doesNotMatch(rt.injections[0].text, /看这张图/);
    assert.match(rt.injections[0].text, /另一个人的问题/);
    releaseImage();
    await until(() => rt.injections.length === 2, 'image batch');
    assert.match(rt.injections[1].text, /看这张图/);
    assert.equal(rt.injections[1].images?.length, 1);
    await until(() => rt.replies.length >= 2, 'both acknowledged');
  } finally {
    releaseImage();
    await rt.close();
  }
});

test('board tools only touch the chats a session is bound to; sessions without WeCom get no board prompt', async () => {
  const rt = await boot({ bindings: { 'group:g': { sessionId: 'S', title: '项目会话' } } });
  try {
    const main = { sessionId: 'S' };
    await rt.handlers.get('board_add')({ title: '本群需求', chatKey: 'group:g', status: '待做' }, main);
    await rt.handlers.get('board_add')({ title: '别群需求', chatKey: 'group:other', status: '待做' }, { sessionId: 'T' });
    await assert.rejects(rt.handlers.get('board_add')({ title: '越界', chatKey: 'group:other' }, main), /没有接入/);
    const saved = await rt.saved();
    const foreign = saved.board.items.find((item) => item.title === '别群需求');
    const own = saved.board.items.find((item) => item.title === '本群需求');
    await assert.rejects(rt.handlers.get('board_update')({ id: foreign.id, status: '完成' }, main), /不属于/);
    await rt.handlers.get('board_update')({ id: own.id, status: '进行中', delivery: 'delivered' }, main);
    const after = await rt.saved();
    assert.equal(after.board.items.find((item) => item.id === own.id).status, 'doing');
    assert.equal(after.board.items.find((item) => item.id === own.id).delivery, 'pending');
    assert.equal(after.board.items.find((item) => item.id === foreign.id).status, 'todo');
    const hook = rt.events.get('before_agent_start');
    assert.equal(await hook({ prompt: '开始做', kind: 'user' }, { sessionId: 'unrelated-local-session' }), undefined);
    const bound = await hook({ prompt: '开始做', kind: 'user' }, main);
    assert.match(bound.append, /本群需求/);
    assert.doesNotMatch(bound.append, /别群需求/);
  } finally {
    await rt.close();
  }
});
