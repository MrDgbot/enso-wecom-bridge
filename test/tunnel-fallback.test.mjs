import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTunnelSupervisor, explainTunnelFailure, planTunnelChain, TUNNEL_BINARIES } from '../src/tunnel.mjs';

const FUNNEL_OFF = 'Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=nABC\n';

function fakeRig(plans, { timeouts } = {}) {
  const calls = [];
  const states = [];
  const timers = [];
  let handlers = null;
  const runner = {
    start(plan, h) { calls.push(plan.kind); handlers = h; if (plan.publicUrl) h.onUrl?.(plan.publicUrl); },
    stop() { calls.push('stop'); },
  };
  const supervisor = createTunnelSupervisor({
    runner,
    plan: async () => plans,
    onState: (s) => states.push(s),
    timeouts,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false, unref() {} }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  });
  return { supervisor, calls, states, timers, h: () => handlers, last: () => states.at(-1) };
}

const tail = { kind: 'tailscale', command: '/ts', args: ['funnel', '1'], publicUrl: '' };
const quick = { kind: 'quick', command: '/cf', args: [], publicUrl: '' };

test('auto falls back to a quick tunnel when tailscale reports that Funnel is not enabled', async () => {
  const rig = fakeRig([tail, quick]);
  await rig.supervisor.start('auto');
  assert.deepEqual(rig.calls.filter((c) => c !== 'stop'), ['tailscale']);
  rig.h().onLog(FUNNEL_OFF); // 输出一说明白就换，不等超时
  assert.deepEqual(rig.calls.filter((c) => c !== 'stop'), ['tailscale', 'quick']);
  assert.match(rig.last().reason, /Tailscale 没有开启 Funnel/);
  assert.match(rig.last().reason, /已改用临时隧道/);
  assert.match(rig.last().reason, /login\.tailscale\.com\/f\/funnel/);
  rig.h().onUrl('https://abc-def.trycloudflare.com');
  assert.equal(rig.last().publicUrl, 'https://abc-def.trycloudflare.com');
  assert.equal(rig.last().kind, 'quick');
  assert.match(rig.last().reason, /已改用临时隧道/, 'the reason stays visible after the fallback works');
});

test('auto falls back when the chosen process exits, and when it gives no URL in time', async () => {
  const exited = fakeRig([tail, quick]);
  await exited.supervisor.start('auto');
  exited.h().onExit(0);
  assert.deepEqual(exited.calls.filter((c) => c !== 'stop'), ['tailscale', 'quick']);
  assert.match(exited.last().reason, /Tailscale 退出了.*退出码 0.*已改用临时隧道/);

  const silent = fakeRig([tail, quick], { timeouts: { tailscale: 15000, quick: 45000 } });
  await silent.supervisor.start('auto');
  const timer = silent.timers.at(-1);
  assert.equal(timer.ms, 15000);
  timer.fn();
  assert.deepEqual(silent.calls.filter((c) => c !== 'stop'), ['tailscale', 'quick']);
  assert.match(silent.last().reason, /15 秒内没有拿到公网地址.*已改用临时隧道/);
  assert.equal(silent.timers.at(-1).ms, 45000, 'the fallback gets its own timeout');
});

test('a tunnel that reports its URL in time is never replaced, and its timer is cleared', async () => {
  const rig = fakeRig([tail, quick]);
  await rig.supervisor.start('auto');
  rig.h().onUrl('https://host.tail1234.ts.net');
  assert.ok(rig.timers[0].cleared);
  rig.timers[0].fn(); // 即使旧定时器误触发也不能换
  assert.deepEqual(rig.calls.filter((c) => c !== 'stop'), ['tailscale']);
  assert.equal(rig.last().publicUrl, 'https://host.tail1234.ts.net');
  assert.equal(rig.last().reason, '');
});

test('the last method failing is reported with the whole chain of reasons', async () => {
  const rig = fakeRig([tail, quick]);
  await rig.supervisor.start('auto');
  rig.h().onLog(FUNNEL_OFF);
  rig.h().onLog('failed to request a quick Tunnel: 429 Too Many Requests');
  rig.h().onExit(1);
  assert.equal(rig.last().publicUrl, '');
  assert.match(rig.last().reason, /已改用临时隧道；临时隧道被限流了/);
  assert.deepEqual(rig.calls.filter((c) => c !== 'stop'), ['tailscale', 'quick']);
});

test('an explicit mode never falls back and says why it failed', async () => {
  const rig = fakeRig([tail, quick]);
  await rig.supervisor.start('tailscale');
  rig.h().onLog(FUNNEL_OFF);
  assert.deepEqual(rig.calls.filter((c) => c !== 'stop'), ['tailscale']);
  assert.equal(rig.last().kind, 'tailscale');
  assert.equal(rig.last().mode, 'tailscale');
  assert.match(rig.last().reason, /Tailscale 没有开启 Funnel/);
  assert.doesNotMatch(rig.last().reason, /已改用/);
});

test('an unavailable method reports its own reason; a named tunnel without hostname has no timeout', async () => {
  const off = fakeRig([{ kind: 'off', publicUrl: '', reason: '隧道已关闭' }]);
  await off.supervisor.start('off');
  assert.equal(off.last().kind, 'off');
  assert.equal(off.last().reason, '隧道已关闭');

  const named = fakeRig([{ kind: 'named', command: '/cf', args: [], publicUrl: '', reason: '命名隧道已配置，但没有 hostname，公网地址未知' }, quick]);
  await named.supervisor.start('auto');
  assert.equal(named.timers.length, 0);
  assert.match(named.last().reason, /没有 hostname/);
});

test('stop() cancels pending timers and a stale start cannot launch anything', async () => {
  const rig = fakeRig([tail, quick]);
  await rig.supervisor.start('auto');
  rig.supervisor.stop();
  assert.ok(rig.timers[0].cleared);
  const before = rig.states.length;
  rig.h().onExit(0); // 迟到的回调
  rig.timers[0].fn();
  assert.equal(rig.states.length, before);
  assert.deepEqual(rig.calls.filter((c) => c !== 'stop'), ['tailscale']);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const slow = createTunnelSupervisor({ runner: { start: (p) => calls.push(p.kind), stop() {} }, plan: async () => { await gate; return [quick]; }, onState() {} });
  const pending = slow.start('auto');
  slow.stop();
  release();
  await pending;
  assert.deepEqual(calls, []);
});

test('failure messages are readable in Chinese', () => {
  assert.match(explainTunnelFailure('tailscale', FUNNEL_OFF, 0), /Tailscale 没有开启 Funnel（到 https:\/\/login\.tailscale\.com\/f\/funnel\?node=nABC 开启）/);
  assert.match(explainTunnelFailure('tailscale', 'The Tailscale GUI failed to start: x', 1), /GUI failed to start/);
  assert.match(explainTunnelFailure('quick', '', 2), /临时隧道进程退出了（退出码 2）/);
});

test('planTunnelChain lists named, tailscale and quick in order, and keeps explicit modes single', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chain-'));
  const dataDir = join(home, 'data');
  await mkdir(join(home, '.cloudflared'), { recursive: true });
  await writeFile(join(home, '.cloudflared', 'config.yml'), 'tunnel: abc\ncredentials-file: /x.json\ningress:\n  - hostname: board.example.com\n');
  const bin = join(home, 'bin');
  await mkdir(bin);
  for (const name of ['cloudflared', 'tailscale']) await writeFile(join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
  const binaries = { cloudflared: join(bin, 'cloudflared'), tailscale: join(bin, 'tailscale') };
  const chain = await planTunnelChain({ mode: 'auto', port: 9, home, binaries, dataDir });
  assert.deepEqual(chain.map((p) => p.kind), ['named', 'tailscale', 'quick']);
  const noNamed = await planTunnelChain({ mode: 'auto', port: 9, home: dataDir, binaries, dataDir });
  assert.deepEqual(noNamed.map((p) => p.kind), ['tailscale', 'quick']);
  const noTail = await planTunnelChain({ mode: 'auto', port: 9, home: dataDir, binaries: { ...binaries, tailscale: join(bin, 'nope') }, dataDir });
  assert.deepEqual(noTail.map((p) => p.kind), ['quick']);
  const nothing = await planTunnelChain({ mode: 'auto', port: 9, home: dataDir, binaries: { cloudflared: join(bin, 'nope'), tailscale: join(bin, 'nope') }, dataDir });
  assert.equal(nothing.length, 1);
  assert.equal(nothing[0].kind, 'off');
  const explicit = await planTunnelChain({ mode: 'tailscale', port: 9, home, binaries, dataDir });
  assert.deepEqual(explicit.map((p) => p.kind), ['tailscale']);
});

test('the tailscale shell wrapper is tried before the App binary (the App binary fails outside a terminal)', () => {
  const list = TUNNEL_BINARIES.tailscale;
  assert.ok(list.indexOf('/usr/local/bin/tailscale') < list.findIndex((p) => p.includes('Tailscale.app')));
  assert.ok(list.indexOf('/opt/homebrew/bin/tailscale') < list.findIndex((p) => p.includes('Tailscale.app')));
});

test('with real (fake-binary) processes: Funnel-not-enabled output switches to the quick tunnel and the first process is stopped', async () => {
  const { createTunnelRunner } = await import('../src/tunnel.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'chain-real-'));
  const ts = join(dir, 'tailscale');
  const cf = join(dir, 'cloudflared');
  const pidFile = join(dir, 'ts.pid');
  await writeFile(ts, `#!/bin/sh\necho $$ > '${pidFile}'\nprintf 'Funnel is not enabled on your tailnet.\\nTo enable, visit:\\n https://login.tailscale.com/f/funnel?node=nX\\n'\nsleep 31\n`, { mode: 0o755 });
  await writeFile(cf, '#!/bin/sh\necho "Your quick Tunnel: https://quiet-fox-1.trycloudflare.com" >&2\nsleep 32\n', { mode: 0o755 });
  const runner = createTunnelRunner({ killAfterMs: 500 });
  let guard;
  const done = new Promise((resolve) => {
    const supervisor = createTunnelSupervisor({
      runner,
      plan: async () => [{ kind: 'tailscale', command: ts, args: [], publicUrl: '' }, { kind: 'quick', command: cf, args: [], publicUrl: '' }],
      onState: (state) => { if (state.publicUrl) resolve({ state, supervisor }); },
    });
    supervisor.start('auto');
    // 隧道进程和管道都 unref 了，必须有一个不 unref 的定时器撑住事件循环，否则等待会被当成“循环已空”取消。
    guard = setTimeout(() => resolve({ state: null, supervisor }), 8000);
  });
  const { state, supervisor } = await done;
  clearTimeout(guard);
  try {
    assert.equal(state?.publicUrl, 'https://quiet-fox-1.trycloudflare.com');
    assert.match(state.reason, /Tailscale 没有开启 Funnel.*已改用临时隧道/);
    const pid = Number((await import('node:fs')).readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.throws(() => process.kill(pid, 0), 'the tailscale stand-in is gone');
  } finally {
    supervisor.stop();
  }
  // 停掉之后一个孙进程都不能留下（fork 和发信号有竞争，runner 会补一个 SIGKILL 扫尾）。
  await new Promise((resolve) => setTimeout(resolve, 600));
  const left = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).split('\n').filter((line) => /^sleep 3[12]$/.test(line.trim()));
  assert.deepEqual(left, []);
});
