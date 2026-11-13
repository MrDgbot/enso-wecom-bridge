import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bindingEntries } from './core.mjs';

const execute = promisify(execFile);

export function documentPath(value) {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('请填写企微文档的 HTTPS 链接');
  let url;
  try { url = new URL(value); } catch { throw new Error('请填写企微文档的 HTTPS 链接'); }
  if (url.origin !== 'https://doc.weixin.qq.com' || url.username || url.password ||
      !/^\/(sheet|doc)\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error('仅允许 doc.weixin.qq.com 的表格或文档链接');
  return url.pathname;
}

export function browserBinding(state, sessionId) {
  const entries = bindingEntries(state).filter(({ binding }) => binding.sessionId === sessionId);
  if (!sessionId || entries.length !== 1) throw new Error('网页读取要求当前 Enso 会话只绑定一个企微聊天，请使用独立会话');
  const { chatKey, binding } = entries[0];
  if (state.tasks.some((t) => t.sessionId === sessionId && ['pending', 'queued'].includes(t.status) && t.chatKey !== chatKey))
    throw new Error('当前会话还有其他企微聊天的待处理任务，暂不允许网页读取');
  return { chatKey, binding };
}

export function grantBrowserDocuments(state, chatKey, sessionId, botId, links, scope = 'listed') {
  const { chatKey: expected, binding } = browserBinding(state, sessionId);
  if (chatKey !== expected) throw new Error('只能授权绑定到当前 Enso 会话的企微聊天');
  if (state.bindings[chatKey] !== binding) throw new Error('群成员单独会话沿用群默认的文档授权，请在群默认会话中设置');
  if (!['listed', 'all'].includes(scope)) throw new Error('未知的文档授权范围');
  if (typeof links !== 'string' || links.length > 10000) throw new Error('文档链接过长');
  const paths = scope === 'all' ? [] : [...new Set(links.split(/\s+/).filter(Boolean).map(documentPath))];
  if (paths.length > 10) throw new Error('每个聊天最多授权 10 份文档');
  if ((paths.length || scope === 'all') && !botId) throw new Error('请先配置机器人');
  binding.browserDocuments = { botId, scope, paths };
}

export function requireBrowserGrant(state, sessionId, botId, url) {
  const path = documentPath(url);
  const { chatKey, binding } = browserBinding(state, sessionId);
  const grant = state.bindings[chatKey]?.browserDocuments;
  if (!botId) throw new Error('请先配置机器人后再读取文档');
  if (grant === undefined) return { path, chatKey, binding, grant };
  if (grant === null || typeof grant !== 'object') throw new Error('文档授权数据损坏，请在侧栏重新保存');
  if (grant.botId && grant.botId !== botId) throw new Error('文档授权属于另一个机器人，请在侧栏重新保存授权');
  const permitted = grant.scope === 'all' ||
    ((grant.scope === undefined || grant.scope === 'listed') && Array.isArray(grant.paths) && grant.paths.includes(path));
  if (!permitted) {
    throw new Error('尚未授权这份文档。新绑定默认不开放任何文档；旧绑定如果从没保存过授权，则仍默认可读全部文档。请在侧栏添加链接，或一键放开全部文档');
  }
  return { path, chatKey, binding, grant };
}

export function parseBrowserRange(value = 'A1:T100') {
  if (typeof value !== 'string' || value.length > 32) throw new Error('请填写 A1 范围，最多 5000 个单元格');
  const match = /^([A-Z]{1,3})([1-9]\d{0,6}):([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value.toUpperCase());
  if (!match) throw new Error('请填写 A1 范围，例如 A1:L50');
  const col = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const startRow = Number(match[2]) - 1, endRow = Number(match[4]) - 1;
  const startCol = col(match[1]), endCol = col(match[3]);
  if (endRow < startRow || endCol < startCol || endRow >= 1048576 || endCol >= 16384 ||
      (endRow - startRow + 1) * (endCol - startCol + 1) > 5000) throw new Error('范围无效或超过 5000 个单元格，请分段读取');
  return { startRow, endRow, startCol, endCol, range: value.toUpperCase() };
}

export function readSheetModel(app, request) {
  const workbook = app?.workbook;
  if (typeof workbook?.worksheetManager?.getSheetList !== 'function') throw new Error('表格读取模型不可用，请确认已加载表格；网站升级后需要更新适配器');
  const sheets = workbook.worksheetManager.getSheetList();
  const sheet = request.sheet
    ? sheets.find(s => s.getSheetId() === request.sheet) ?? sheets.find(s => s.getSheetName() === request.sheet)
    : sheets.find(s => s.getSheetId() === workbook.activeSheetId);
  if (!sheet) throw new Error('没有找到指定子表');
  if (!sheet.getIsInitialized()) throw new Error('子表尚未加载，请先在 Chrome 打开该子表');
  const column = (index) => {
    let out = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out;
    return out;
  };
  const cells = [];
  for (let row = request.startRow; row <= request.endRow; row++) {
    for (let col = request.startCol; col <= request.endCol; col++) {
      const address = column(col) + (row + 1);
      const cell = sheet.getCellDataAtPosition(row, col, { isIgnoreCustomSheetView: true });
      if (!cell) { cells.push({ address, status: 'empty_or_not_loaded', value: null }); continue; }
      const raw = cell.value;
      const supported = raw === null || ['string', 'number', 'boolean'].includes(typeof raw);
      const text = cell.formattedValue?.value;
      cells.push({ address, status: supported ? 'value' : 'unsupported_value', value: supported ? raw : null,
        ...(typeof text === 'string' ? { text } : {}),
      });
    }
  }
  return {
    source: 'browser_sheet_model', coverage: 'loaded_range', range: request.range,
    sheet: { id: sheet.getSheetId(), name: sheet.getSheetName() },
    sheets: sheets.map(s => ({ id: s.getSheetId(), name: s.getSheetName(), rowCount: s.getRowCount(), columnCount: s.getColCount() })),
    cells,
  };
}

export function captureScript(path, request) {
  const extract = `(() => {
    try {
      if (location.origin !== 'https://doc.weixin.qq.com' || location.pathname !== ${JSON.stringify(path)}) throw Error('页面已切换');
      const data = (${readSheetModel.toString()})(window.SpreadsheetApp, ${JSON.stringify(request)});
      const output = JSON.stringify({path:location.pathname,title:document.title.slice(0,256),...data});
      if (new TextEncoder().encode(output).length > 600000) throw Error('读取结果过大，请缩小范围');
      document.currentScript.textContent = output;
    } catch (e) { document.currentScript.textContent = JSON.stringify({error:String(e.message).slice(0,300)}); }
  })()`;
  const pageScript = `(() => {
    if (location.origin !== 'https://doc.weixin.qq.com' || location.pathname !== ${JSON.stringify(path)}) return JSON.stringify({error:'页面已切换'});
    const script = document.createElement('script');
    script.nonce = document.querySelector('script[nonce]')?.nonce || '';
    const source = ${JSON.stringify(extract)};
    script.textContent = source;
    try {
      document.documentElement.append(script);
      return script.textContent === source ? JSON.stringify({error:'页面拒绝读取脚本'}) : script.textContent;
    } finally { script.remove(); }
  })()`;
  return `function run() {
  const chrome = Application('Google Chrome');
  if (!chrome.running()) throw Error('请先打开 Chrome 并登录企微文档');
  const hits = [];
  for (const w of chrome.windows()) for (const t of w.tabs()) {
    const u = t.url();
    if (u.split(/[?#]/)[0] === ${JSON.stringify('https://doc.weixin.qq.com' + path)}) hits.push(t);
  }
  if (hits.length !== 1) throw Error(hits.length ? '同一文档打开了多个标签，请只保留一个' : '请先在 Chrome 打开已授权的文档，再重试');
  return hits[0].execute({javascript:${JSON.stringify(pageScript)}});
}`;
}

export async function readBrowserDocument(url, options = {}, signal, runner = execute) {
  const path = documentPath(url);
  if (!path.startsWith('/sheet/')) throw new Error('网页直接读取目前只支持表格，普通文档请使用 doc_content');
  if (options.sheet !== undefined && (typeof options.sheet !== 'string' || options.sheet.length > 256)) throw new Error('子表 ID 或名称无效');
  const request = { ...parseBrowserRange(options.range), sheet: options.sheet };
  if (process.platform !== 'darwin') throw new Error('网页只读目前仅支持 macOS 上的 Google Chrome');
  let stdout;
  try {
    ({ stdout } = await runner('/usr/bin/osascript', ['-l', 'JavaScript', '-e', captureScript(path, request)], {
      encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024, signal,
    }));
  } catch (error) {
    if (signal?.aborted) throw new Error('网页读取已取消');
    const message = String(error.stderr ?? '');
    for (const safe of ['请先打开 Chrome 并登录企微文档', '同一文档打开了多个标签，请只保留一个', '请先在 Chrome 打开已授权的文档，再重试']) {
      if (message.includes(safe)) throw new Error(safe);
    }
    throw new Error('Chrome 只读采集失败或超时。请检查 macOS 自动化权限，以及 Chrome「通过 Apple 事件执行 JavaScript」设置');
  }
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error('Chrome 返回的数据格式异常'); }
  if (result.error) {
    const allowed = ['页面已切换', '页面拒绝读取脚本', '读取结果过大，请缩小范围', '没有找到指定子表', '子表尚未加载，请先在 Chrome 打开该子表', '表格读取模型不可用，请确认已加载表格；网站升级后需要更新适配器'];
    throw new Error(allowed.includes(result.error) ? result.error : '表格读取模型不兼容，请更新适配器');
  }
  if (result.path !== path || result.source !== 'browser_sheet_model' || result.coverage !== 'loaded_range' || result.range !== request.range || !Array.isArray(result.cells) || Buffer.byteLength(stdout) > 650000) throw new Error('Chrome 返回的数据格式异常');
  return result;
}
