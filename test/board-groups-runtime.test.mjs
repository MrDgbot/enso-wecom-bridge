import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activate, deactivate } from '../src/main.mjs';
import { boardAdd } from '../src/board.mjs';
import { emptyState, namedAccessLog } from '../src/core.mjs';
import './no-tunnel.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the sidebar group choice goes through the host and is stored in the owner layout', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-groups-'));
  const state = emptyState();
  state.autoNames = { botId: '', users: {}, groups: { a: '甲群', b: '乙群' }, updatedAt: 1 };
  boardAdd(state, { chatKey: 'group:a', title: '甲的需求', status: '待做', requesterId: 'u', source: 'wecom' }, 1);
  boardAdd(state, { chatKey: 'group:b', title: '乙的需求', status: '待做', requesterId: 'u', source: 'wecom' }, 2);
  await writeFile(join(dataDir, 'state.json'), JSON.stringify(state));
  const handlers = new Map();
  activate({
    dataDir,
    config: { get: async () => ({ botId: '', secret: '' }) },
    tools: { register() {} },
    events: { on() {} },
    renderer: { handle: (name, fn) => handlers.set(name, fn) },
    ui: { view: { emit() {} } },
  });
  try {
    await sleep(100);
    const first = await handlers.get('snapshot')({});
    assert.deepEqual(first.board.groups.map((g) => g.name).sort(), ['乙群', '甲群']);
    assert.equal(first.board.layout.group, '');
    const next = await handlers.get('setBoardGroup')({ group: 'group:b' }, {});
    assert.equal(next.board.layout.group, 'group:b');
    assert.deepEqual(next.board.items.map((i) => i.chatName).sort(), ['乙群', '甲群'], 'the host sends all items; the panel filters');
    const cleared = await handlers.get('setBoardGroup')({ group: 'not a chat' }, {});
    assert.equal(cleared.board.layout.group, '');
  } finally {
    deactivate();
    await sleep(30);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the access log shows who visited by name instead of a bare id', () => {
  const state = emptyState();
  state.board.shares.push({ id: 's-1', name: '外包同事', token: 'x'.repeat(20), projects: ['group:a'], role: 'read' });
  const log = namedAccessLog(state, [{ who: 'owner' }, { who: 's-1' }, { who: 'rejected' }, { who: 's-gone' }, { who: '' }]);
  assert.deepEqual(log.map((e) => e.whoName), ['所有者', '分享「外包同事」', '被拒绝的访问', '已删除的链接', '匿名']);
});
