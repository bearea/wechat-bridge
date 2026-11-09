import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/server.mjs';
import { hash } from '../src/store.mjs';
import { ProviderError, safeBase, Weixin } from '../src/weixin.mjs';

class FakeProvider {
  constructor() { this.sends = []; this.failure = null; }
  qr() { return Promise.resolve({ qrcode: 'test-ticket', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/test' }); }
  qrStatus(base, qr, code, signal) { return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new ProviderError('cancelled')), { once: true });
  }); }
  updates(credentials, signal) { return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new ProviderError('cancelled')), { once: true });
  }); }
  async send(credentials, text, context, id) {
    if (this.failure) throw new ProviderError(this.failure);
    this.sends.push({ credentials, text, context, id }); return { ret: 0 };
  }
}
async function fixture(t, mode = 'test') {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-bridge-test-'));
  const provider = new FakeProvider();
  const config = { publicUrl: 'https://bridge.example.test/connect/', database: join(directory, 'test.sqlite'),
    encryptionKey: randomBytes(32).toString('base64'), adminToken: 'admin-test-only', mode };
  let bridge = new Bridge(config, provider);
  let port = await bridge.listen(0);
  const restart = async () => {
    await bridge.close();
    bridge = new Bridge(config, provider);
    port = await bridge.listen(0);
  };
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  const tokenA = bridge.store.createApplication('app-a', 'A'); const tokenB = bridge.store.createApplication('app-b', 'B');
  const a = bridge.store.owner('app-a', 'same-user-id').id; const b = bridge.store.owner('app-b', 'same-user-id').id;
  const bind = (owner, suffix) => bridge.store.bind(owner, { token: 'private-' + suffix, botId: 'bot-' + suffix,
    userId: 'wechat-' + suffix, baseUrl: 'https://ilinkai.weixin.qq.com', context: '' });
  const message = (suffix, id = 'm1') => ({ message_type: 1, from_user_id: 'wechat-' + suffix, to_user_id: 'bot-' + suffix,
    message_id: id, context_token: 'context-' + suffix, item_list: [{ type: 1, text_item: { text: 'sensitive question ' + suffix } }] });
  const call = async (path, { token, cookie, data, origin = 'https://bridge.example.test' } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: data === undefined ? 'GET' : 'POST', headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }) }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, headers: response.headers, result: await response.json() };
  };
  const cookieFor = owner => '__Secure-wechat_bridge=' + bridge.store.redeem(bridge.store.invitation(owner));
  const receive = (owner, suffix, generation) => bridge.store.ingest(owner, generation, [message(suffix)], 'cursor');
  const cli = (args, text) => {
    const configPath = join(directory, 'config.json');
    const apps = join(directory, 'applications');
    mkdirSync(apps, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ port, publicUrl: config.publicUrl }));
    writeFileSync(join(apps, 'app-a.json'), JSON.stringify({ token: tokenA }));
    const admin = fileURLToPath(new URL('../src/admin.mjs', import.meta.url));
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [admin, ...args], {
        env: { ...process.env, WECHAT_BRIDGE_CONFIG: configPath }, timeout: 5000,
      }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
      child.stdin.end(text);
    });
  };
  return { get bridge() { return bridge; }, provider, tokenA, tokenB, a, b, bind, message, call, cookieFor, receive, restart, cli };
}

test('application and user scopes remain separate with matching user IDs', async t => {
  const f = await fixture(t); assert.notEqual(f.a, f.b);
  f.bind(f.a, 'a');
  const result = await f.call('/connect/v1/users/same-user-id/status', { token: f.tokenB });
  assert.equal(result.status, 200); assert.equal(result.result.binding, null);
});
test('invitations are one-use and browser sessions are server-associated', async t => {
  const f = await fixture(t); const invite = f.bridge.store.invitation(f.a);
  const first = await f.call('/connect/api/session', { data: { invite } });
  assert.equal(first.status, 200); assert.match(first.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict/);
  assert.equal((await f.call('/connect/api/session', { data: { invite } })).status, 401);
  const cookie = first.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.call('/connect/api/status', { cookie })).status, 200);
});
test('browser mutations reject a different origin and unauthenticated sessions', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/connect/api/bind', { data: {}, origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await f.call('/connect/api/status')).status, 401);
});
test('credentials and inbound message bodies are encrypted at rest', async t => {
  const f = await fixture(t); const generation = f.bind(f.a, 'a');
  f.bridge.store.ingest(f.a, generation, [f.message('a')], 'cursor');
  const encrypted = f.bridge.store.db.prepare('SELECT credentials FROM bindings').get().credentials;
  assert.ok(!encrypted.includes('private-a')); assert.ok(!encrypted.includes('context-a'));
  const event = f.bridge.store.db.prepare('SELECT payload FROM events').get().payload;
  assert.ok(!event.includes('sensitive question')); assert.equal(f.bridge.store.binding(f.a).credentials.token, 'private-a');
});
test('inbound whitelist rejects other senders and other destination bots', async t => {
  const f = await fixture(t); const generation = f.bind(f.a, 'a');
  const bad = f.message('a'); bad.from_user_id = 'someone-else';
  const badBot = f.message('a', 'm2'); badBot.to_user_id = 'bot-b';
  assert.equal(f.bridge.store.ingest(f.a, generation, [bad, badBot], 'cursor').length, 0);
  assert.equal(f.bridge.store.binding(f.a).last_inbound, null);
});
test('messages deduplicate and the durable cursor advances', async t => {
  const f = await fixture(t); const generation = f.bind(f.a, 'a');
  assert.equal(f.bridge.store.ingest(f.a, generation, [f.message('a')], 'cursor-1').length, 1);
  assert.equal(f.bridge.store.ingest(f.a, generation, [f.message('a')], 'cursor-2').length, 0);
  assert.equal(f.bridge.store.binding(f.a).credentials.cursor, 'cursor-2');
});
test('WeChat confirmation connects immediately and the first message gets a test acknowledgment', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const cookie = f.cookieFor(f.a);
  const officialCode = 'AB12';
  f.provider.qrStatus = async (base, qr, code) => {
    if (!code) return { status: 'need_verifycode' };
    assert.equal(code, officialCode);
    return { status: 'confirmed', bot_token: 'fake-token', ilink_bot_id: 'bot-a', ilink_user_id: 'wechat-a' };
  };
  const updates = Promise.withResolvers();
  const update = f.provider.updates.bind(f.provider);
  f.provider.updates = (credentials, signal) => Promise.race([
    updates.promise,
    update(credentials, signal),
  ]);
  const sent = Promise.withResolvers();
  const send = f.provider.send.bind(f.provider);
  f.provider.send = async (...args) => { const result = await send(...args); sent.resolve(); return result; };
  const bind = await f.call('/connect/api/bind', { cookie, data: {} });
  assert.equal(bind.result.login.state, 'need_verifycode');
  assert.equal(bind.result.binding, null);
  assert.equal((await f.call('/connect/api/verify-code', { cookie, data: { code: officialCode } })).status, 200);
  await f.bridge.logins.get(f.a).task;
  const connected = (await f.call('/connect/api/status', { cookie })).result.binding;
  assert.equal(connected.state, 'connected');
  assert.equal(connected.last_inbound, null);
  assert.equal(connected.last_outbound, null);
  assert.equal((await f.call('/connect/api/confirm-receipt', { cookie, data: { code: '123456' } })).status, 404);
  const sendPath = '/connect/v1/users/same-user-id/send';
  const notification = { token: f.tokenA, data: { text: 'notification', request_id: 'before-context' } };
  assert.equal((await f.call(sendPath, notification)).result.error, 'interaction_required');

  f.provider.updates = update;
  updates.resolve({ msgs: [f.message('a')], get_updates_buf: 'cursor' });
  await sent.promise;
  const delivered = (await f.call('/connect/api/status', { cookie })).result.binding;
  assert.equal(delivered.state, 'connected');
  assert.ok(delivered.last_inbound);
  assert.ok(delivered.last_outbound);
  assert.equal(f.provider.sends[0].text, '微信通道已收到你的消息。');
  assert.equal((await f.call(sendPath, notification)).status, 200);
});
test('outbound requests deduplicate and do not claim actual delivery', async t => {
  const f = await fixture(t); const generation = f.bind(f.a, 'a');
  f.bridge.store.ingest(f.a, generation, [f.message('a')], 'cursor');
  const first = await f.bridge.send(f.a, 'notification', 'request-1', 'context-a');
  const second = await f.bridge.send(f.a, 'notification', 'request-1', 'context-a');
  assert.equal(first.accepted_by_wechat, true); assert.equal(first.delivery_confirmed, false);
  assert.equal(second.duplicate, true); assert.equal(f.provider.sends.length, 1);
  await assert.rejects(f.bridge.send(f.a, 'different message', 'request-1', 'context-a'), /request_id_conflict/);
});
test('uncertain sends cannot be blindly replayed', async t => {
  const f = await fixture(t); const generation = f.bind(f.a, 'a');
  f.bridge.store.ingest(f.a, generation, [f.message('a')], 'cursor'); f.provider.failure = 'timeout';
  await assert.rejects(f.bridge.send(f.a, 'notification', 'request-1', 'context-a'), /send_failed/);
  f.provider.failure = null;
  await assert.rejects(f.bridge.send(f.a, 'notification', 'request-1', 'context-a'), /previous_send_uncertain_or_failed/);
  assert.equal(f.provider.sends.length, 0);
});
test('cross-application event access and replies are rejected', async t => {
  const f = await fixture(t); const generation = f.bind(f.a, 'a');
  const [event] = f.receive(f.a, 'a', generation);
  assert.equal((await f.call('/connect/v1/events', { token: f.tokenA })).result.events.length, 1);
  assert.equal((await f.call('/connect/v1/events', { token: f.tokenB })).result.events.length, 0);
  assert.equal((await f.call(`/connect/v1/events/${event.id}/reply`, { token: f.tokenB, data: { text: 'wrong', request_id: 'reply-1' } })).status, 404);
});
test('rebind invalidates old contexts and unbind removes account data', async t => {
  const f = await fixture(t); const old = f.bind(f.a, 'a');
  f.bridge.store.ingest(f.a, old, [f.message('a')], 'cursor');
  const next = f.bind(f.a, 'a'); assert.notEqual(next, old);
  assert.equal(f.bridge.store.ingest(f.a, old, [f.message('a', 'stale')], 'stale-cursor').length, 0);
  assert.equal(f.bridge.store.binding(f.a).credentials.context, '');
  assert.equal(f.bridge.store.ingest(f.a, next, [f.message('a')], 'new-cursor').length, 1);
  f.bridge.store.unbind(f.a); assert.equal(f.bridge.store.binding(f.a), null);
  assert.equal(f.bridge.store.db.prepare('SELECT COUNT(*) n FROM events WHERE owner=?').get(f.a).n, 0);
});
test('an already-linked WeChat account cannot be taken by another application', async t => {
  const f = await fixture(t); f.bind(f.a, 'a'); assert.throws(() => f.bind(f.b, 'a'), /wechat_already_bound/);
  assert.equal(f.bridge.store.binding(f.b), null);
});
test('official host validation rejects credential redirects to other hosts', () => {
  for (const url of ['http://ilinkai.weixin.qq.com', 'https://evil.invalid', 'https://weixin.qq.com.evil.invalid',
    'https://user:password@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:444', 'https://ilinkai.weixin.qq.com/private']) assert.throws(() => safeBase(url));
  assert.equal(safeBase('https://ilinkai.weixin.qq.com'), 'https://ilinkai.weixin.qq.com');
});
test('provider application-level errors and absent conversation tokens fail closed', async () => {
  const provider = new Weixin(); await assert.rejects(provider.send({}, 'test', '', 'id'), /wechat_provider_error/);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ret: -2, errmsg: 'private provider payload' }));
    await assert.rejects(provider.request('https://ilinkai.weixin.qq.com', 'test', {}, 'test-secret'), error => error.code === '-2' && !error.message.includes('private'));
  } finally { globalThis.fetch = original; }
});
test('QR browser endpoint never exposes the authorization token', async t => {
  const f = await fixture(t); const invite = f.bridge.store.invitation(f.a);
  const session = f.bridge.store.redeem(invite); const cookie = '__Secure-wechat_bridge=' + session;
  const response = await f.call('/connect/api/bind', { cookie, data: {} });
  assert.equal(response.status, 200); assert.equal(response.result.login.state, 'wait');
  assert.ok(!JSON.stringify(response.result).includes('test-ticket'));
  assert.ok(!JSON.stringify(response.result).includes('token'));
});

test('unbind cancels pending QR creation without disturbing a new attempt', async t => {
  const f = await fixture(t);
  const cookie = f.cookieFor(f.a);
  const qr = f.provider.qr.bind(f.provider);
  const started = Promise.withResolvers();
  const deferred = Promise.withResolvers();
  f.provider.qr = (token, signal) => { started.resolve(signal); return deferred.promise; };
  const pending = f.call('/connect/api/bind', { cookie, data: {} });
  const signal = await started.promise;
  assert.equal((await f.call('/connect/api/bind', { cookie, data: {} })).status, 409);
  assert.equal((await f.call('/connect/api/unbind', { cookie, data: {} })).status, 200);
  assert.equal(signal.aborted, true);
  f.provider.qr = qr;
  assert.equal((await f.call('/connect/api/bind', { cookie, data: {} })).result.login.state, 'wait');
  const current = f.bridge.logins.get(f.a);
  deferred.resolve(await qr());
  assert.equal((await pending).result.error, 'binding_changed');
  assert.equal(f.bridge.logins.get(f.a), current);
  assert.equal(f.bridge.store.binding(f.a), null);
});

test('a confirmation returned after QR expiry cannot bind an account', async t => {
  const f = await fixture(t);
  const response = Promise.withResolvers();
  f.provider.qrStatus = () => response.promise;
  await f.bridge.startLogin(f.a);
  const login = f.bridge.logins.get(f.a);
  login.expires = 0;
  response.resolve({ status: 'confirmed', bot_token: 'fake-token', ilink_bot_id: 'bot-a', ilink_user_id: 'wechat-a' });
  await login.task;
  assert.equal(login.state, 'expired');
  assert.equal(f.bridge.store.binding(f.a), null);
});

test('an in-flight send and queued sends cannot complete on a replacement binding', async t => {
  const f = await fixture(t);
  f.receive(f.a, 'a', f.bind(f.a, 'a'));
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const send = f.provider.send.bind(f.provider);
  f.provider.send = (...args) => { started.resolve(args[0].userId); return response.promise; };
  const first = assert.rejects(f.bridge.send(f.a, 'old message', 'old-1'), /binding_changed/);
  assert.equal(await started.promise, 'wechat-a');
  const queued = assert.rejects(f.bridge.send(f.a, 'old queued message', 'old-2'), /binding_changed/);
  const generation = f.bind(f.a, 'replacement');
  f.provider.send = send;
  response.resolve({ ret: 0 });
  await Promise.all([first, queued]);
  assert.equal(f.bridge.store.binding(f.a).last_outbound, null);
  assert.equal(f.provider.sends.length, 0);
  f.receive(f.a, 'replacement', generation);
  await f.bridge.send(f.a, 'new message', 'new-1');
  assert.equal(f.provider.sends.at(-1).credentials.userId, 'wechat-replacement');
});

test('accepted and crash-pending request IDs survive restart without sending again', async t => {
  const f = await fixture(t);
  const generation = f.bind(f.a, 'a');
  f.receive(f.a, 'a', generation);
  await f.bridge.send(f.a, 'accepted', 'accepted-1');
  // Simulate a process interrupted after reserving the ID and before recording a provider outcome.
  f.bridge.store.db.prepare('INSERT INTO outbound VALUES(?,?,?,?,?,?,?)')
    .run(f.a, 'pending-1', generation, hash(JSON.stringify([generation, 'pending', null])), 'fake-client-id', 'pending', Date.now());
  await f.restart();
  assert.equal((await f.bridge.send(f.a, 'accepted', 'accepted-1')).duplicate, true);
  await assert.rejects(f.bridge.send(f.a, 'pending', 'pending-1'), /previous_send_uncertain_or_failed/);
  assert.equal(f.provider.sends.length, 1);
});

test('unbind removes message data and keeps dispatched request IDs from being replayed after rebind', async t => {
  const f = await fixture(t);
  f.receive(f.a, 'a', f.bind(f.a, 'a'));
  await f.bridge.send(f.a, 'old notification', 'old-1');
  await f.call('/connect/api/unbind', { cookie: f.cookieFor(f.a), data: {} });
  const row = f.bridge.store.db.prepare('SELECT payload_hash,client_id,state FROM outbound WHERE owner=? AND request_id=?').get(f.a, 'old-1');
  assert.deepEqual({ ...row }, { payload_hash: '', client_id: '', state: 'unbound' });
  f.receive(f.a, 'replacement', f.bind(f.a, 'replacement'));
  await assert.rejects(f.bridge.send(f.a, 'old notification', 'old-1'), /request_id_conflict/);
  assert.equal(f.provider.sends.length, 1);
});

test('legacy authorized accounts keep their context, history, and event visibility on upgrade', async t => {
  const f = await fixture(t, 'relay');
  const waiting = f.bind(f.a, 'a');
  const complete = f.bind(f.b, 'b');
  const [privateA] = f.receive(f.a, 'a', waiting);
  const [privateB] = f.receive(f.b, 'b', complete);
  const [publicB] = f.bridge.store.ingest(f.b, complete, [f.message('b', 'm2')], 'cursor-2');
  await f.bridge.send(f.b, 'previous notification', 'before-upgrade');

  const store = f.bridge.store;
  const legacy = store.db.prepare('UPDATE bindings SET credentials=?,receipt_hash=?,verified=?,relay_after=? WHERE owner=?');
  const oldA = store.binding(f.a);
  const oldB = store.binding(f.b);
  legacy.run(store.encrypt({ ...oldA.credentials, receipt: '123456' }), hash('123456'), 0, 0, f.a);
  legacy.run(store.encrypt({ ...oldB.credentials, receipt: '654321' }), hash('654321'), 1, privateB.id, f.b);

  await f.restart();
  for (const [owner, previous] of [[f.a, oldA], [f.b, oldB]]) {
    const current = f.bridge.store.binding(owner);
    assert.deepEqual(current.credentials, previous.credentials);
    for (const field of ['generation', 'connected', 'last_inbound', 'last_outbound', 'error']) {
      assert.equal(current[field], previous[field]);
    }
    assert.equal(f.bridge.publicStatus(owner).binding.state, 'connected');
    assert.equal(current.receipt_hash, '');
    assert.equal(current.verified, 1);
  }
  assert.equal(f.bridge.store.db.prepare('SELECT COUNT(*) n FROM events').get().n, 3);
  assert.deepEqual(f.bridge.store.events('app-a'), []);
  assert.deepEqual(f.bridge.store.events('app-b').map(event => event.id), [publicB.id]);
  assert.equal((await f.bridge.send(f.b, 'previous notification', 'before-upgrade')).duplicate, true);
  assert.equal((await f.call(`/connect/v1/events/${privateA.id}/reply`, {
    token: f.tokenA, data: { text: 'hidden reply', request_id: 'reply-1' },
  })).status, 404);

  const [newA] = f.bridge.store.ingest(f.a, waiting, [f.message('a', 'm2')], 'cursor-2');
  await f.restart();
  assert.deepEqual(f.bridge.store.events('app-a').map(event => event.id), [newA.id]);
  assert.equal((await f.call(`/connect/v1/events/${newA.id}/reply`, {
    token: f.tokenA, data: { text: 'actual reply', request_id: 'reply-2' },
  })).status, 200);
});

test('upgrading an existing database preserves verified events and message deduplication', async t => {
  const f = await fixture(t);
  const generation = f.bind(f.a, 'a');
  f.receive(f.a, 'a', generation);
  const [event] = f.bridge.store.ingest(f.a, generation, [f.message('a', 'm2')], 'cursor');
  f.bridge.store.db.prepare("UPDATE events SET message_key='m2' WHERE id=?").run(event.id);
  f.bridge.store.db.exec('ALTER TABLE bindings DROP COLUMN relay_after');
  await f.restart();
  assert.ok(f.bridge.store.events('app-a').some(row => row.id === event.id));
  assert.equal(f.bridge.store.ingest(f.a, generation, [f.message('a', 'm2')], 'new-cursor').length, 0);
});

test('notification CLI reads stdin and safely retries with the same request ID', async t => {
  const f = await fixture(t);
  f.receive(f.a, 'a', f.bind(f.a, 'a'));
  const args = ['send', 'app-a', 'same-user-id', 'notice-1'];
  const text = 'First line\nSecond line';
  const first = await f.cli(args, text);
  const duplicate = await f.cli(args, text);
  assert.deepEqual(first, { accepted_by_wechat: true, delivery_confirmed: false });
  assert.equal(duplicate.duplicate, true);
  assert.equal(f.provider.sends.length, 1);
  assert.equal(f.provider.sends.at(-1).text, text);
});


test('shared inbox requires consent and keeps the original application sending alerts', async t => {
  const f = await fixture(t, 'relay');
  const generation = f.bind(f.a, 'a');
  const sourceCookie = f.cookieFor(f.a);
  const original = f.bridge.store.binding(f.a);
  const previous = f.receive(f.a, 'a', generation)[0];
  const invitation = await f.call('/connect/v1/invitations', {
    token: f.tokenB, data: { user_id: 'same-user-id', reuse_existing: true },
  });
  const invite = new URLSearchParams(new URL(invitation.result.url).hash.slice(1)).get('invite');
  const redeemed = await f.call('/connect/api/session', { cookie: sourceCookie, data: { invite } });
  const targetCookie = redeemed.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.call('/connect/api/status', { cookie: targetCookie })).result.share_application, 'B');
  assert.equal(f.bridge.store.connection(f.b), null);
  assert.equal((await f.call('/connect/api/share', { cookie: targetCookie, data: {} })).status, 200);
  const share = f.bridge.store.connection(f.b);
  assert.ok(share.shared);
  assert.equal(f.bridge.store.binding(f.a).generation, original.generation);
  assert.equal(f.bridge.store.binding(f.a).credentials.token, original.credentials.token);

  const messages = [
    { ...f.message('a', 'buffered'), create_time_ms: share.connected - 1 },
    f.message('a', 'missing-time'),
    { ...f.message('a', 'fresh'), create_time_ms: share.connected + 1 },
  ];
  const [event] = f.bridge.store.ingest(f.a, generation, messages, 'fresh-cursor');
  assert.equal(event.messageId, 'fresh');
  assert.deepEqual(f.bridge.store.events('app-a').map(row => row.id), [previous.id]);
  assert.deepEqual(f.bridge.store.events('app-b').map(row => row.id), [event.id]);
  const reply = `/connect/v1/events/${event.id}/reply`;
  const payload = { text: 'Glean answer', request_id: 'reply-1' };
  assert.equal((await f.call(reply, { token: f.tokenA, data: payload })).status, 404);
  assert.equal((await f.call(reply, { token: f.tokenB, data: payload })).status, 200);
  assert.equal((await f.call('/connect/v1/users/same-user-id/send', {
    token: f.tokenA, data: { text: 'resource alert', request_id: 'alert-1' },
  })).status, 200);
  assert.equal(f.provider.sends.length, 2);

  assert.equal((await f.call('/connect/v1/users/same-user-id/unbind', { token: f.tokenB, data: {} })).status, 200);
  assert.equal(f.bridge.store.connection(f.b), null);
  assert.ok(f.bridge.store.binding(f.a));
  assert.deepEqual(f.bridge.store.events('app-b'), []);
  assert.equal(f.bridge.store.ingest(f.a, generation, [messages[2]], 'new-cursor').length, 0);
  assert.equal((await f.call('/connect/api/status', { cookie: targetCookie })).status, 401);
});

test('a share requires a current source session and cannot cross a rebind', async t => {
  const f = await fixture(t, 'relay');
  f.bind(f.a, 'a');
  const source = f.cookieFor(f.a);
  const noProof = f.bridge.store.redeem(f.bridge.store.invitation(f.b, true));
  assert.equal((await f.call('/connect/api/share', {
    cookie: '__Secure-wechat_bridge=' + noProof, data: {},
  })).status, 409);
  const session = f.bridge.store.redeem(f.bridge.store.invitation(f.b, true), source.split('=')[1]);
  const cookie = '__Secure-wechat_bridge=' + session;
  f.bind(f.a, 'replacement');
  assert.equal((await f.call('/connect/api/share', { cookie, data: {} })).status, 409);
  assert.equal(f.bridge.store.connection(f.b), null);
});

test('notifications can be fenced to the intended connection', async t => {
  const f = await fixture(t);
  const first = f.bind(f.a, 'a');
  f.receive(f.a, 'a', first);
  const second = f.bind(f.a, 'new');
  f.receive(f.a, 'new', second);
  const response = await f.call('/connect/v1/users/same-user-id/send', {
    token: f.tokenA, data: { text: 'private notification', request_id: 'echo-1', connection_id: first },
  });
  assert.equal(response.result.error, 'binding_changed');
  assert.equal(f.provider.sends.length, 0);
});


test('the primary owner can revoke an inbox without unlinking its transport', async t => {
  const f = await fixture(t, 'relay');
  const generation = f.bind(f.a, 'a');
  f.receive(f.a, 'a', generation);
  const cookie = f.cookieFor(f.a);
  const session = f.bridge.store.redeem(f.bridge.store.invitation(f.b, true), cookie.split('=')[1]);
  assert.equal(f.bridge.store.grant(session, f.b), true);
  assert.equal((await f.call('/connect/api/revoke-share', { cookie, data: {} })).status, 200);
  assert.equal(f.bridge.store.connection(f.b), null);
  assert.equal(f.bridge.store.binding(f.a).generation, generation);
  assert.equal((await f.bridge.send(f.a, 'resource alert', 'alert-after-revoke')).accepted_by_wechat, true);
});


test('inline setup scopes the QR and official pairing challenge to its application user', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'relay');
  f.provider.qrStatus = async (base, qr, code) => code === 'AB12' ?
    { status: 'confirmed', bot_token: 'fake-token', ilink_bot_id: 'bot-a', ilink_user_id: 'wechat-a' } :
    { status: 'need_verifycode' };
  const base = '/connect/v1/users/same-user-id/binding-setup';
  const created = await f.call(base, { token: f.tokenA, data: {} });
  assert.equal(created.status, 201);
  const setup = base + '/' + created.result.setup_id;
  assert.equal((await f.call(setup + '/start', { token: f.tokenA, data: {} })).status, 409);
  assert.equal((await f.call('/connect/api/inline-claim', {
    origin: 'https://foreign.example.test', data: { setup_id: created.result.setup_id },
  })).status, 403);
  const claim = await f.call('/connect/api/inline-claim', { data: { setup_id: created.result.setup_id } });
  assert.equal(claim.status, 200);
  assert.equal(claim.headers.get('set-cookie'), null);
  assert.equal((await f.call('/connect/api/inline-claim', { data: { setup_id: created.result.setup_id } })).status, 409);
  assert.equal((await f.call(setup, { token: f.tokenB })).status, 409);
  assert.equal((await f.call(setup.replace('same-user-id', 'foreign-user'), { token: f.tokenA })).status, 409);
  const started = await f.call(setup + '/start', { token: f.tokenA, data: {} });
  assert.equal(started.result.login.state, 'need_verifycode');
  assert.equal(Buffer.from(started.result.qr_png, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal((await f.call(setup + '/verify-code', { token: f.tokenB, data: { code: 'AB12' } })).status, 409);
  assert.equal((await f.call(setup + '/verify-code', { token: f.tokenA, data: { code: 'AB12' } })).status, 200);
  await f.bridge.logins.get(f.a).task;
  const connected = await f.call(setup, { token: f.tokenA });
  assert.equal(connected.result.binding.state, 'connected');
  assert.equal(connected.result.qr_png, null);
  assert.equal((await f.call(setup + '/cancel', { token: f.tokenA, data: {} })).status, 200);
  assert.ok(f.bridge.store.binding(f.a));
  const reopened = await f.call(base, { token: f.tokenA, data: {} });
  assert.equal(reopened.result.setup_id, null);
});


test('inline sharing uses the original browser cookie without replacing it or starting a QR', async t => {
  const f = await fixture(t, 'relay');
  const generation = f.bind(f.a, 'a');
  f.receive(f.a, 'a', generation);
  const cookie = f.cookieFor(f.a);
  f.provider.qr = () => assert.fail('a shared connection must not generate a QR');
  const base = '/connect/v1/users/same-user-id/binding-setup';
  const created = await f.call(base, { token: f.tokenB, data: {} });
  const setup = base + '/' + created.result.setup_id;
  const claim = await f.call('/connect/api/inline-claim', { cookie, data: { setup_id: created.result.setup_id } });
  assert.equal(claim.status, 200);
  assert.equal(claim.headers.get('set-cookie'), null);
  const offer = await f.call(setup + '/start', { token: f.tokenB, data: {} });
  assert.equal(offer.result.share_application, 'B');
  assert.equal(offer.result.qr_png, null);
  assert.equal(f.bridge.store.connection(f.b), null);
  assert.equal((await f.call(setup + '/share', { token: f.tokenB, data: {} })).result.binding.shared, true);
  assert.equal((await f.call('/connect/api/status', { cookie })).result.has_share, true);
  assert.equal((await f.bridge.send(f.a, 'monitor unchanged', 'test-alert')).accepted_by_wechat, true);
  assert.equal((await f.call('/connect/v1/users/same-user-id/unbind', { token: f.tokenB, data: {} })).status, 200);
  assert.equal((await f.call(setup, { token: f.tokenB })).status, 409);
  assert.equal(f.bridge.store.binding(f.a).generation, generation);
});
