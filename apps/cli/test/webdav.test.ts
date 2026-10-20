import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/main.js', import.meta.url));
test('serve exposes DAV only when selected by flag or environment', async () => {
  for (const mode of ['off', 'flag', 'environment']) {
    const data = await mkdtemp(join(tmpdir(), 'ecs-cli-dav-'));
    const reserve = createServer();
    reserve.listen(0, '127.0.0.1');
    await once(reserve, 'listening');
    const address = reserve.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const child = spawn(
      process.execPath,
      [
        cli,
        'serve',
        '--data',
        data,
        '--port',
        String(port),
        '--ui',
        'none',
        ...(mode === 'flag' ? ['--webdav'] : []),
      ],
      {
        env: { ...process.env, ECS_WEBDAV: mode === 'environment' ? '1' : '0' },
        stdio: 'ignore',
      },
    );
    try {
      let actual: boolean | undefined;
      for (let retry = 0; retry < 100; retry++) {
        if (child.exitCode !== null) throw new Error('Fixture server exited before listening');
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/v1/capabilities`);
          actual = ((await response.json()) as { features: { webdav: boolean } }).features.webdav;
          break;
        } catch {
          await delay(100);
        }
      }
      assert.equal(actual, mode !== 'off');
    } finally {
      child.kill('SIGTERM');
      if (child.exitCode === null) await once(child, 'exit');
      await rm(data, { recursive: true, force: true });
    }
  }
});
