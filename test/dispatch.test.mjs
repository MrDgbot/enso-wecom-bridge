import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ackText } from '../src/core.mjs';
import { createDispatcher } from '../src/dispatch.mjs';

test('same-chat work is serialized and rate limits retry instead of failing the message', async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const dispatcher = createDispatcher({ coalesceMs: 0, rateDelay: 5, retryDelays: [0, 0, 0] });
  const first = dispatcher.enqueueChat('group:g', async () => {
    order.push('first-start');
    await gate;
    order.push('first-end');
  });
  const second = dispatcher.enqueueChat('group:g', async () => { order.push('second'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first-start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  dispatcher.begin('S', 'batch');
  const retry = dispatcher.failAttempt('S', Object.assign(new Error('busy'), { code: 'RATE_LIMITED' }));
  assert.equal(retry.action, 'retry');
  assert.equal(dispatcher.isBusy('S'), true);
  assert.equal(dispatcher.endRun('S', '').action, 'retry-empty');
  assert.equal(dispatcher.endRun('S', '').action, 'give-up');
  assert.equal(dispatcher.isBusy('S'), false);
  dispatcher.stop();
});

test('busy sessions acknowledge a queue instead of claiming the work has started', () => {
  assert.match(ackText({ busy: true }), /已排队/);
  assert.doesNotMatch(ackText({ busy: true }), /已交给/);
  assert.match(ackText({ title: '修复登录' }), /已交给 EnsoCode 会话「修复登录」处理/);
  assert.match(ackText({ busy: true, title: '修复登录' }), /会话「修复登录」/);
});
