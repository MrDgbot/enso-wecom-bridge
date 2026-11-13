import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyState, bind } from '../src/core.mjs';
import { documentPath, parseBrowserRange, readSheetModel, grantBrowserDocuments, requireBrowserGrant } from '../src/browser-document.mjs';

test('all scope persists without broadening old grants and keeps bot, chat and host boundaries', () => {
  const s = emptyState();
  bind(s, 'single:u', { sessionId: 's' });
  s.bindings['single:u'].browserDocuments = { botId: 'bot', paths: ['/sheet/one'] };
  assert.ok(requireBrowserGrant(s, 's', 'bot', 'https://doc.weixin.qq.com/sheet/one'));
  assert.throws(() => requireBrowserGrant(s, 's', 'bot', 'https://doc.weixin.qq.com/sheet/two'));
  assert.throws(() => grantBrowserDocuments(s, 'single:u', 's', 'bot', '', 'typo'));
  grantBrowserDocuments(s, 'single:u', 's', 'bot', '', 'all');
  const saved = JSON.parse(JSON.stringify(s));
  assert.ok(requireBrowserGrant(saved, 's', 'bot', 'https://doc.weixin.qq.com/sheet/two'));
  assert.throws(() => requireBrowserGrant(saved, 's', 'other', 'https://doc.weixin.qq.com/sheet/two'));
  assert.throws(() => requireBrowserGrant(saved, 's', 'bot', 'https://evil.test/sheet/two'));
  bind(saved, 'single:v', { sessionId: 'other' });
  assert.ok(requireBrowserGrant(saved, 'other', 'bot', 'https://doc.weixin.qq.com/sheet/two'));
  grantBrowserDocuments(saved, 'single:u', 's', 'bot', '');
  assert.throws(() => requireBrowserGrant(saved, 's', 'bot', 'https://doc.weixin.qq.com/sheet/two'));
  grantBrowserDocuments(saved, 'single:u', 's', 'bot', '', 'all');
  bind(saved, 'single:u', { sessionId: 'new' });
  assert.ok(requireBrowserGrant(saved, 'new', 'bot', 'https://doc.weixin.qq.com/sheet/two'));
  s.bindings['single:u'].browserDocuments.scope = 'unknown';
  s.bindings['single:u'].browserDocuments.paths = ['/sheet/two'];
  assert.throws(() => requireBrowserGrant(s, 's', 'bot', 'https://doc.weixin.qq.com/sheet/two'));
});

test('unset grants default to all while revoked and malformed grants stay denied after reload', () => {
  const s = emptyState();
  bind(s, 'single:u', { sessionId: 's' });
  const url = 'https://doc.weixin.qq.com/sheet/demo';
  const read = (state = s) => requireBrowserGrant(state, 's', 'bot', url);
  assert.ok(read());
  assert.ok(read(JSON.parse(JSON.stringify(s))));
  assert.throws(() => requireBrowserGrant(s, 's', '', url));
  assert.throws(() => requireBrowserGrant(s, 'unbound', 'bot', url));
  assert.throws(() => requireBrowserGrant(s, 's', 'bot', 'https://evil.test/sheet/demo'));
  bind(s, 'single:v', { sessionId: 's' });
  assert.throws(() => read(), /只绑定一个/);
  delete s.bindings['single:v'];
  for (const invalid of [null, {}, { scope: 'unknown', botId: 'bot' }]) {
    s.bindings['single:u'].browserDocuments = invalid;
    assert.throws(() => read());
  }
  grantBrowserDocuments(s, 'single:u', 's', 'bot', '');
  assert.throws(() => read(JSON.parse(JSON.stringify(s))), /未授权/);
});

test('browser range accepts bounded A1 rectangles and rejects executable or excessive input', () => {
  assert.deepEqual(parseBrowserRange('A3:C4'), { startRow: 2, endRow: 3, startCol: 0, endCol: 2, range: 'A3:C4' });
  for (const range of ['A0:B1', 'C4:A1', 'A1:ZZ99999', 'A1;alert(1)', 'XFE1:XFE2']) assert.throws(() => parseBrowserRange(range));
  assert.throws(() => documentPath('https://doc.weixin.qq.com.evil.test/sheet/id'));
});

test('sheet reader returns exact addressed values without setters, OCR or screen position', () => {
  const sheet = {
    getSheetId: () => 's1', getSheetName: () => '明细', getRowCount: () => 201, getColCount: () => 26,
    getIsInitialized: () => true,
    getCellDataAtPosition: (r, c) => ({ type: 4, value: r === 2 ? ['序号', 'SKU', '产品'][c] : [1, 'AS-ZTB42', '双头蒸汽拖把'][c] }),
  };
  const app = { workbook: { activeSheetId: 's1', worksheetManager: { getSheetList: () => [sheet] } } };
  const result = readSheetModel(app, { sheet: '明细', ...parseBrowserRange('A3:C4') });
  assert.equal(result.source, 'browser_sheet_model');
  assert.equal(result.coverage, 'loaded_range');
  assert.equal(result.cells.find(c => c.address === 'C4').value, '双头蒸汽拖把');
  assert.equal(result.cells.find(c => c.address === 'A4').value, 1);
  assert.equal(result.range, 'A3:C4');
  assert.equal(result.ocr, undefined);
  assert.throws(() => readSheetModel(app, { sheet: 'missing', ...parseBrowserRange('A1:A1') }), /子表/);
  sheet.getIsInitialized = () => false;
  assert.throws(() => readSheetModel(app, parseBrowserRange('A1:A1')), /尚未加载/);
});

test('missing cells and unsupported value types are explicit rather than silently decoded', () => {
  const sheet = {
    getSheetId: () => 's', getSheetName: () => 'S', getRowCount: () => 10, getColCount: () => 10,
    getIsInitialized: () => true,
    getCellDataAtPosition: (r, c) => c ? { value: { unknown: 'value' }, type: 99 } : undefined,
  };
  const app = { workbook: { activeSheetId: 's', worksheetManager: { getSheetList: () => [sheet] } } };
  const result = readSheetModel(app, parseBrowserRange('A1:B1'));
  assert.equal(result.cells[0].status, 'empty_or_not_loaded');
  assert.equal(result.cells[1].status, 'unsupported_value');
});

test('browser grants are per document, bot and exclusive binding, and rebind drops them', () => {
  const s = emptyState();
  bind(s, 'single:u', { sessionId: 's' });
  grantBrowserDocuments(s, 'single:u', 's', 'bot', 'https://doc.weixin.qq.com/sheet/demo?tab=1');
  assert.equal(requireBrowserGrant(s, 's', 'bot', 'https://doc.weixin.qq.com/sheet/demo').path, '/sheet/demo');
  assert.throws(() => requireBrowserGrant(s, 's', 'other', 'https://doc.weixin.qq.com/sheet/demo'));
  assert.throws(() => requireBrowserGrant(s, 's', 'bot', 'https://doc.weixin.qq.com/sheet/other'));
  bind(s, 'single:v', { sessionId: 's' });
  assert.throws(() => requireBrowserGrant(s, 's', 'bot', 'https://doc.weixin.qq.com/sheet/demo'), /只绑定一个/);
  delete s.bindings['single:v'];
  grantBrowserDocuments(s, 'single:u', 's', 'bot', '');
  assert.throws(() => requireBrowserGrant(s, 's', 'bot', 'https://doc.weixin.qq.com/sheet/demo'));
  grantBrowserDocuments(s, 'single:u', 's', 'bot', 'https://doc.weixin.qq.com/sheet/demo');
  bind(s, 'single:u', { sessionId: 'new' });
  assert.equal(s.bindings['single:u'].browserDocuments, undefined);
  assert.ok(requireBrowserGrant(s, 'new', 'bot', 'https://doc.weixin.qq.com/sheet/demo'));
});
