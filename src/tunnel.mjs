import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 每项可以是路径或候选路径数组，取第一个存在的。
// macOS 上 /usr/local/bin/tailscale 常是个 `#!/bin/sh` 包装脚本；实测直接跑 App 里的 Tailscale 二进制、
// 又不是从终端启动时，它会去拉 GUI 并报 “The Tailscale GUI failed to start”，而经过这个包装脚本就正常，
// 所以包装脚本优先，App 里的二进制只作最后的候选。包装脚本不 exec 真程序，停止时要按进程组杀（见 createTunnelRunner）。
export const TUNNEL_BINARIES = {
  cloudflared: ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'],
  ngrok: '/opt/homebrew/bin/ngrok',
  tailscale: ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'],
};
export const TUNNEL_MODES = ['auto', 'named', 'quick', 'tailscale', 'off'];

// 设置页里的 tunnelMode 是自由文本（可能带空格、大小写），侧栏选择优先；都不合法就按 auto。
export function pickTunnelMode(boardMode, configMode, env = process.env) {
  // WECOM_BRIDGE_TUNNEL=off 让测试和排障时绝不启动真实隧道；宿主给插件的环境变量白名单里没有它，线上不会生效。
  if (String(env?.WECOM_BRIDGE_TUNNEL ?? '').trim().toLowerCase() === 'off') return 'off';
  for (const raw of [boardMode, configMode]) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (TUNNEL_MODES.includes(value)) return value;
  }
  return 'auto';
}

const exists = async (path) => access(path).then(() => true, () => false);
async function firstExisting(candidates) {
  for (const path of [].concat(candidates ?? [])) if (path && await exists(path)) return path;
  return '';
}

export function parseCloudflaredConfig(text) {
  const tunnel = text.match(/^tunnel:\s*(\S+)/m)?.[1] || '';
  const credentialsFile = text.match(/^credentials-file:\s*(\S+)/m)?.[1] || '';
  const hostname = text.match(/hostname:\s*(\S+)/)?.[1] || '';
  if (!tunnel) return null;
  return { tunnel, credentialsFile, hostname };
}

export function namedRuntimeConfig({ tunnel, credentialsFile, hostname, port }) {
  const first = hostname
    ? `  - hostname: ${hostname}\n    service: http://127.0.0.1:${port}\n`
    : `  - service: http://127.0.0.1:${port}\n`;
  return `tunnel: ${tunnel}\ncredentials-file: ${credentialsFile}\ningress:\n${first}  - service: http_status:404\n`;
}

export async function planTunnel({ mode = 'auto', port, home = homedir(), binaries = TUNNEL_BINARIES, dataDir } = {}) {
  const selected = TUNNEL_MODES.includes(mode) ? mode : 'auto';
  if (selected === 'off') return { kind: 'off', mode: selected, publicUrl: '', reason: '隧道已关闭' };
  const [cloudflared, tailscale] = await Promise.all([firstExisting(binaries.cloudflared), firstExisting(binaries.tailscale)]);
  let named = null;
  const configPath = join(home, '.cloudflared', 'config.yml');
  if (cloudflared && await exists(configPath)) {
    try { named = parseCloudflaredConfig(await readFile(configPath, 'utf8')); } catch { named = null; }
  }
  const wantNamed = selected === 'named' || (selected === 'auto' && named?.credentialsFile);
  if (wantNamed) {
    if (!cloudflared) return { kind: 'off', mode: selected, publicUrl: '', reason: '未找到 /opt/homebrew/bin/cloudflared' };
    if (!named?.tunnel || !named.credentialsFile) return { kind: 'off', mode: selected, publicUrl: '', reason: '未找到已配置的 Cloudflare 命名隧道（~/.cloudflared/config.yml）' };
    const runtimePath = dataDir ? join(dataDir, 'cloudflared.runtime.yml') : '';
    if (runtimePath) {
      await mkdir(dataDir, { recursive: true });
      await writeFile(runtimePath, namedRuntimeConfig({ ...named, port }), { mode: 0o600 });
    }
    return {
      kind: 'named',
      mode: selected,
      command: cloudflared,
      args: runtimePath ? ['tunnel', '--config', runtimePath, '--no-autoupdate', 'run', named.tunnel] : ['tunnel', '--config', configPath, '--no-autoupdate', 'run', named.tunnel],
      publicUrl: named.hostname ? `https://${named.hostname}` : '',
      reason: named.hostname ? '' : '命名隧道已配置，但没有 hostname，公网地址未知',
    };
  }
  const wantTailscale = selected === 'tailscale' || (selected === 'auto' && tailscale);
  if (wantTailscale) {
    if (!tailscale) return { kind: 'off', mode: selected, publicUrl: '', reason: '未找到 /usr/local/bin/tailscale' };
    return {
      kind: 'tailscale',
      mode: selected,
      command: tailscale,
      args: ['funnel', String(port)],
      publicUrl: '',
      reason: '',
    };
  }
  if (!cloudflared) return { kind: 'off', mode: selected, publicUrl: '', reason: '未找到 /opt/homebrew/bin/cloudflared，也没有可用的 Tailscale' };
  // Cloudflare 文档：~/.cloudflared 里有 config.yml 时临时隧道会失败，所以给它一个空的 HOME。
  let env;
  if (dataDir) {
    const isolated = join(dataDir, 'cloudflared-home');
    await mkdir(isolated, { recursive: true });
    env = { HOME: isolated };
  }
  return {
    kind: 'quick',
    mode: selected,
    command: cloudflared,
    args: ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
    ...(env ? { env } : {}),
    publicUrl: '',
    reason: '',
  };
}

// api.trycloudflare.com 是 cloudflared 申请临时隧道时访问的接口，报错日志里会出现，不是隧道地址。
const URL_RE = /https:\/\/(?:(?!api\.)[a-z0-9-]+\.trycloudflare\.com|[a-z0-9.-]+\.ts\.net)(?:\/[^\s"')\]|]*)?/i;

export function createTunnelRunner({ spawnImpl = spawn, env = process.env, killAfterMs = 3000 } = {}) {
  let current = null;
  // 子进程自己开了新进程组（detached），按组发信号，连它起的孙进程（包装脚本里的真程序）一起停。
  const signal = (entry, name) => {
    const pid = entry.child.pid;
    if (entry.group && Number.isInteger(pid) && pid > 1) {
      try { process.kill(-pid, name); return; } catch { /* 进程组已不在，退回只杀它自己 */ }
    }
    try { entry.child.kill(name); } catch { /* already gone */ }
  };
  const kill = (entry) => {
    entry.stopping = true;
    signal(entry, 'SIGTERM');
    // 不再等管道：即使孙进程还攥着另一端，也不能让它们把事件循环一直撑着。
    entry.child.stdout?.destroy?.();
    entry.child.stderr?.destroy?.();
    const timer = setTimeout(() => signal(entry, 'SIGKILL'), killAfterMs);
    timer.unref?.();
    entry.child.once?.('exit', () => {
      clearTimeout(timer);
      // 包装脚本先退出了，但它刚 fork 出来的孙进程可能没收到那次 SIGTERM（fork 和发信号的竞争）。
      // 进程组里还有人就补一个 SIGKILL，否则它会变成孤儿继续占着 funnel / 端口。
      if (!entry.group || !Number.isInteger(entry.child.pid) || entry.child.pid <= 1) return;
      const sweep = setTimeout(() => {
        try { process.kill(-entry.child.pid, 0); } catch { return; }
        try { process.kill(-entry.child.pid, 'SIGKILL'); } catch { /* 刚好走光了 */ }
      }, 150);
      sweep.unref?.();
    });
  };
  return {
    start(plan, { onUrl, onExit, onLog } = {}) {
      this.stop();
      if (!plan?.command) {
        if (plan?.publicUrl) onUrl?.(plan.publicUrl);
        return;
      }
      if (plan.publicUrl) onUrl?.(plan.publicUrl);
      // 每个子进程自己记「是不是我们主动停的」，否则重启时旧进程的退出会被当成隧道意外掉线。
      const entry = { child: null, stopping: false, group: process.platform !== 'win32' };
      let child;
      try {
        child = spawnImpl(plan.command, plan.args, { stdio: ['ignore', 'pipe', 'pipe'], detached: entry.group, env: plan.env ? { ...env, ...plan.env } : env });
      } catch (error) {
        onExit?.(error?.code ?? 'spawn');
        return;
      }
      entry.child = child;
      current = entry;
      // unref 只管进程句柄；管道也要 unref，否则隧道进程活着时宿主（和测试）永远退不出去。
      child.unref?.();
      child.stdout?.unref?.();
      child.stderr?.unref?.();
      const take = (buf) => {
        if (entry.stopping) return;
        const text = String(buf);
        onLog?.(text);
        const match = text.match(URL_RE);
        if (match) onUrl?.(match[0].replace(/\/$/, ''));
      };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      // 起不来（权限、文件消失）时 spawn 只发 error 事件；没人听就会变成未捕获异常，把整个插件进程带崩。
      child.on('error', (error) => {
        if (current === entry) current = null;
        if (!entry.stopping) onExit?.(error?.code ?? 'spawn');
        entry.stopping = true;
      });
      child.on('exit', (code) => {
        if (current === entry) current = null;
        if (!entry.stopping) onExit?.(code);
      });
    },
    stop() {
      const entry = current;
      current = null;
      if (entry) kill(entry);
    },
  };
}

export async function probeBoard({ port, publicUrl, fetchImpl = fetch }) {
  const local = await fetchImpl(`http://127.0.0.1:${port}/healthz`).then((res) => res.ok).catch(() => false);
  let publicReachable = false;
  if (publicUrl) {
    const href = new URL('/healthz', publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`).href;
    publicReachable = await fetchImpl(href, { signal: AbortSignal.timeout(8000) }).then((res) => res.ok).catch(() => false);
  }
  return {
    listening: local,
    tunnelUp: Boolean(publicUrl),
    publicUrl: publicUrl || '',
    publicReachable,
  };
}


// ---- 自动模式的降级链 ----

export const KIND_LABEL = { named: '命名隧道', tailscale: 'Tailscale', quick: '临时隧道' };

// auto：按 命名隧道 → Tailscale Funnel → 临时隧道 的顺序，列出这台机器上都可用的方式。
// 显式模式只返回一种。
export async function planTunnelChain(options = {}) {
  const mode = TUNNEL_MODES.includes(options.mode) ? options.mode : 'auto';
  if (mode !== 'auto') return [await planTunnel({ ...options, mode })];
  const plans = [];
  for (const kind of ['named', 'tailscale', 'quick']) {
    const plan = await planTunnel({ ...options, mode: kind });
    if (plan.kind === kind) plans.push({ ...plan, mode: 'auto' });
    else if (kind === 'quick' && !plans.length) plans.push({ ...plan, mode: 'auto' });
  }
  return plans;
}

// 把隧道程序的输出和退出码翻成一句人话。
export function explainTunnelFailure(kind, output = '', code = null) {
  const text = String(output);
  if (kind === 'tailscale') {
    if (/Funnel is not enabled|\/f\/funnel/i.test(text)) {
      const link = text.match(/https:\/\/login\.tailscale\.com\/f\/funnel\S*/)?.[0];
      return `Tailscale 没有开启 Funnel${link ? `（到 ${link} 开启）` : ''}`;
    }
    if (/HTTPS.*(not enabled|disabled)|enable HTTPS/i.test(text)) return 'Tailscale 没有开启 HTTPS 证书';
    if (/GUI failed to start/i.test(text)) return 'Tailscale 命令行起不来（GUI failed to start）';
    if (/logged out|NeedsLogin|not logged in|Log in at/i.test(text)) return 'Tailscale 没有登录';
    return `Tailscale 退出了，没有给出公网地址${code === null || code === undefined ? '' : `（退出码 ${code}）`}`;
  }
  const label = KIND_LABEL[kind] || '隧道';
  if (/429|Too Many Requests|rate limit/i.test(text)) return `${label}被限流了`;
  if (/config\.ya?ml/i.test(text) && /quick/i.test(text)) return `${label}被 ~/.cloudflared/config.yml 挡住了`;
  return `${label}进程退出了${code === null || code === undefined ? '' : `（退出码 ${code}）`}`;
}

const DEFAULT_TIMEOUTS = { tailscale: 15_000, quick: 45_000, named: 30_000 };

/**
 * 负责「起一种隧道 → 等地址 → 失败了就按链往下换」。
 * onState 收到 { kind, mode, publicUrl, reason }；reason 里写清楚为什么失败、换成了什么。
 */
export function createTunnelSupervisor({
  runner,
  plan,
  onState,
  onLog,
  timeouts = DEFAULT_TIMEOUTS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let seq = 0;
  let timer = null;
  const clear = () => { if (timer) clearTimer(timer); timer = null; };

  function attempt(plans, index, notes, token, mode) {
    const current = plans[index];
    const emit = (patch) => { if (token === seq) onState?.({ kind: current.kind, mode, publicUrl: '', reason: '', ...patch }); };
    if (!current.command && !current.publicUrl) {
      emit({ kind: 'off', reason: [...notes, current.reason].filter(Boolean).join('；') });
      return;
    }
    let output = '';
    let gotUrl = false;
    let failed = false;
    const failWith = (why) => {
      if (failed || token !== seq) return;
      failed = true;
      clear();
      runner.stop();
      const next = plans[index + 1];
      if (mode === 'auto' && next) {
        const note = `${why}，已改用${KIND_LABEL[next.kind] || next.kind}`;
        emit({ reason: [...notes, note].join('；') });
        attempt(plans, index + 1, [...notes, note], token, mode);
        return;
      }
      emit({ reason: [...notes, why].join('；') });
    };
    // 输出里已经明说失败原因的（比如没开 Funnel），不用干等超时。
    const sniff = () => {
      if (current.kind === 'tailscale' && !gotUrl && /Funnel is not enabled|GUI failed to start/i.test(output)) failWith(explainTunnelFailure('tailscale', output, null));
    };
    runner.start(current, {
      onUrl: (url) => {
        if (token !== seq || failed) return;
        gotUrl = true;
        clear();
        emit({ publicUrl: url, reason: notes.join('；') });
      },
      onExit: (code) => failWith(explainTunnelFailure(current.kind, output, code)),
      onLog: (text) => { output = (output + text).slice(-4000); onLog?.(text); sniff(); },
    });
    if (failed || token !== seq) return;
    if (current.command && !gotUrl) {
      emit({ reason: [...notes, current.reason].filter(Boolean).join('；') });
      // 命名隧道没配 hostname 时本来就不知道地址，只要进程还在就算正常，不设超时。
      if (current.kind === 'named') return;
      const limit = timeouts[current.kind] ?? 30_000;
      timer = setTimer(() => {
        if (gotUrl || failed || token !== seq) return;
        const why = explainTunnelFailure(current.kind, output, null);
        failWith(`${why.replace(/，没有给出公网地址$/, '')}（${Math.round(limit / 1000)} 秒内没有拿到公网地址）`);
      }, limit);
      timer.unref?.();
    }
  }

  return {
    async start(mode = 'auto') {
      const token = ++seq;
      clear();
      runner.stop();
      let plans;
      try {
        plans = [].concat(await plan(mode)).filter(Boolean);
      } catch (error) {
        if (token === seq) onState?.({ kind: 'off', mode, publicUrl: '', reason: error?.message || '隧道配置失败' });
        return;
      }
      if (token !== seq) return;
      if (!plans.length) plans = [{ kind: 'off', reason: '没有可用的隧道方式' }];
      attempt(plans, 0, [], token, mode);
    },
    stop() {
      seq += 1;
      clear();
      runner.stop();
    },
  };
}
