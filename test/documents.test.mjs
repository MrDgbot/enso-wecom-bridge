import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createDocumentReader } from '../src/documents.mjs';
import { buildPrompt, emptyState } from '../src/core.mjs';

const response = (data) => new Response(JSON.stringify(data));
const wrapped = (result) => response({ results_json: JSON.stringify({ result: JSON.stringify(result) }) });
const credentials = { botId: 'test-bot', secret: 'test-only-secret' };

test('document reader uses signed auth and only the fixed read endpoints with correct envelopes', async () => {
  const requests = [];
  let auths = 0;
  const read = createDocumentReader(credentials, async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(init.redirect, 'error');
    if (url.endsWith('get_cli_config')) {
      auths++;
      assert.equal(body.signature, createHash('sha256').update(`${credentials.secret}${credentials.botId}${body.time}${body.nonce}`).digest('hex'));
      assert.equal(init.headers.Authorization, undefined);
      return response({ token: 'test-token' });
    }
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    requests.push([url, JSON.parse(body.payload)]);
    return wrapped({ cells: [['risk', 2]], truncated: false });
  });
  const docid = 'https://doc.weixin.qq.com/sheet/e3_example';
  await read({ action: 'sheet_info', docid });
  const result = await read({ action: 'sheet_cells', docid, sheet: '风险', range: 'A1:B2', extra: 'ignored' });
  await read({ action: 'doc_content', docid: 'e3_example' });
  assert.equal(auths, 1);
  assert.deepEqual(result.cells, [['risk', 2]]);
  assert.deepEqual(requests.map(([url]) => new URL(url).pathname + new URL(url).search), [
    '/cli/sheet/get', '/cli/office_tool/execute?id=sheet_cells_get', '/cli/doc/contents/get',
  ]);
  assert.deepEqual(requests[1][1], { docid, sheet: '风险', range: 'A1:B2' });
  assert.deepEqual(requests[2][1], { docid: 'e3_example', content_type: 'text' });
});

test('write actions, foreign URLs and unbounded sheet reads are rejected before auth', async () => {
  const read = createDocumentReader(credentials, async () => assert.fail('must not send a request'));
  for (const args of [
    { action: 'sheet_update', docid: 'e3_example' },
    { action: 'sheet_info', docid: 'https://example.com/sheet/e3_example' },
    { action: 'sheet_cells', docid: 'e3_example', full: true },
    { action: 'sheet_cells', docid: 'e3_example', range: 'A0:B2' },
  ]) await assert.rejects(read(args));
});

test('inner expired auth retries once and permission failures keep the code without leaking server text', async () => {
  let auths = 0;
  let calls = 0;
  const read = createDocumentReader(credentials, async (url) => {
    if (url.endsWith('get_cli_config')) { auths++; return response({ token: 'test-token' }); }
    calls++;
    if (calls === 1) return response({ results_json: JSON.stringify({ error: { code: 853004, message: 'private' } }) });
    return wrapped({ errcode: 851008, errmsg: 'private-token-and-secret' });
  });
  await assert.rejects(read({ action: 'sheet_info', docid: 'e3_example' }), (error) => {
    assert.equal(error.code, 851008);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.equal(auths, 2);
  assert.equal(calls, 2);
});

test('document messages and quotes guide the agent to the authenticated tool rather than web fetching', () => {
  for (const content of [{ text: '看看 https://doc.weixin.qq.com/sheet/e3_example' }, { text: '总结', quote: 'https://doc.weixin.qq.com/doc/e3_example' }]) {
    const prompt = buildPrompt(emptyState(), { chatKey: 'single:u', userid: 'u', content });
    assert.match(prompt, /plugin_local-wecombridge__read_document/);
    assert.match(prompt, /sheet_info.*sheet_cells/);
    assert.match(prompt, /不要用 web_fetch/);
  }
  assert.doesNotMatch(buildPrompt(emptyState(), { chatKey: 'single:u', userid: 'u', content: { text: '你好' } }), /read_document/);
});
