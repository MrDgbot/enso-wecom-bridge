import assert from 'node:assert/strict';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import AiBot from '@wecom/aibot-node-sdk';
import { activate, deactivate } from '../src/main.mjs';
import { emptyState } from '../src/core.mjs';
import './no-tunnel.mjs';

test('reconnected socket delivers after the UI invocation ends, without borrowing its authority', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-reconnect-context-'));
  const current = new AsyncLocalStorage();
  const active = new Set();
  const clients = [], replies = [], injections = [], calls = [];
  const handlers = new Map();
  const originalClient = AiBot.WSClient, originalFetch = globalThis.fetch;
  let crossSessionInject = true;
  let gate;
  const frame = id => ({ headers: { req_id: id }, body: {
    msgid: id, chattype: 'group', chatid: 'g', from: { userid: 'u' },
    msgtype: 'text', text: { content: '检查代码，不向真实群发送' },
  } });
  const injected = input => { injections.push(input); return { ok: true }; };
  const hostCall = async (api, args) => {
    const invocationId = current.getStore();
    calls.push({ api, invocationId });
    if (gate) return gate.handle('local.wecombridge', api, args, invocationId);
    if (invocationId !== undefined && !active.has(invocationId))
      throw Object.assign(new Error('此接口只能在宿主发起的调用内使用'), { code: 'NO_INVOCATION' });
    if (api === 'session.list') return { sessions: [{ id: 'S', title: '测试会话' }] };
    if (!crossSessionInject) throw Object.assign(new Error('未允许向其他会话发送消息'), { code: 'PERMISSION_DENIED' });
    injected(args);
  };
  const until = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'expected callback was not received');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  try {
    if (process.env.ENSO_GATE_SOURCE) {
      const source = resolve(process.env.ENSO_GATE_SOURCE);
      const outfile = join(dataDir, 'gate.mjs');
      await build({ entryPoints: [source], outfile, bundle: true, platform: 'node', format: 'esm',
        alias: { '@shared': resolve(dirname(source), '../../../shared') } });
      const { PluginHostGate } = await import(pathToFileURL(outfile));
      gate = new PluginHostGate({
        manifest: () => ({ permissions: ['agent.inject', 'session.readAll'] }),
        now: Date.now, crossSessionInject: () => crossSessionInject, inject: (_plugin, input) => injected(input),
        listSessions: async () => [{ id: 'S', title: '测试会话' }],
      });
    }
    const state = emptyState();
    state.bindings['group:g'] = { sessionId: 'S', title: '测试会话' };
    await writeFile(join(dataDir, 'state.json'), JSON.stringify(state));
    AiBot.WSClient = class extends EventEmitter {
      constructor() { super(); clients.push(this); }
      connect() { this.socket = new AsyncResource('test-wecom-socket'); this.emit('authenticated'); }
      disconnect() { this.socket?.emitDestroy(); }
      receive(id) { return this.socket.runInAsyncScope(() => this.emit('message', frame(id))); }
      async replyStream(_frame, _id, text) { replies.push(text); }
    };
    globalThis.fetch = async url => new Response(JSON.stringify(url.endsWith('get_cli_config')
      ? { token: 'test-token' } : { results_json: JSON.stringify({ result: { sessions: [] } }) }));
    activate({
      dataDir, config: { get: async () => ({ botId: 'fake', secret: 'fake' }) },
      tools: { register() {} }, events: { on() {} },
      renderer: { handle: (name, fn) => handlers.set(name, fn) },
      session: { inject: args => hostCall('session.inject', args), list: args => hostCall('session.list', args) },
    });
    await until(() => clients[0]?.socket);
    clients[0].receive('startup');
    await until(() => replies.length === 1);
    assert.equal(injections.length, 1);
    for (let round = 0; round < 2; round++) {
      const invocationId = gate ? gate.invocations.create({ pluginId: 'local.wecombridge', sessionId: 'S', gesture: false }) : `ui-${round}`;
      active.add(invocationId);
      await current.run(invocationId, () => handlers.get('reconnect')({}, { sessionId: 'S' }));
      active.delete(invocationId);
      gate?.invocations.finish(invocationId);
      await assert.rejects(current.run(invocationId, () => hostCall('session.inject', { sessionId: 'S', text: 'stale control' })), { code: 'NO_INVOCATION' });
      const before = replies.length;
      clients.at(-1).receive(`after-reconnect-${round}`);
      await until(() => replies.length > before);
      assert.equal(injections.length, round + 2, replies.at(-1));
      assert.equal(calls.filter(c => c.api === 'session.inject').at(-1).invocationId, undefined);
    }
    crossSessionInject = false;
    const before = replies.length;
    clients.at(-1).receive('permission-off');
    await until(() => replies.length > before);
    assert.equal(injections.length, 3);
    assert.match(replies.at(-1), /没有允许插件/);
    const saved = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
    assert.equal(saved.tasks.find(t => t.id === 'after-reconnect-1').status, 'queued');
    assert.equal(saved.tasks.find(t => t.id === 'permission-off').status, 'failed');
    console.log(gate ? 'Real Enso PluginHostGate verified: expired invocation rejected; reconnect delivered; permission-off rejected.' : 'Async invocation lifecycle verified.');
  } finally {
    deactivate();
    AiBot.WSClient = originalClient;
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});
