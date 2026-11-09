import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

test('the server CLI listens when launched through a release directory symlink', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-bridge-cli-'));
  const app = join(directory, 'app');
  const config = join(directory, 'config.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), app, 'dir');
  writeFileSync(config, JSON.stringify({
    publicUrl: 'https://bridge.example.test/connect/',
    port: 0,
    database: join(directory, 'bridge.sqlite'),
    encryptionKey: randomBytes(32).toString('base64'),
    mode: 'test',
  }));

  const child = spawn(process.execPath, [join(app, 'src', 'server.mjs')], {
    env: { ...process.env, NODE_OPTIONS: '', WECHAT_BRIDGE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  const output = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  try {
    const [line] = await Promise.race([
      once(output, 'line', { signal: AbortSignal.timeout(5000) }),
      closed.then(([code]) => assert.fail(`Server exited before listening (code ${code}). ${stderr}`)),
    ]);
    const startup = JSON.parse(line);
    assert.equal(startup.event, 'bridge_started');
    assert.ok(startup.port > 0);
    const response = await fetch(`http://127.0.0.1:${startup.port}/healthz`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', mode: 'test' });
    const stopping = once(child, 'close', { signal: AbortSignal.timeout(3000) });
    child.kill('SIGTERM');
    assert.deepEqual(await stopping, [0, null]);
  } finally {
    output.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
});
