import { createTokenSource, createWeComPoster } from './wecom-api.mjs';

const OPERATIONS = new Map([
  ['sheet_info', '/sheet/get'],
  ['sheet_cells', '/office_tool/execute?id=sheet_cells_get'],
  ['doc_content', '/doc/contents/get'],
]);

function requestOf(args) {
  const path = OPERATIONS.get(args?.action);
  if (!path) throw new Error('不支持的操作，仅允许读取表格目录、单元格和文档正文');
  const docid = typeof args.docid === 'string' ? args.docid.trim() : '';
  if (docid.length < 5 || docid.length > 500) throw new Error('请提供有效的企微文档链接或 docid');
  if (/^https?:/i.test(docid)) {
    let url;
    try { url = new URL(docid); } catch { throw new Error('文档链接格式无效'); }
    if (url.protocol !== 'https:' || url.hostname !== 'doc.weixin.qq.com' || url.port || url.username || url.password)
      throw new Error('仅支持 https://doc.weixin.qq.com 文档链接');
  } else if (!/^[A-Za-z0-9_-]+$/.test(docid)) {
    throw new Error('文档 ID 格式无效');
  }
  const body = { docid };
  if (args.action === 'sheet_cells') {
    if (typeof args.range !== 'string' || !/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/i.test(args.range) || args.range.length > 64)
      throw new Error('读取单元格必须指定 A1 区域，例如 A1:T100；大表请分段读取');
    body.range = args.range;
    if (args.sheet !== undefined) {
      if (typeof args.sheet !== 'string' || !args.sheet.trim() || args.sheet.length > 256) throw new Error('子表名称或 ID 无效');
      body.sheet = args.sheet;
    }
  }
  if (args.action === 'doc_content') body.content_type = 'text';
  return { path, body };
}

function apiError(value) {
  const code = Number(value);
  const hint = [850002, 850003, 851008].includes(code)
    ? '，请检查当前插件机器人对该文档的授权'
    : '';
  return Object.assign(new Error(`企微文档接口失败（错误码 ${Number.isFinite(code) ? code : '未知'}）${hint}`), { code });
}

export function createDocumentReader({ botId, secret }, fetcher = fetch) {
  const post = createWeComPoster({
    fetcher,
    timeoutMs: 15000,
    maxBytes: 5 * 1024 * 1024,
    networkError: '企微文档请求失败或响应过大，请缩小读取范围后重试',
    abortedError: '文档读取已取消',
  });
  const tokens = createTokenSource({
    botId,
    secret,
    post,
    missingCredsError: '请先在插件设置填写 Bot ID 和 Secret',
    missingTokenError: '文档接口认证未返回 token',
    reject: (data) => { if (data.errcode) throw apiError(data.errcode); },
  });
  return async (args, signal) => {
    const { path, body } = requestOf(args);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const bearer = await tokens.get(signal);
        const data = await post(`https://qyapi.weixin.qq.com/cli${path}`, { payload: JSON.stringify(body) }, bearer, signal);
        if (data.errcode) throw apiError(data.errcode);
        let inner;
        let result;
        try {
          inner = JSON.parse(data.results_json);
          result = typeof inner?.result === 'string' ? JSON.parse(inner.result) : inner?.result;
        } catch { throw new Error('企微文档接口返回格式异常'); }
        if (inner?.error?.code) throw apiError(inner.error.code);
        if (result?.errcode) throw apiError(result.errcode);
        if (!result || typeof result !== 'object') throw new Error('企微文档接口未返回内容');
        if (Buffer.byteLength(JSON.stringify(result)) > 600000) throw new Error('读取结果过大，请缩小单元格范围；本次未返回正文');
        return result;
      } catch (error) {
        if (error.code !== 853004 || attempt === 1) throw error;
        tokens.invalidate();
      }
    }
  };
}
