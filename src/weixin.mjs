import { randomBytes } from 'node:crypto';

export class ProviderError extends Error {
  constructor(code) { super('wechat_provider_error'); this.code = String(code); }
}

export function safeBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' ||
      !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))) throw new ProviderError('invalid_provider_host');
  return url.origin;
}

export class Weixin {
  async request(base, endpoint, body, token, signal, timeout = 45000) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10) };
    if (body !== undefined) {
      Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const signals = [AbortSignal.timeout(timeout), ...(signal ? [signal] : [])];
    let response;
    try {
      response = await fetch(`${safeBase(base)}/${endpoint}`, { method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any(signals), redirect: 'error' });
      if (!response.ok) throw new ProviderError(`http_${response.status}`);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new ProviderError('response_too_large');
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ProviderError('invalid_response');
      if (payload.ret !== undefined && payload.ret !== 0) throw new ProviderError(payload.ret);
      if (payload.errcode !== undefined && payload.errcode !== 0) throw new ProviderError(payload.errcode);
      return payload;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal?.aborted) throw new ProviderError('cancelled');
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new ProviderError('timeout');
      throw new ProviderError('network');
    }
  }
  info() { return { channel_version: '2.4.10', bot_agent: 'WeChatBridge/0.1.0' }; }
  qr(token, signal) { return this.request('https://ilinkai.weixin.qq.com', 'ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: token ? [token] : [] }, undefined, signal, 20000); }
  qrStatus(base, qr, code, signal) {
    return this.request(base, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}${code ? '&verify_code=' + encodeURIComponent(code) : ''}`, undefined, undefined, signal);
  }
  updates(credentials, signal) {
    return this.request(credentials.baseUrl, 'ilink/bot/getupdates', { get_updates_buf: credentials.cursor || '', base_info: this.info() }, credentials.token, signal);
  }
  async send(credentials, text, context, clientId, signal) {
    if (!context) throw new ProviderError('interaction_required');
    return this.request(credentials.baseUrl, 'ilink/bot/sendmessage', { base_info: this.info(), msg: {
      from_user_id: '', to_user_id: credentials.userId, client_id: clientId, message_type: 2,
      message_state: 2, context_token: context, item_list: [{ type: 1, text_item: { text } }]
    } }, credentials.token, signal, 15000);
  }
}
