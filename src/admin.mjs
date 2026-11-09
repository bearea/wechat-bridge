import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.umask(0o077);
const configPath = process.env.WECHAT_BRIDGE_CONFIG || '/etc/wechat-bridge/config.json';
const [command, first, second, third] = process.argv.slice(2);
const key = () => randomBytes(32).toString('base64url');
try {
  if (command === 'init') {
    if (!first || !first.startsWith('https://') || !first.endsWith('/')) throw new Error('Provide an HTTPS public URL ending in /.');
    if (existsSync(configPath)) throw new Error('Configuration already exists; refusing to overwrite encryption keys.');
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o750 });
    writeFileSync(configPath, JSON.stringify({ publicUrl: first, port: 8318, mode: 'test',
      database: '/var/lib/wechat-assistant/bridge.sqlite', adminToken: key(), encryptionKey: randomBytes(32).toString('base64') }, null, 2) + '\n', { mode: 0o600 });
    console.log('Configuration created. Keep this file outside version control.');
  } else {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    async function call(path, token, data) {
      const response = await fetch(`http://127.0.0.1:${config.port}${path}`, { method: data === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(25000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Request failed.');
      return result;
    }
    const prefix = new URL(config.publicUrl).pathname;
    const apps = join(dirname(configPath), 'applications');
    if (command === 'app-create') {
      if (!/^[a-z][a-z0-9-]{0,48}$/.test(first || '')) throw new Error('Use a lowercase application id.');
      const result = await call('/admin/v1/applications', config.adminToken, { id: first, name: second || first });
      mkdirSync(apps, { recursive: true, mode: 0o700 });
      const path = join(apps, `${first}.json`);
      writeFileSync(path, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      console.log(`Application created; private credential saved to ${path}`);
    } else if (['invite', 'status', 'send'].includes(command)) {
      if (!/^[a-z][a-z0-9-]{0,48}$/.test(first || '') || !second) throw new Error('Specify application id and user id.');
      const { token } = JSON.parse(readFileSync(join(apps, `${first}.json`), 'utf8'));
      const userPath = prefix + `v1/users/${encodeURIComponent(second)}`;
      if (command === 'invite') {
        const result = await call(prefix + 'v1/invitations', token, { user_id: second });
        console.log(result.url);
      } else if (command === 'status') {
        console.log(JSON.stringify(await call(userPath + '/status', token), null, 2));
      } else {
        if (!third) throw new Error('Specify a stable request ID and provide the message on stdin.');
        const result = await call(userPath + '/send', token, { request_id: third, text: readFileSync(0, 'utf8') });
        console.log(JSON.stringify(result, null, 2));
      }
    } else throw new Error('Commands: init PUBLIC_URL | app-create APP_ID [NAME] | invite APP_ID USER_ID | status APP_ID USER_ID | send APP_ID USER_ID REQUEST_ID < message.txt');
  }
} catch (error) { console.error(error.message); process.exit(1); }
