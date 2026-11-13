import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import { emptyState } from '../src/core.mjs';
import { boardAdd, createShare } from '../src/board.mjs';
import { createBoardHandler } from '../src/web-board.mjs';

async function serve(state, extra = {}) {
  let saves = 0;
  const server = createServer(createBoardHandler({
    getState: async () => state,
    update: async (fn) => { saves += 1; return fn(state); },
    projects: (current) => Object.keys(current.chats || {}),
    ...extra,
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const ask = async (path, options) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
  const raw = (line) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`${line}\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let out = '';
    socket.on('data', (chunk) => { out += chunk; });
    socket.on('close', () => resolve(out.split('\r\n')[0]));
    socket.on('error', () => resolve(''));
  });
  return { ask, raw, saves: () => saves, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('a malformed request target cannot crash the process through an unhandled rejection', async () => {
  const state = emptyState();
  const web = await serve(state);
  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on('unhandledRejection', onRejection);
  try {
    assert.match(await web.raw('GET //[ HTTP/1.1'), /^HTTP\/1\.1 4\d\d/);
    assert.match(await web.raw('GET /a/%E0%A4%A HTTP/1.1'), /^HTTP\/1\.1 4\d\d/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
    await web.close();
  }
});

test('rejected requests are not written to disk on every hit and bad-shaped tokens never touch state', async () => {
  const state = emptyState();
  let clock = 1_000;
  const web = await serve(state, { now: () => clock });
  try {
    for (let i = 0; i < 20; i++) assert.equal((await web.ask(`/s/${'x'.repeat(24)}${i}`)).status, 401);
    assert.equal((await web.ask('/s/short')).status, 401);
    assert.equal(web.saves(), 1);
    assert.equal(state.board.accessLog.length, 1);
    clock += 61_000;
    await web.ask(`/s/${'y'.repeat(30)}`);
    assert.equal(state.board.accessLog.length, 2);
  } finally {
    await web.close();
  }
});

test('page view logging is throttled per link', async () => {
  const state = emptyState();
  const share = createShare(state, { name: '同事', role: 'read', projects: ['group:a'] });
  const web = await serve(state, { now: () => 5_000 });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await web.ask(`/s/${share.token}`)).status, 200);
    assert.equal(state.board.accessLog.filter((entry) => entry.action === 'view').length, 1);
  } finally {
    await web.close();
  }
});

test('a decide link cannot sign as someone else, and share pages do not list every project', async () => {
  const state = emptyState();
  state.chats['group:secret-room'] = { userids: [] };
  state.chats['group:a'] = { userids: [] };
  boardAdd(state, { chatKey: 'group:a', title: '可见需求', status: '待决定', requesterId: 'u1' }, 1);
  const decider = createShare(state, { name: '小王', role: 'decide', projects: ['group:a'] });
  const web = await serve(state);
  try {
    const page = await web.ask(`/s/${decider.token}`);
    assert.doesNotMatch(page.text, /secret-room/);
    const owner = await web.ask(`/a/${state.board.ownerToken}`);
    assert.match(owner.text, /secret-room/);
    const res = await web.ask(`/s/${decider.token}/items/${state.board.items[0].id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: '待做', decision: '做', decidedBy: '老板' }) });
    assert.equal(res.status, 200);
    assert.equal(state.board.items[0].decidedBy, '小王');
    const ownerPost = await web.ask(`/a/${state.board.ownerToken}/items/${state.board.items[0].id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decidedBy: '老板' }) });
    assert.equal(ownerPost.status, 200);
    assert.equal(state.board.items[0].decidedBy, '所有者', 'even the owner page cannot type someone else as the decider');
    const nonObject = await web.ask(`/a/${state.board.ownerToken}/items/${state.board.items[0].id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
    assert.equal(nonObject.status, 200);
  } finally {
    await web.close();
  }
});

test('a link revoked while its request body was still arriving cannot write', async () => {
  const state = emptyState();
  boardAdd(state, { chatKey: 'group:a', title: '可见需求', status: '待决定' }, 1);
  const decider = createShare(state, { name: '小王', role: 'decide', projects: ['group:a'] });
  const web = await serve(state, {
    update: async (fn) => { decider.revoked = true; return fn(state); },
  });
  try {
    const res = await web.ask(`/s/${decider.token}/items/${state.board.items[0].id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: '待做' }) });
    assert.equal(res.status, 401);
    assert.equal(state.board.items[0].status, 'pending_decision');
  } finally {
    await web.close();
  }
});

test('board pages carry a restrictive CSP and cannot be framed', async () => {
  const state = emptyState();
  const share = createShare(state, { name: '同事', role: 'read', projects: ['group:a'] });
  const web = await serve(state);
  try {
    const page = await web.ask(`/s/${share.token}`);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    await web.close();
  }
});

test('untrusted WeCom text never reaches the page as markup', async () => {
  const state = emptyState();
  const payload = '</script><img src=x onerror=alert(1)>';
  boardAdd(state, { chatKey: 'group:a', title: payload, detail: payload, status: '待做', requesterName: payload }, 1);
  const share = createShare(state, { name: '同事', role: 'read', projects: ['group:a'] });
  const web = await serve(state);
  try {
    const page = await web.ask(`/s/${share.token}`);
    assert.equal(page.text.includes(payload), false);
    assert.equal((page.text.match(/<\/script>/g) || []).length, 1);
  } finally {
    await web.close();
  }
});
