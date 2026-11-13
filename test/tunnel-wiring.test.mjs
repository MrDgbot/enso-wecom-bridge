import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activate, deactivate } from '../src/main.mjs';
import './no-tunnel.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the sidebar shows why auto switched from tailscale to a quick tunnel', async () => {
  const handlers = new Map();
  const views = [];
  const runs = [];
  let hooks;
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-wire-'));
  // 规划器和进程启动器都是假的，不会起真隧道；只是要让 pickTunnelMode 回到 auto。
  const savedEnv = process.env.WECOM_BRIDGE_TUNNEL;
  delete process.env.WECOM_BRIDGE_TUNNEL;
  activate({
    dataDir,
    config: { get: async () => ({ botId: '', secret: '' }) },
    tools: { register() {} },
    events: { on() {} },
    renderer: { handle: (name, fn) => handlers.set(name, fn) },
    ui: { view: { emit: (_n, snap) => views.push(snap) } },
  }, {
    planTunnel: async () => [
      { kind: 'tailscale', mode: 'auto', command: '/ts', args: ['funnel', '1'], publicUrl: '' },
      { kind: 'quick', mode: 'auto', command: '/cf', args: [], publicUrl: '' },
    ],
    tunnelRunner: { start: (plan, h) => { runs.push(plan.kind); hooks = h; }, stop() {} },
  });
  try {
    for (let i = 0; i < 100 && !hooks; i++) await sleep(20);
    assert.deepEqual(runs, ['tailscale']);
    hooks.onLog('Funnel is not enabled on your tailnet.\n');
    assert.deepEqual(runs, ['tailscale', 'quick']);
    hooks.onUrl('https://a-b-c.trycloudflare.com');
    const snap = await handlers.get('snapshot')({});
    assert.equal(snap.board.tunnel.kind, 'quick');
    assert.equal(snap.board.tunnel.publicUrl, 'https://a-b-c.trycloudflare.com');
    assert.match(snap.board.tunnel.reason, /Tailscale 没有开启 Funnel，已改用临时隧道/);
    assert.equal(snap.board.publicUrl, 'https://a-b-c.trycloudflare.com');
  } finally {
    if (savedEnv !== undefined) process.env.WECOM_BRIDGE_TUNNEL = savedEnv;
    deactivate();
    await sleep(30);
    await rm(dataDir, { recursive: true, force: true });
  }
});
