import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { emptyState } from '../src/core.mjs';
import { boardAdd, createShare, revokeShare } from '../src/board.mjs';
import { createBoardHandler } from '../src/web-board.mjs';

async function serve(state) {
  const server = createServer(createBoardHandler({
    getState: async () => state,
    update: async (fn) => fn(state),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const ask = async (path, options) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
    const text = await res.text();
    return { status: res.status, text };
  };
  return { ask, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('web board hides data without a token and enforces revoke, project, requester and read-only', async () => {
  const state = emptyState();
  boardAdd(state, { chatKey: 'group:alpha', title: '合并报表', status: '待做', requesterId: 'owner-a', requesterName: '用户甲', source: 'wecom', taskIds: ['t1'] }, 1);
  boardAdd(state, { chatKey: 'group:beta', title: '另一个项目的决定', status: '待决定', requesterId: 'owner-b', source: 'wecom' }, 2);
  boardAdd(state, { chatKey: 'group:alpha', title: '别人提的主题问题', status: '待做', requesterId: 'owner-b', source: 'wecom' }, 3);
  const reader = createShare(state, { name: '只读同事', role: 'read', projects: ['group:alpha'] });
  const decider = createShare(state, { name: '拍板同事', role: 'decide', projects: ['group:alpha'], onlyMine: true, requesterId: 'owner-a' });
  const web = await serve(state);
  try {
    const anon = await web.ask('/');
    assert.equal(anon.status, 401);
    assert.doesNotMatch(anon.text, /合并报表/);
    const missing = await web.ask('/s/not-a-real-token');
    assert.equal(missing.status, 401);
    assert.doesNotMatch(missing.text, /合并报表/);
    const page = await web.ask(`/s/${reader.token}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /合并报表/);
    assert.match(page.text, /别人提的主题问题/);
    assert.doesNotMatch(page.text, /另一个项目的决定/);
    const denied = await web.ask(`/s/${reader.token}/items/${state.board.items[0].id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: '完成' }) });
    assert.equal(denied.status, 403);
    assert.match(denied.text, /只读/);
    assert.equal(state.board.items[0].status, 'todo');
    const mine = await web.ask(`/s/${decider.token}/api`);
    assert.equal(mine.status, 200);
    assert.match(mine.text, /合并报表/);
    assert.doesNotMatch(mine.text, /别人提的主题问题/);
    const changed = await web.ask(`/s/${decider.token}/items/${state.board.items[0].id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: '进行中', decision: '按套做', decidedBy: '' }) });
    assert.equal(changed.status, 200);
    assert.equal(state.board.items[0].status, 'doing');
    assert.equal(state.board.items[0].decidedBy, '拍板同事');
    const outside = await web.ask(`/s/${decider.token}/items/${state.board.items[1].id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: '放弃' }) });
    assert.equal(outside.status, 404);
    revokeShare(state, reader.id);
    const revoked = await web.ask(`/s/${reader.token}`);
    assert.equal(revoked.status, 401);
    const owner = await web.ask(`/a/${state.board.ownerToken}/api`);
    assert.equal(owner.status, 200);
    assert.match(owner.text, /另一个项目的决定/);
    const layout = await web.ask(`/s/${decider.token}/layout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groupBy: 'requester', sort: 'created', fields: ['delivery'] }) });
    assert.equal(layout.status, 200);
    assert.equal(state.board.layouts[decider.id].groupBy, 'requester');
    assert.ok(state.board.accessLog.some((entry) => entry.who === decider.id));
    assert.equal(JSON.stringify(state.board.accessLog).includes(decider.token), false);
  } finally {
    await web.close();
  }
});
