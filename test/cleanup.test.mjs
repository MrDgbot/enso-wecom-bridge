import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import './no-tunnel.mjs';
import { activate, deactivate } from '../src/main.mjs';
import { createTunnelRunner, pickTunnelMode } from '../src/tunnel.mjs';

const testDir = fileURLToPath(new URL('.', import.meta.url));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, label) => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await sleep(25); }
  assert.fail(label || 'timed out');
};

// 模拟 macOS 上 /usr/local/bin/tailscale：一个不 exec 的 sh 包装脚本，真正干活的是它起的孙进程。
async function wrapperScript() {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-wrapper-'));
  const script = join(dir, 'tailscale');
  await writeFile(script, '#!/bin/sh\nsleep 60 &\necho $! > "$1"\nwait\n');
  await chmod(script, 0o755);
  return { dir, script, pidFile: join(dir, 'grandchild.pid') };
}

test('every test file that activates the plugin disables real tunnels and deactivates', async () => {
  for (const name of await readdir(testDir)) {
    if (!/\.(test|smoke)\.mjs$/.test(name) || name === 'cleanup.test.mjs') continue;
    const text = await readFile(join(testDir, name), 'utf8');
    const activations = (text.match(/[^a-zA-Z.]activate\(/g) || []).length;
    if (!activations) continue;
    assert.match(text, /import '\.\/no-tunnel\.mjs'/, `${name} must import ./no-tunnel.mjs`);
    assert.ok((text.match(/deactivate\(\)/g) || []).length >= activations, `${name} must call deactivate() for every activate()`);
  }
});

test('WECOM_BRIDGE_TUNNEL=off beats every other tunnel setting', () => {
  assert.equal(pickTunnelMode('tailscale', 'quick', { WECOM_BRIDGE_TUNNEL: 'off' }), 'off');
  assert.equal(pickTunnelMode('tailscale', 'quick', {}), 'tailscale');
  assert.equal(process.env.WECOM_BRIDGE_TUNNEL, 'off');
});

test('stopping a tunnel started through a shell wrapper also stops the real program behind it', async () => {
  const { script, pidFile } = await wrapperScript();
  const runner = createTunnelRunner({ killAfterMs: 500 });
  runner.start({ kind: 'tailscale', command: script, args: [pidFile], publicUrl: '' }, {});
  await until(async () => readFile(pidFile, 'utf8').then((text) => Boolean(text.trim()), () => false), 'wrapper started');
  const grandchild = Number((await readFile(pidFile, 'utf8')).trim());
  assert.ok(alive(grandchild));
  runner.stop();
  await until(() => !alive(grandchild), 'grandchild stopped');
});

test('a process that activates and deactivates the plugin with a live tunnel exits by itself', async () => {
  const { script, pidFile, dir } = await wrapperScript();
  const child = spawn(process.execPath, [join(testDir, 'exit-probe.mjs'), script, pidFile, dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('hung'); }, 15_000);
    child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  const grandchild = Number((await readFile(pidFile, 'utf8').catch(() => '0')).trim());
  if (grandchild && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
  assert.equal(code, 0, stderr);
  if (grandchild) await until(() => !alive(grandchild), 'grandchild stopped');
});

test('a tunnel plan that finishes after deactivate never starts a process', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = [];
  const stopped = [];
  activate({
    dataDir: await mkdtemp(join(tmpdir(), 'wecom-late-')),
    config: { get: async () => ({ botId: '', secret: '' }) },
    tools: { register() {} },
    events: { on() {} },
    renderer: { handle() {} },
    ui: { view: { emit() {} } },
  }, {
    planTunnel: async () => { await gate; return { kind: 'quick', command: '/x/cloudflared', args: [], publicUrl: '' }; },
    tunnelRunner: { start: (plan) => started.push(plan), stop: () => stopped.push(true) },
  });
  await sleep(150);
  deactivate();
  release();
  await sleep(100);
  assert.deepEqual(started, []);
  assert.ok(stopped.length >= 1);
});
