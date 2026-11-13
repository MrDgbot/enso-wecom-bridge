// Real built plugin + headless Chrome at a 320px sidebar width.
// Not part of `npm test`. Run after `npm run build`: npm run test:panel-smoke
// Walks 本会话 / 聊天 / 任务 / 设置. The 看板 tab is covered by test/panel.test.mjs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { activate, deactivate } from '../plugin/main.mjs';
import { emptyState } from '../src/core.mjs';
import './no-tunnel.mjs';

const { chromium } = createRequire(join(homedir(), 'package.json'))('playwright');
const dataDir = await mkdtemp(join(tmpdir(), 'wecom-ui-smoke-'));
const handlers = new Map();
const state = emptyState();
state.chats['group:g'] = { kind: 'group', target: 'g', lastUserid: 'li', userids: ['li', 'zhang'], lastText: '在吗', lastAt: 5 };
state.names = { g: '测试群', li: '李四', zhang: '张三' };
state.bindings['group:g'] = { sessionId: 'B', title: '群默认 B', projectRoot: '/B' };
// Discovered from the bot's recent-session list; nobody has @-ed the bot there yet.
state.autoNames = { botId: '', users: {}, groups: { g2: '新发现群' }, updatedAt: 1 };
state.tasks = [{ id: 't1', chatKey: 'group:g', userid: 'li', text: '冒烟任务', status: 'replied', reply: '已处理', sessionId: 'B', projectRoot: '/B', createdAt: 5, updatedAt: 6 }];
await writeFile(join(dataDir, 'state.json'), JSON.stringify(state));

const saved = async () => JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
async function waitSaved(pred, what) {
  for (let i = 0; i < 50; i++) {
    if (pred(await saved())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`state.json never reached: ${what}`);
}

let browser;
try {
  activate({
    dataDir, config: { get: async () => ({}) },
    tools: { register: (name, fn) => handlers.set(name, fn) },
    renderer: { handle: (name, fn) => handlers.set(name, fn) },
    events: { on() {} },
    session: { list: async () => ({ sessions: [{ id: 'B', title: '群默认 B' }, { id: 'C', title: '李四 C' }] }) },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 960 } });
  await page.exposeFunction('hostCall', (method, args) => handlers.get(method)(args, { sessionId: 'C', projectRoot: '/C' }));
  await page.setContent('<html><body></body></html>');
  await page.evaluate(() => {
    window.enso = Object.freeze({ theme: 'dark', onTheme() {}, call: window.hostCall });
  });
  await page.setContent(await readFile(new URL('../plugin/panel.html', import.meta.url), 'utf8'));

  /** Clicks the first visible [data-act] whose data-* values include every `has` entry. */
  const clickAct = (act, has = []) => page.waitForFunction(([act, has]) => {
    const shown = (el) => {
      for (let n = el; n; n = n.parentElement) {
        if (n.hidden || getComputedStyle(n).display === 'none') return false;
        if (n.tagName === 'DETAILS' && !n.open && n !== el && !el.closest('summary')) return false;
      }
      return true;
    };
    const el = [...document.querySelectorAll(`[data-act="${act}"]`)]
      .find((e) => shown(e) && has.every((v) => Object.values(e.dataset).includes(v)));
    if (!el) return false;
    el.click();
    return true;
  }, [act, has], { timeout: 5000 });
  const textIncludes = (...parts) => page.waitForFunction((parts) => parts.every((p) => document.body.innerText.includes(p)), parts, { timeout: 5000 });
  const fits = async (tab) => {
    const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert.equal(ok, true, `tab ${tab} fits the 320px sidebar without horizontal overflow`);
    await page.screenshot({ path: `/tmp/wecom-0.1.23-panel-${tab}.png`, fullPage: true });
  };

  await page.waitForSelector('[data-act="tab"][data-tab="here"]', { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await textIncludes('李四 C');
  await fits('here');

  // 本会话: picker routes one group member here; 恢复群默认 needs a second click.
  await clickAct('picker');
  await clickAct('bindMember', ['group:g', 'li']);
  await waitSaved((s) => s.memberBindings?.['group:g']?.li?.sessionId === 'C', 'li routed to C');
  let s = await saved();
  assert.equal(s.bindings['group:g'].sessionId, 'B');
  assert.equal(s.memberBindings['group:g'].zhang, undefined);
  await fits('here-bound');
  await clickAct('resetMember', ['group:g', 'li']);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await saved()).memberBindings['group:g'].li?.sessionId, 'C', 'first 恢复群默认 click only arms');
  await clickAct('resetMember', ['group:g', 'li']);
  await waitSaved((s) => s.memberBindings?.['group:g']?.li === undefined, 'li back on group default');

  // 聊天: every chat shows immediately, including the discovered one, with no project filter fiddling.
  await clickAct('tab', ['chats']);
  await textIncludes('测试群', '新发现群', '来自最近会话');
  await fits('chats');

  // 任务
  await clickAct('tab', ['tasks']);
  await textIncludes('冒烟任务', '已处理');
  await fits('tasks');

  // 设置: outbound policy switch leaves bindings alone.
  await clickAct('tab', ['settings']);
  await page.waitForSelector('#outbound-section', { state: 'visible', timeout: 5000 });
  await clickAct('setOutboundMode', ['all-sessions']);
  await waitSaved((s) => s.outbound?.mode === 'all-sessions', 'outbound all-sessions');
  s = await saved();
  assert.equal(s.bindings['group:g'].sessionId, 'B');
  await fits('settings');

  assert.equal(typeof handlers.get('send_reply'), 'function');
  assert.equal(typeof handlers.get('reply_targets'), 'function');
  console.log('Built plugin + Chrome panel passed at 320px for 本会话/聊天/任务/设置. Group B unchanged; Li C saved and reset; no bot connection or external messages.');
} finally {
  deactivate();
  await browser?.close();
  await rm(dataDir, { recursive: true, force: true });
}
