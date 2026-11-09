import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { Store, hash, now } from './store.mjs';
import { Weixin, safeBase } from './weixin.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = '__Secure-wechat_bridge';
const sleep = (ms, signal) => new Promise(done => {
  if (signal?.aborted) return done();
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); done(); };
  const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true });
});
class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function check(condition, code = 'invalid_request', status = 400) { if (!condition) throw new HttpError(status, code); }
async function body(req) {
  check((req.headers['content-type'] || '').startsWith('application/json'), 'json_required', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; check(size <= 20000, 'body_too_large', 413); chunks.push(chunk); }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'invalid_json'); }
  check(input && typeof input === 'object' && !Array.isArray(input));
  return input;
}
const userId = value => typeof value === 'string' && /^[\w.@+-]{1,128}$/.test(value);
const setupId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const requestId = value => typeof value === 'string' && /^[\w:.-]{1,160}$/.test(value);
const validText = text => typeof text === 'string' && text.trim().length > 0 && Buffer.byteLength(text) <= 3500;

export class Bridge {
  constructor(config, provider = new Weixin()) {
    this.config = config;
    this.origin = new URL(config.publicUrl).origin;
    this.prefix = new URL(config.publicUrl).pathname.replace(/\/?$/, '/');
    this.store = new Store(config.database, config.encryptionKey);
    this.provider = provider;
    this.logins = new Map(); this.workers = new Map(); this.queues = new Map(); this.sendControllers = new Map(); this.rates = new Map(); this.closing = false;
    this.server = http.createServer((req, res) => this.handle(req, res).catch(error => {
      if (res.headersSent) return res.destroy();
      const status = error instanceof HttpError ? error.status : 502;
      // Never include provider payloads, QR links, bearer credentials or user text in errors.
      this.json(res, status, { error: error instanceof HttpError ? error.code : 'service_unavailable' });
    }));
    this.server.requestTimeout = 30000;
    this.server.headersTimeout = 15000;
    this.server.maxHeadersCount = 40;
  }
  json(res, status, payload, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
    res.end(JSON.stringify(payload));
  }
  publicStatus(owner) {
    const login = this.logins.get(owner);
    const binding = owner ? this.store.connection(owner) : null;
    return { mode: this.config.mode, login: login ? { state: login.state, expires_at: login.expires } : null,
      binding: binding ? { state: 'connected', connection_id: binding.generation, shared: !!binding.shared,
        connected_at: binding.connected, last_inbound: binding.last_inbound, last_outbound: binding.last_outbound,
        error: binding.transport_error === 'rebind_required' ? 'rebind_required' : binding.error } : null };
  }
  browserSession(req) {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')));
    return cookies[COOKIE] || '';
  }
  browserOwner(req) {
    const owner = this.store.session(this.browserSession(req));
    check(owner, 'session_required', 401); return owner;
  }
  application(req) {
    const token = /^Bearer ([a-zA-Z0-9_-]+)$/i.exec(req.headers.authorization || '')?.[1];
    const application = token && this.store.application(token);
    check(application, 'application_auth_required', 401); return application;
  }
  ownerFor(application, id) { check(userId(id)); return this.store.owner(application.id, id).id; }
  limit(key, count, window = 60000) {
    const entry = this.rates.get(key);
    if (!entry || entry.expires <= now()) { this.rates.set(key, { count: 1, expires: now() + window }); return; }
    check(++entry.count <= count, 'rate_limited', 429);
  }
  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method;
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    // Proxy supplies X-Real-IP; the service listens on loopback only.
    this.limit(`http:${req.headers['x-real-ip'] || req.socket.remoteAddress}`, 400);
    if (url.pathname === '/healthz' && local) return this.json(res, 200, { status: 'ok', mode: this.config.mode });
    if (url.pathname === '/admin/v1/applications') {
      check(local && this.config.adminToken && req.headers.authorization === `Bearer ${this.config.adminToken}`, 'admin_auth_required', 401);
      check(method === 'POST', 'method_not_allowed', 405);
      const input = await body(req);
      check(typeof input.id === 'string' && /^[a-z][a-z0-9-]{0,48}$/.test(input.id));
      check(typeof input.name === 'string' && input.name.length <= 80);
      check(!this.store.db.prepare('SELECT id FROM applications WHERE id=?').get(input.id), 'application_exists', 409);
      return this.json(res, 201, { id: input.id, token: this.store.createApplication(input.id, input.name) });
    }
    check(url.pathname.startsWith(this.prefix), 'not_found', 404);
    const route = url.pathname.slice(this.prefix.length);
    if (method === 'GET' && ['', 'app.js', 'style.css'].includes(route)) {
      const file = route || 'index.html';
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8',
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      return res.end(readFileSync(join(ROOT, 'web', file)));
    }
    if (route.startsWith('v1/')) return this.integration(req, res, url, route.slice(3));
    if (method === 'POST') check(req.headers.origin === this.origin, 'origin_rejected', 403);
    if (route === 'api/session' && method === 'POST') {
      this.limit(`redeem:${req.headers['x-real-ip'] || req.socket.remoteAddress}`, 10);
      const input = await body(req);
      check(typeof input.invite === 'string' && input.invite.length <= 100);
      const session = this.store.redeem(input.invite, this.browserSession(req));
      check(session, 'invitation_expired_or_used', 401);
      return this.json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${session}; Path=${this.prefix}; Secure; HttpOnly; SameSite=Strict; Max-Age=86400` });
    }
    if (route === 'api/inline-claim' && method === 'POST') {
      this.limit(`inline-claim:${req.headers['x-real-ip'] || req.socket.remoteAddress}`, 20);
      const input = await body(req);
      check(setupId(input.setup_id));
      check(this.store.claimSetup(input.setup_id, this.browserSession(req)), 'setup_expired', 409);
      return this.json(res, 200, { ok: true });
    }
    const owner = this.browserOwner(req);
    if (route === 'api/status' && method === 'GET') {
      const candidate = this.config.mode === 'relay' && this.store.shareCandidate(this.browserSession(req), owner);
      return this.json(res, 200, { ...this.publicStatus(owner), share_application: candidate?.application_name || null,
        has_share: !!this.store.shareBySource(owner) });
    }
    if (route === 'api/share' && method === 'POST') {
      await body(req);
      check(this.config.mode === 'relay' && this.store.grant(this.browserSession(req), owner), 'share_unavailable', 409);
      this.stopOwner(owner);
      return this.json(res, 200, this.publicStatus(owner));
    }
    if (route === 'api/revoke-share' && method === 'POST') {
      await body(req); this.browserOwner(req);
      const share = this.store.shareBySource(owner);
      if (share) this.unlink(share.owner);
      return this.json(res, 200, { ok: true });
    }
    if (route === 'api/bind' && method === 'POST') {
      await body(req); this.browserOwner(req);
      check(!this.store.connection(owner)?.shared, 'unbind_shared_first', 409);
      this.limit(`bind:${owner}`, 5, 300000);
      await this.startLogin(owner);
      return this.json(res, 200, this.publicStatus(owner));
    }
    if (route === 'api/qr.png' && method === 'GET') {
      const login = this.logins.get(owner);
      check(login?.image && !login.setupId && login.expires > now() && ['wait', 'scaned', 'need_verifycode'].includes(login.state), 'qr_expired', 410);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); return res.end(login.image);
    }
    if (route === 'api/verify-code' && method === 'POST') {
      const input = await body(req); this.browserOwner(req); const login = this.logins.get(owner);
      check(!login?.setupId, 'no_verification_pending', 409);
      this.submitProviderCode(owner, login, input.code);
      return this.json(res, 200, { ok: true });
    }
    if (route === 'api/unbind' && method === 'POST') {
      await body(req); this.browserOwner(req); this.unlink(owner, this.browserSession(req)); return this.json(res, 200, { ok: true });
    }
    throw new HttpError(404, 'not_found');
  }
  async integration(req, res, url, route) {
    const application = this.application(req);
    this.limit(`application:${application.id}`, 180);
    const parts = route.split('/');
    if (route === 'invitations' && req.method === 'POST') {
      const input = await body(req); const owner = this.ownerFor(application, input.user_id);
      this.limit(`invites:${owner}`, 10, 3600000);
      check(input.reuse_existing === undefined || typeof input.reuse_existing === 'boolean');
      const invite = this.store.invitation(owner, this.config.mode === 'relay' && input.reuse_existing === true);
      return this.json(res, 201, { url: `${this.config.publicUrl}#invite=${invite}`, expires_in: 1800 });
    }
    if (parts[0] === 'users' && parts[2] === 'binding-setup') {
      const id = decodeURIComponent(parts[1]); check(userId(id));
      return this.inlineSetup(req, res, application, id, parts.slice(3));
    }
    if (parts.length === 3 && parts[0] === 'users' && parts[2] === 'status' && req.method === 'GET') {
      const id = decodeURIComponent(parts[1]); check(userId(id));
      const owner = this.store.findOwner(application.id, id)?.id;
      return this.json(res, 200, this.publicStatus(owner));
    }
    if (parts.length === 3 && parts[0] === 'users' && parts[2] === 'unbind' && req.method === 'POST') {
      await body(req);
      const id = decodeURIComponent(parts[1]); check(userId(id));
      const owner = this.store.findOwner(application.id, id)?.id;
      if (owner) this.unlink(owner);
      return this.json(res, 200, { ok: true });
    }
    if (parts.length === 3 && parts[0] === 'users' && parts[2] === 'send' && req.method === 'POST') {
      const input = await body(req); const id = decodeURIComponent(parts[1]); check(userId(id));
      const owner = this.store.findOwner(application.id, id)?.id;
      check(owner, 'binding_not_connected', 409);
      this.limit(`send:${owner}`, 8);
      check(input.connection_id === undefined || requestId(input.connection_id));
      const result = await this.send(owner, input.text, input.request_id, undefined, false, input.connection_id);
      return this.json(res, 200, result);
    }
    if (route === 'events' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') || 0); check(Number.isSafeInteger(after) && after >= 0);
      return this.json(res, 200, { events: this.store.events(application.id, after) });
    }
    if (parts.length === 3 && parts[0] === 'events' && parts[2] === 'reply' && req.method === 'POST') {
      check(/^\d+$/.test(parts[1])); const input = await body(req);
      const event = this.store.db.prepare('SELECT e.* FROM events e JOIN owners o ON o.id=e.owner WHERE e.id=? AND o.application=?').get(Number(parts[1]), application.id);
      check(event, 'event_not_found', 404);
      const binding = this.store.connection(event.owner);
      check(binding?.generation === event.generation, 'binding_changed', 409);
      check(binding.shared || event.id > binding.relay_after, 'event_not_found', 404);
      this.limit(`send:${event.owner}`, 8);
      return this.json(res, 200, await this.send(event.owner, input.text, input.request_id, this.store.decrypt(event.payload).context, false, event.generation));
    }
    throw new HttpError(404, 'not_found');
  }
  submitProviderCode(owner, login, code) {
    check(login?.state === 'need_verifycode' && login.expires > now(), 'no_verification_pending', 409);
    check(typeof code === 'string' && /^[a-zA-Z0-9]{4,16}$/.test(code));
    this.limit(`provider-code:${owner}`, 5, 300000);
    login.code = code;
    login.state = 'scaned';
  }
  stopLogin(owner) {
    this.logins.get(owner)?.controller.abort();
    this.logins.delete(owner);
  }
  inlineStatus(owner, setup) {
    const status = this.publicStatus(owner);
    const login = this.logins.get(owner);
    const active = login?.setupId === setup.id ? login : null;
    const share = this.store.shareSource(setup.source_session, owner, setup.source_generation);
    return { ...status, login: active ? status.login : null, share_application: share?.application_name || null,
      qr_png: active?.image && active.expires > now() ? active.image.toString('base64') : null };
  }
  async inlineSetup(req, res, application, id, parts) {
    check(this.config.mode === 'relay', 'setup_unavailable', 409);
    if (req.method === 'POST' && parts.length === 0) {
      await body(req);
      const owner = this.ownerFor(application, id);
      const connection = this.store.connection(owner);
      if (connection && (connection.shared || connection.transport_error !== 'rebind_required')) {
        return this.json(res, 200, { setup_id: null, ...this.publicStatus(owner) });
      }
      this.limit(`inline:${owner}`, 10, 300000);
      if (this.logins.get(owner)?.setupId) this.stopLogin(owner);
      const setup = this.store.createSetup(owner);
      return this.json(res, 201, { setup_id: setup });
    }
    check((parts.length === 1 && req.method === 'GET') || (parts.length === 2 && req.method === 'POST'), 'not_found', 404);
    const [setup, action] = parts;
    check(setupId(setup));
    const input = req.method === 'POST' ? await body(req) : null;
    const owner = this.store.findOwner(application.id, id)?.id;
    const current = owner && this.store.setup(setup, owner);
    check(current?.claimed, 'setup_expired', 409);
    if (req.method === 'GET') return this.json(res, 200, this.inlineStatus(owner, current));
    const login = this.logins.get(owner);
    if (action === 'cancel') {
      if (login?.setupId === setup) this.stopLogin(owner);
      this.store.clearSetup(setup, owner);
      return this.json(res, 200, { ok: true });
    }
    if (action === 'share') {
      const candidate = this.store.shareSource(current.source_session, owner, current.source_generation);
      check(this.store.addShare(owner, candidate), 'share_unavailable', 409);
      this.stopLogin(owner);
    } else if (action === 'start') {
      const connection = this.store.connection(owner);
      check(!connection || (!connection.shared && connection.transport_error === 'rebind_required'), 'binding_changed', 409);
      if (this.store.shareSource(current.source_session, owner, current.source_generation)) {
        return this.json(res, 200, this.inlineStatus(owner, current));
      }
      if (login?.setupId !== setup || login.finished || login.expires <= now()) {
        this.limit(`bind:${owner}`, 5, 300000);
        await this.startLogin(owner, setup);
      }
    } else if (action === 'verify-code') {
      check(login?.setupId === setup, 'no_verification_pending', 409);
      this.submitProviderCode(owner, login, input.code);
    } else throw new HttpError(404, 'not_found');
    return this.json(res, 200, this.inlineStatus(owner, current));
  }
  unlink(owner, session) {
    const share = this.store.shareBySource(owner);
    if (share) this.stopOwner(share.owner);
    this.stopOwner(owner);
    this.store.unbind(owner, session);
  }
  stopOwner(owner) {
    this.sendControllers.get(owner)?.abort();
    this.stopLogin(owner);
    this.workers.get(owner)?.controller.abort(); this.workers.delete(owner);
  }
  async startLogin(owner, setup = null) {
    check(!this.closing, 'service_unavailable', 503);
    const previous = this.logins.get(owner);
    check(previous?.state !== 'starting', 'binding_in_progress', 409);
    const active = [...this.logins.values()].filter(login => !login.finished).length;
    check(active - (previous && !previous.finished ? 1 : 0) < 20, 'too_many_pending_bindings', 429);
    previous?.controller.abort();
    const login = { setupId: setup, state: 'starting', expires: now() + 300000, controller: new AbortController() };
    this.logins.set(owner, login);
    const ready = this.prepareLogin(owner, login);
    login.task = ready.then(() => this.pollLogin(owner, login)).catch(() => {
      if (!login.controller.signal.aborted) login.state = 'provider_error';
    }).finally(() => {
      login.finished = true;
      login.image = null;
    });
    try { await ready; } catch (error) {
      check(!login.controller.signal.aborted, 'binding_changed', 409);
      throw error;
    }
  }
  async prepareLogin(owner, login) {
    const signal = login.controller.signal;
    const qr = await this.provider.qr(this.store.binding(owner)?.credentials.token, signal);
    check(!signal.aborted, 'binding_changed', 409);
    check(typeof qr.qrcode === 'string' && qr.qrcode.length < 4096 && typeof qr.qrcode_img_content === 'string', 'invalid_qr_response', 502);
    const url = new URL(qr.qrcode_img_content);
    check(url.protocol === 'https:' && url.hostname.endsWith('.weixin.qq.com') && !url.username && !url.password && !url.port, 'invalid_qr_host', 502);
    const image = await QRCode.toBuffer(url.href, { width: 320, margin: 3, errorCorrectionLevel: 'M' });
    check(!signal.aborted, 'binding_changed', 409);
    Object.assign(login, { state: 'wait', expires: now() + 300000, qr: qr.qrcode, base: 'https://ilinkai.weixin.qq.com', image });
  }
  async pollLogin(owner, login) {
    const signal = login.controller.signal;
    while (!signal.aborted && this.logins.get(owner) === login && now() < login.expires) {
      if (login.state === 'need_verifycode' && !login.code) { await sleep(1000, signal); continue; }
      try {
        const result = await this.provider.qrStatus(login.base, login.qr, login.code, signal); login.code = undefined;
        if (signal.aborted || this.logins.get(owner) !== login) return;
        if (now() >= login.expires || (login.setupId && !this.store.setup(login.setupId, owner))) break;
        if (result.status === 'scaned_but_redirect') {
          login.base = safeBase(`https://${result.redirect_host}`); login.state = 'scaned';
        } else if (result.status === 'confirmed') {
          check([result.bot_token, result.ilink_bot_id, result.ilink_user_id].every(value => typeof value === 'string' && value.length > 0), 'incomplete_binding', 502);
          const credentials = { token: result.bot_token, botId: result.ilink_bot_id, userId: result.ilink_user_id,
            baseUrl: safeBase(result.baseurl || login.base), cursor: '', context: '' };
          this.store.bind(owner, credentials);
          this.workers.get(owner)?.controller.abort(); this.workers.delete(owner);
          login.state = 'connected'; login.image = null; this.startWorker(owner); return;
        } else if (result.status === 'binded_redirect') {
          login.state = this.store.binding(owner) ? 'connected' : 'rebind_required'; return;
        } else if (['expired', 'verify_code_blocked'].includes(result.status)) {
          login.state = result.status; login.image = null; return;
        } else if (['wait', 'scaned', 'need_verifycode'].includes(result.status)) login.state = result.status;
        else { login.state = 'provider_error'; return; }
      } catch (error) {
        if (signal.aborted) return;
        if (error.message === 'wechat_already_bound') { login.state = 'already_bound_elsewhere'; return; }
        if (error.code !== 'timeout' && error.code !== 'network') { login.state = 'provider_error'; return; }
      }
      await sleep(1000, signal);
    }
    if (!signal.aborted) { login.state = 'expired'; login.image = null; }
  }
  startWorker(owner) {
    const binding = this.store.binding(owner); if (this.closing || !binding || this.workers.has(owner)) return;
    const worker = { controller: new AbortController(), generation: binding.generation };
    this.workers.set(owner, worker); worker.task = this.pollMessages(owner, worker);
  }
  async pollMessages(owner, worker) {
    const signal = worker.controller.signal; let failures = 0;
    while (!signal.aborted && this.workers.get(owner) === worker) {
      const binding = this.store.binding(owner);
      if (!binding || binding.generation !== worker.generation) return;
      try {
        const result = await this.provider.updates(binding.credentials, signal);
        if (signal.aborted || this.workers.get(owner) !== worker) return;
        check(Array.isArray(result.msgs || []), 'invalid_messages', 502);
        const events = this.store.ingest(owner, worker.generation, result.msgs || [], result.get_updates_buf);
        failures = 0;
        if (binding.error === 'network_retry') this.store.clearNetworkError(owner, worker.generation);
        if (this.config.mode === 'test') {
          for (const event of events) {
            if (!event.context || event.owner !== owner) continue;
            const current = this.store.binding(owner);
            if (current?.generation !== worker.generation) break;
            try { await this.send(owner, '微信通道已收到你的消息。', `test:${worker.generation}:${event.id}`, event.context, true); }
            catch { /* A failed outbound is visible in status. */ }
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error.code === 'timeout') continue;
        const expired = ['-14', '-1001', 'http_401'].includes(error.code);
        this.store.setError(owner, worker.generation, expired ? 'rebind_required' : 'network_retry');
        if (expired) return;
        failures++;
        await sleep(Math.min(60000, 1000 * 2 ** Math.min(failures, 6)), signal);
      }
      await sleep(300, signal);
    }
  }
  async send(owner, text, id, context, internal = false, expectedConnection) {
    check(validText(text)); check(requestId(id), 'request_id_required');
    check(internal || !id.startsWith('test:'), 'request_id_reserved');
    check(!this.closing, 'service_unavailable', 503);
    const initial = this.store.connection(owner);
    check(initial, 'binding_not_connected', 409);
    check(!expectedConnection || initial.generation === expectedConnection, 'binding_changed', 409);
    const { generation, source_owner: source } = initial;
    const previous = this.queues.get(source) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      check(!this.closing, 'service_unavailable', 503);
      const binding = this.store.connection(owner);
      check(binding?.generation === generation, 'binding_changed', 409);
      const payloadHash = hash(JSON.stringify([generation, text, context || null]));
      const old = this.store.db.prepare('SELECT * FROM outbound WHERE owner=? AND request_id=?').get(owner, id);
      if (old) {
        check(old.payload_hash === payloadHash && old.generation === generation, 'request_id_conflict', 409);
        check(old.state === 'accepted', 'previous_send_uncertain_or_failed', 409);
        return { accepted_by_wechat: true, delivery_confirmed: false, duplicate: true };
      }
      check(binding.transport_error !== 'rebind_required', 'rebind_required', 409);
      const outgoingContext = context ?? binding.credentials.context;
      check(outgoingContext, 'interaction_required', 409);
      const clientId = `wechat-bridge-${randomUUID()}`;
      this.store.db.prepare('INSERT INTO outbound VALUES(?,?,?,?,?,?,?)').run(owner, id, generation, payloadHash, clientId, 'pending', now());
      const controller = new AbortController();
      this.sendControllers.set(owner, controller);
      const worker = this.workers.get(source);
      const signal = worker ? AbortSignal.any([controller.signal, worker.controller.signal]) : controller.signal;
      try {
        await this.provider.send(binding.credentials, text, outgoingContext, clientId, signal);
      } catch (error) {
        this.store.db.prepare("UPDATE outbound SET state='uncertain_or_failed' WHERE owner=? AND request_id=? AND generation=? AND state='pending'").run(owner, id, generation);
        check(this.store.connection(owner)?.generation === generation, 'binding_changed', 409);
        const code = ['-2', 'interaction_required'].includes(error.code) ? 'interaction_required' : 'send_failed';
        this.store.setError(owner, generation, code, binding.shared); throw new HttpError(502, code);
      } finally {
        if (this.sendControllers.get(owner) === controller) this.sendControllers.delete(owner);
      }
      check(this.store.connection(owner)?.generation === generation, 'binding_changed', 409);
      this.store.acceptSend(owner, id, generation, binding.shared);
      return { accepted_by_wechat: true, delivery_confirmed: false };
    });
    this.queues.set(source, operation);
    try { return await operation; } finally { if (this.queues.get(source) === operation) this.queues.delete(source); }
  }
  async listen(port = this.config.port ?? 8318) {
    await new Promise((done, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', done); });
    for (const row of this.store.db.prepare('SELECT owner FROM bindings').all()) this.startWorker(row.owner);
    this.cleanupTimer = setInterval(() => {
      this.store.cleanup();
      for (const [key, value] of this.rates) if (value.expires < now()) this.rates.delete(key);
      for (const [owner, login] of this.logins) if (login.expires + 300000 < now()) { login.controller.abort(); this.logins.delete(owner); }
    }, 60000);
    this.cleanupTimer.unref(); return this.server.address().port;
  }
  async close() {
    this.closing = true;
    clearInterval(this.cleanupTimer);
    const closed = new Promise(done => this.server.close(done));
    this.server.closeAllConnections();
    for (const controller of this.sendControllers.values()) controller.abort();
    const tasks = [...this.logins.values(), ...this.workers.values()].map(value => { value.controller.abort(); return value.task; });
    await Promise.allSettled(tasks);
    await Promise.allSettled([...this.queues.values()]);
    await closed;
    this.store.db.close();
  }
}

if (import.meta.main) {
  process.umask(0o077);
  try {
    const config = JSON.parse(readFileSync(process.env.WECHAT_BRIDGE_CONFIG || '/etc/wechat-bridge/config.json', 'utf8'));
    check(['test', 'relay'].includes(config.mode));
    check(new URL(config.publicUrl).protocol === 'https:');
    mkdirSync(dirname(config.database), { recursive: true, mode: 0o700 });
    const bridge = new Bridge(config);
    const port = await bridge.listen();
    console.log(JSON.stringify({ event: 'bridge_started', mode: config.mode, host: '127.0.0.1', port }));
    let closing = false;
    for (const event of ['SIGTERM', 'SIGINT']) process.on(event, () => { if (!closing) { closing = true; bridge.close().then(() => process.exit(0)); } });
  } catch (error) { console.error(JSON.stringify({ event: 'startup_failed', code: error.code || error.name })); process.exit(1); }
}
