import { createTokenSource, createWeComPoster } from './wecom-api.mjs';

const SESSIONS_URL = 'https://qyapi.weixin.qq.com/cli/message/aibot/sessions/list';

function apiError(value) {
  const code = Number(value);
  return Object.assign(new Error(`名称查询失败（错误码 ${Number.isFinite(code) ? code : '未知'}）`), { code });
}

export function createSessionLookup({ botId, secret }, fetcher = fetch) {
  const post = createWeComPoster({
    fetcher,
    timeoutMs: 8000,
    networkError: '名称同步网络请求失败，请稍后重试',
  });
  const tokens = createTokenSource({
    botId,
    secret,
    post,
    missingCredsError: '请先在插件设置填写 Bot ID 和 Secret',
    missingTokenError: '名称查询认证未返回 token',
    reject: (data) => { if (data.errcode) throw apiError(data.errcode); },
  });
  const load = async (bearer) => {
    const data = await post(SESSIONS_URL, { payload: '{}' }, bearer);
    if (data.errcode) throw apiError(data.errcode);
    let result;
    try {
      const inner = JSON.parse(data.results_json);
      if (inner.error?.code) throw apiError(inner.error.code);
      result = typeof inner.result === 'string' ? JSON.parse(inner.result) : inner.result;
    } catch (error) {
      if (String(error?.message ?? '').startsWith('名称查询失败')) throw error;
      throw new Error('名称接口返回格式异常', { cause: error });
    }
    if (!Array.isArray(result?.sessions)) throw new Error('名称接口未返回会话列表');
    return result.sessions;
  };
  return async () => {
    try {
      return await load(await tokens.get());
    } catch (error) {
      if (error.code !== 853004) throw error;
      tokens.invalidate();
      return load(await tokens.get());
    }
  };
}
