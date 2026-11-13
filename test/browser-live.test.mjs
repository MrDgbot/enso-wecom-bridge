import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './no-tunnel.mjs';

test('built plugin reads by default without a bot connection and respects revoke', {
  skip: !process.env.WECOM_BROWSER_TEST_URL,
}, async () => {
  const { activate, deactivate } = await import('../plugin/main.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'wecom-browser-live-'));
  const handlers = new Map();
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    bindings: { 'single:test': { sessionId: 'test-session' } },
    chats: { 'single:test': { kind: 'single', target: 'test' } }, tasks: [],
  }));
  try {
    activate({
      dataDir: dir, config: { get: async () => ({ botId: 'test-without-secret' }) },
      tools: { register: (name, fn) => handlers.set(name, fn) },
      renderer: { handle: (name, fn) => handlers.set(name, fn) }, events: { on() {} },
    });
    const ctx = { sessionId: 'test-session' };
    const args = { action: 'browser_view', docid: process.env.WECOM_BROWSER_TEST_URL, range: 'A3:C4' };
    const output = await handlers.get('read_document')(args, ctx);
    const result = JSON.parse(output.content.slice(output.content.indexOf('\n') + 1));
    assert.equal(result.source, 'browser_sheet_model');
    assert.equal(result.cells.length, 6);
    assert.equal(result.cells[0].address, 'A3');
    assert.ok(result.cells.some(c => c.status === 'value'));
    await handlers.get('grantBrowserDocuments')({ chatKey: 'single:test', links: '' }, ctx);
    await assert.rejects(handlers.get('read_document')(args, ctx), /网页读取未授权/);
  } finally { deactivate(); await rm(dir, { recursive: true, force: true }); }
});
