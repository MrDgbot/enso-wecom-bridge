import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createSessionLookup } from '../src/session-names.mjs';
import { emptyState, mergeSessionNames, normalizeState, displayName, buildPrompt, resetNameScope } from '../src/core.mjs';

const response = (data) => ({ ok: true, json: async () => data });
const sessionResponse = (sessions) => response({ errcode: 0, results_json: JSON.stringify({ result: JSON.stringify({ sessions }) }) });

test('names are scoped to a bot, persist independently of remarks, and never confuse groups with users', () => {
  const s = emptyState();
  mergeSessionNames(s, 'bot', [
    { chat_type: 'single', chat_id: 'u', chat_name: '测试成员' },
    { chat_type: 'group', chat_id: 'g', chat_name: '研发群' },
    { chat_type: 'unknown', chat_id: 'x', chat_name: 'bad' },
  ], 1);
  assert.equal(displayName(s, 'u'), '测试成员');
  assert.match(displayName(s, 'g'), /姓名未获取/);
  assert.equal(displayName(s, 'g', '群名未获取', 'group'), '研发群');
  assert.match(buildPrompt(s, { chatKey: 'group:g', userid: 'u', content: { text: 'hi' } }), /研发群.*测试成员/);
  s.names.u = '本地备注';
  mergeSessionNames(s, 'bot', [], 2);
  assert.equal(displayName(s, 'u'), '本地备注');
  assert.equal(normalizeState(JSON.parse(JSON.stringify(s)), { botId: 'bot' }).autoNames.users.u, '测试成员');
  assert.deepEqual(normalizeState(s, { botId: 'other' }).autoNames.users, {});
  resetNameScope(s, 'other');
  assert.deepEqual(s.autoNames.groups, {});
  assert.equal(s.names.u, '本地备注');
  assert.match(displayName(s, 'constructor'), /姓名未获取/);
});

test('lookup signs bootstrap, caches token in memory and decodes both JSON envelopes', async () => {
  let auth = 0;
  let requests = 0;
  const lookup = createSessionLookup({ botId: 'bot', secret: 'test-secret' }, async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.endsWith('get_cli_config')) {
      auth++;
      const b = JSON.parse(options.body);
      assert.equal(b.signature, createHash('sha256').update(`test-secretbot${b.time}${b.nonce}`).digest('hex'));
      assert.equal(options.headers.Authorization, undefined);
      return response({ errcode: 0, token: 'test-token' });
    }
    requests++;
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(options.body), { payload: '{}' });
    return sessionResponse([{ chat_type: 'single', chat_id: 'u', chat_name: '测试成员' }]);
  });
  assert.equal((await lookup())[0].chat_name, '测试成员');
  await lookup();
  assert.equal(auth, 1);
  assert.equal(requests, 2);
});

test('expired token retries once and API/network errors never echo credentials or response bodies', async () => {
  let auth = 0;
  let calls = 0;
  const lookup = createSessionLookup({ botId: 'bot', secret: 'private' }, async (url) => {
    if (url.endsWith('get_cli_config')) return response({ token: `token-${++auth}` });
    calls++;
    if (calls === 1) return response({ errcode: 853004, errmsg: 'private token' });
    return sessionResponse([]);
  });
  assert.deepEqual(await lookup(), []);
  assert.equal(auth, 2);
  const denied = createSessionLookup({ botId: 'bot', secret: 'private' }, async () => response({ errcode: 850002, errmsg: 'private token' }));
  await assert.rejects(denied, { message: '名称查询失败（错误码 850002）' });
  const broken = createSessionLookup({ botId: 'bot', secret: 'private' }, async () => { throw new Error('private token'); });
  await assert.rejects(broken, (error) => {
    assert.equal(error.message, '名称同步网络请求失败，请稍后重试');
    assert.match(String(error.cause?.message ?? ''), /private token/);
    assert.doesNotMatch(error.message, /private token/);
    return true;
  });
});
