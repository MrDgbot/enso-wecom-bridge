import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { namedRuntimeConfig, parseCloudflaredConfig, planTunnel, TUNNEL_BINARIES } from '../src/tunnel.mjs';

test('auto prefers a named cloudflared tunnel, then tailscale, then a quick tunnel', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wecom-home-'));
  const bin = await mkdtemp(join(tmpdir(), 'wecom-bin-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-data-'));
  const binaries = { cloudflared: join(bin, 'cloudflared'), ngrok: join(bin, 'ngrok'), tailscale: join(bin, 'tailscale') };
  await writeFile(binaries.cloudflared, '');
  await writeFile(binaries.tailscale, '');
  const none = await planTunnel({ mode: 'auto', port: 9, home, binaries: { ...TUNNEL_BINARIES, cloudflared: join(bin, 'missing'), tailscale: join(bin, 'missing') }, dataDir });
  assert.equal(none.kind, 'off');
  const quick = await planTunnel({ mode: 'auto', port: 9, home, binaries: { ...binaries, tailscale: join(bin, 'no-ts') }, dataDir });
  assert.equal(quick.kind, 'quick');
  assert.deepEqual(quick.args.slice(0, 2), ['tunnel', '--url']);
  assert.match(quick.command, /cloudflared$/);
  const tail = await planTunnel({ mode: 'auto', port: 9, home, binaries, dataDir });
  assert.equal(tail.kind, 'tailscale');
  assert.deepEqual(tail.args, ['funnel', '9']);
  await mkdir(join(home, '.cloudflared'), { recursive: true });
  await writeFile(join(home, '.cloudflared', 'config.yml'), 'tunnel: board\ncredentials-file: /tmp/cert.json\ningress:\n  - hostname: board.example.com\n    service: http://localhost:1\n');
  const named = await planTunnel({ mode: 'auto', port: 4321, home, binaries, dataDir });
  assert.equal(named.kind, 'named');
  assert.equal(named.publicUrl, 'https://board.example.com');
  const runtime = await readFile(join(dataDir, 'cloudflared.runtime.yml'), 'utf8');
  assert.match(runtime, /127\.0\.0\.1:4321/);
  assert.match(runtime, /hostname: board\.example\.com/);
  assert.equal(parseCloudflaredConfig('tunnel: x\ncredentials-file: c\n').tunnel, 'x');
  assert.match(namedRuntimeConfig({ tunnel: 'x', credentialsFile: 'c', hostname: '', port: 1 }), /service: http:\/\/127\.0\.0\.1:1/);
});

import { EventEmitter } from 'node:events';
import { createTunnelRunner, pickTunnelMode } from '../src/tunnel.mjs';

const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = [];
  child.kill = (signal) => { child.killed.push(signal); queueMicrotask(() => child.emit('exit', null)); return true; };
  child.unref = () => {};
  return child;
};

test('runner never reports api.trycloudflare.com as the public address', () => {
  const child = fakeChild();
  const urls = [];
  const runner = createTunnelRunner({ spawnImpl: () => child, killAfterMs: 5 });
  runner.start({ command: '/x/cloudflared', args: [] }, { onUrl: (url) => urls.push(url) });
  child.stderr.emit('data', 'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF\n');
  assert.deepEqual(urls, []);
  child.stderr.emit('data', '|  https://example-quiet-fox-9.trycloudflare.com   |\n');
  assert.deepEqual(urls, ['https://example-quiet-fox-9.trycloudflare.com']);
  child.stdout.emit('data', 'Available on the internet:\n\nhttps://macbook-pro.tail1234.ts.net/\n|-- / proxy http://127.0.0.1:9\n');
  assert.equal(urls.at(-1), 'https://macbook-pro.tail1234.ts.net');
  runner.stop();
});

test('a spawn error is reported instead of crashing the process', () => {
  const child = fakeChild();
  const exits = [];
  const runner = createTunnelRunner({ spawnImpl: () => child });
  runner.start({ command: '/x/cloudflared', args: [] }, { onExit: (code) => exits.push(code) });
  assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })));
  assert.deepEqual(exits, ['EACCES']);
  const thrown = createTunnelRunner({ spawnImpl: () => { throw Object.assign(new Error('boom'), { code: 'ENOENT' }); } });
  const seen = [];
  assert.doesNotThrow(() => thrown.start({ command: '/x', args: [] }, { onExit: (code) => seen.push(code) }));
  assert.deepEqual(seen, ['ENOENT']);
});

test('restarting the tunnel stops the old process without reporting a drop, and the new one still reports', async () => {
  const children = [fakeChild(), fakeChild()];
  const exits = [];
  const runner = createTunnelRunner({ spawnImpl: () => children.shift(), killAfterMs: 5 });
  const first = children[0];
  const second = children[1];
  runner.start({ command: '/x', args: [] }, { onExit: (code) => exits.push(['first', code]) });
  runner.start({ command: '/x', args: [] }, { onExit: (code) => exits.push(['second', code]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(first.killed, ['SIGTERM']);
  assert.deepEqual(exits, []);
  second.emit('exit', 1);
  assert.deepEqual(exits, [['second', 1]]);
});

test('tunnel mode from settings is normalized so a typo cannot restart the tunnel forever', () => {
  assert.equal(pickTunnelMode('', ' Quick '), 'quick');
  assert.equal(pickTunnelMode('off', 'quick'), 'off');
  assert.equal(pickTunnelMode('', 'nonsense'), 'auto');
  assert.equal(pickTunnelMode(undefined, undefined), 'auto');
});

test('a quick tunnel runs with an isolated HOME so an existing config.yml cannot break it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wecom-home-'));
  const bin = await mkdtemp(join(tmpdir(), 'wecom-bin-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-data-'));
  const binaries = { cloudflared: join(bin, 'cloudflared'), ngrok: '', tailscale: join(bin, 'none') };
  await writeFile(binaries.cloudflared, '');
  await mkdir(join(home, '.cloudflared'), { recursive: true });
  await writeFile(join(home, '.cloudflared', 'config.yml'), 'ingress:\n  - service: http_status:404\n');
  const plan = await planTunnel({ mode: 'quick', port: 7, home, binaries, dataDir });
  assert.equal(plan.kind, 'quick');
  assert.equal(plan.env.HOME, join(dataDir, 'cloudflared-home'));
});
