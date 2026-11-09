import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv } from 'node:crypto';

export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export const now = () => Date.now();

export class Store {
  constructor(path, encryptionKey) {
    this.key = Buffer.from(encryptionKey, 'base64');
    if (this.key.length !== 32) throw new Error('invalid_encryption_key');
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS owners(id TEXT PRIMARY KEY, application TEXT NOT NULL REFERENCES applications(id), external_id TEXT NOT NULL, UNIQUE(application,external_id));
      CREATE TABLE IF NOT EXISTS invitations(token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(owner TEXT PRIMARY KEY REFERENCES owners(id), wechat_hash TEXT UNIQUE NOT NULL, generation TEXT NOT NULL, credentials TEXT NOT NULL, receipt_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, connected INTEGER NOT NULL, last_inbound INTEGER, last_outbound INTEGER, error TEXT, relay_after INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL REFERENCES owners(id), generation TEXT NOT NULL, message_key TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(owner,message_key));
      CREATE TABLE IF NOT EXISTS outbound(owner TEXT NOT NULL, request_id TEXT NOT NULL, generation TEXT NOT NULL, payload_hash TEXT NOT NULL, client_id TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(owner,request_id));
      CREATE INDEX IF NOT EXISTS events_owner_id ON events(owner,id);`);
    if (!this.db.prepare('PRAGMA table_info(bindings)').all().some(column => column.name === 'relay_after')) {
      this.db.exec('ALTER TABLE bindings ADD COLUMN relay_after INTEGER NOT NULL DEFAULT 0');
    }
    this.migrateLegacyBindings();
  }
  migrateLegacyBindings() {
    // Keep the legacy columns readable by the previous release during a rollback.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const bindings = this.db.prepare("SELECT owner,credentials FROM bindings WHERE verified=0 OR receipt_hash<>''").all();
      const update = this.db.prepare(`UPDATE bindings SET credentials=?,receipt_hash='',verified=1,
        relay_after=CASE WHEN verified=0 THEN COALESCE(
          (SELECT MAX(id) FROM events WHERE owner=bindings.owner AND generation=bindings.generation), relay_after)
          ELSE relay_after END WHERE owner=?`);
      for (const row of bindings) {
        const credentials = this.decrypt(row.credentials);
        delete credentials.receipt;
        update.run(this.encrypt(credentials), row.owner);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  decrypt(value) {
    const data = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
  }
  application(token) {
    return this.db.prepare('SELECT id,name FROM applications WHERE token_hash=?').get(hash(token));
  }
  createApplication(id, name) {
    const token = secret();
    this.db.prepare('INSERT INTO applications VALUES(?,?,?)').run(id, name, hash(token));
    return token;
  }
  owner(application, externalId) {
    this.db.prepare('INSERT OR IGNORE INTO owners VALUES(?,?,?)').run(randomUUID(), application, externalId);
    return this.findOwner(application, externalId);
  }
  findOwner(application, externalId) {
    return this.db.prepare('SELECT * FROM owners WHERE application=? AND external_id=?').get(application, externalId);
  }
  invitation(owner) {
    const token = secret();
    this.db.prepare('INSERT INTO invitations VALUES(?,?,?)').run(hash(token), owner, now() + 30 * 60000);
    return token;
  }
  redeem(token) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invitation = this.db.prepare('DELETE FROM invitations WHERE token_hash=? AND expires>? RETURNING owner').get(hash(token), now());
      if (!invitation) { this.db.exec('ROLLBACK'); return null; }
      const session = secret();
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(session), invitation.owner, now() + 24 * 3600000);
      this.db.exec('COMMIT');
      return session;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  session(token) {
    return this.db.prepare('SELECT owner FROM sessions WHERE token_hash=? AND expires>?').get(hash(token), now())?.owner;
  }
  binding(owner) {
    const row = this.db.prepare('SELECT * FROM bindings WHERE owner=?').get(owner);
    return row ? { ...row, credentials: this.decrypt(row.credentials) } : null;
  }
  bind(owner, credentials) {
    const generation = randomUUID();
    const conflict = this.db.prepare('SELECT owner FROM bindings WHERE wechat_hash=? AND owner<>?').get(hash(credentials.userId), owner);
    if (conflict) throw new Error('wechat_already_bound');
    this.db.prepare(`INSERT INTO bindings(owner,wechat_hash,generation,credentials,receipt_hash,verified,connected)
      VALUES(?,?,?,?,'',1,?) ON CONFLICT(owner) DO UPDATE SET wechat_hash=excluded.wechat_hash,
      generation=excluded.generation,credentials=excluded.credentials,receipt_hash=excluded.receipt_hash,
      connected=excluded.connected,verified=1,last_inbound=NULL,last_outbound=NULL,error=NULL,relay_after=0`)
      .run(owner, hash(credentials.userId), generation, this.encrypt(credentials), now());
    return generation;
  }
  updateCredentials(owner, generation, credentials) {
    return this.db.prepare('UPDATE bindings SET credentials=? WHERE owner=? AND generation=?').run(this.encrypt(credentials), owner, generation).changes;
  }
  setError(owner, generation, error) {
    this.db.prepare('UPDATE bindings SET error=? WHERE owner=? AND generation=?').run(error, owner, generation);
  }
  clearNetworkError(owner, generation) {
    this.db.prepare("UPDATE bindings SET error=NULL WHERE owner=? AND generation=? AND error='network_retry'").run(owner, generation);
  }
  acceptSend(owner, id, generation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE outbound SET state='accepted' WHERE owner=? AND request_id=? AND generation=? AND state='pending'").run(owner, id, generation);
      this.db.prepare('UPDATE bindings SET last_outbound=?,error=NULL WHERE owner=? AND generation=?').run(now(), owner, generation);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  unbind(owner) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM bindings WHERE owner=?').run(owner);
      this.db.prepare("UPDATE outbound SET payload_hash='',client_id='',state='unbound' WHERE owner=?").run(owner);
      this.db.prepare('DELETE FROM events WHERE owner=?').run(owner);
      this.db.exec('COMMIT');
      // Limit old encrypted pages in the WAL after deletion.
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  ingest(owner, generation, messages, cursor) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const binding = this.binding(owner);
      if (!binding || binding.generation !== generation) { this.db.exec('ROLLBACK'); return []; }
      const accepted = [];
      const legacyEvent = this.db.prepare('SELECT 1 FROM events WHERE owner=? AND generation=? AND message_key=?');
      for (const message of messages) {
        if (message.message_type !== 1 || message.from_user_id !== binding.credentials.userId) continue;
        if (message.to_user_id && message.to_user_id !== binding.credentials.botId) continue;
        const text = (message.item_list || []).filter(i => i.type === 1).map(i => i.text_item?.text || '').join('\n').slice(0, 16000);
        const key = String(message.message_id ?? hash(JSON.stringify(message)));
        if (legacyEvent.get(owner, generation, key)) continue;
        const payload = { text, context: message.context_token || '', media: !text, messageId: key };
        const result = this.db.prepare('INSERT OR IGNORE INTO events(owner,generation,message_key,payload,created) VALUES(?,?,?,?,?) RETURNING id')
          .get(owner, generation, `${generation}:${key}`, this.encrypt(payload), now());
        if (!result) continue;
        if (payload.context) binding.credentials.context = payload.context;
        accepted.push({ ...payload, id: result.id });
      }
      if (typeof cursor === 'string' && cursor) binding.credentials.cursor = cursor;
      this.updateCredentials(owner, generation, binding.credentials);
      if (accepted.length) this.db.prepare('UPDATE bindings SET last_inbound=? WHERE owner=? AND generation=?').run(now(), owner, generation);
      this.db.exec('COMMIT');
      return accepted;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  events(application, after = 0, limit = 100) {
    return this.db.prepare(`SELECT e.*,o.external_id FROM events e JOIN owners o ON e.owner=o.id
      JOIN bindings b ON b.owner=e.owner AND b.generation=e.generation
      WHERE o.application=? AND e.id>? AND e.id>b.relay_after ORDER BY e.id LIMIT ?`).all(application, after, limit)
      .map(row => {
        const { text, media } = this.decrypt(row.payload);
        return { id: row.id, user_id: row.external_id, created_at: row.created, text, media_unsupported: media };
      });
  }
  cleanup() {
    this.db.prepare('DELETE FROM invitations WHERE expires<?').run(now());
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(now());
    this.db.prepare('DELETE FROM events WHERE created<?').run(now() - 7 * 86400000);
    this.db.prepare('DELETE FROM outbound WHERE created<?').run(now() - 7 * 86400000);
  }
}
