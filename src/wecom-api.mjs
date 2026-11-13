import { createHash, randomBytes } from 'node:crypto';

export const CLI_AUTH_URL = 'https://qyapi.weixin.qq.com/cgi-bin/aibot/cli/get_cli_config';

export function cliAuthPayload(botId, secret, now = Date.now()) {
  const time = Math.floor(now / 1000);
  const nonce = `cli_${now}_${randomBytes(8).toString('hex')}`;
  const signature = createHash('sha256').update(`${secret}${botId}${time}${nonce}`).digest('hex');
  return { bot_id: botId, time, nonce, signature, bind_source: 1 };
}

async function readBody(response, maxBytes) {
  if (!maxBytes || !response.body?.getReader) return response.json();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('response too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createWeComPoster({
  fetcher = fetch,
  timeoutMs = 15000,
  maxBytes = 0,
  networkError = '企微请求失败',
  abortedError = '',
} = {}) {
  return async function post(url, body, bearer, signal) {
    const timer = AbortSignal.timeout(timeoutMs);
    const signals = [timer, signal].filter(Boolean);
    let response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body),
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await readBody(response, maxBytes);
      if (!data || typeof data !== 'object') throw new Error('invalid json');
      return data;
    } catch (error) {
      if (abortedError && signal?.aborted) throw new Error(abortedError, { cause: error });
      throw new Error(networkError, { cause: error });
    }
  };
}

export function createTokenSource({ botId, secret, post, missingTokenError, missingCredsError, reject, ttlMs = 30 * 60_000 }) {
  let token = null;
  let expiresAt = 0;
  return {
    invalidate() { token = null; expiresAt = 0; },
    async get(signal) {
      if (!botId || !secret) throw new Error(missingCredsError);
      if (token && Date.now() < expiresAt) return token;
      const data = await post(CLI_AUTH_URL, cliAuthPayload(botId, secret), null, signal);
      reject?.(data);
      if (typeof data.token !== 'string' || !data.token) throw new Error(missingTokenError);
      token = data.token;
      expiresAt = Date.now() + ttlMs;
      return token;
    },
  };
}
