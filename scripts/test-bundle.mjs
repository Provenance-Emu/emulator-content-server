import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { bundle } from './bundle.mjs';

test('bundle preserves existing files even when pnpm force configuration is enabled', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'ecs-bundle-safety-'));
  const marker = join(temporary, 'must-preserve.txt');
  const previousForce = process.env.npm_config_force;
  try {
    await writeFile(marker, 'generated preservation marker');
    process.env.npm_config_force = 'true';
    await assert.rejects(bundle(temporary, 'ignore'), /Bundle destination must be/);
    assert.equal(await readFile(marker, 'utf8'), 'generated preservation marker');
  } finally {
    if (previousForce === undefined) delete process.env.npm_config_force;
    else process.env.npm_config_force = previousForce;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('bundle refuses a symlink to an empty destination directory', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'ecs-bundle-symlink-'));
  try {
    const actual = join(temporary, 'actual');
    const linked = join(temporary, 'linked');
    await mkdir(actual);
    await symlink(actual, linked, 'dir');
    await assert.rejects(bundle(linked, 'ignore'), /Bundle destination must be/);
    await writeFile(join(actual, 'still-writable.txt'), 'generated marker');
    assert.equal(await readFile(join(linked, 'still-writable.txt'), 'utf8'), 'generated marker');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('isolated production bundle serves health, interface and its JS/CSS assets', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'ecs-bundle-'));
  let child;
  try {
    const deployed = await bundle(join(temporary, 'server'), 'ignore');
    const reserve = createServer();
    reserve.listen(0, '127.0.0.1');
    await once(reserve, 'listening');
    const address = reserve.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise((done) => reserve.close(done));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('ECS_') || key === 'NODE_PATH' || key === 'NODE_OPTIONS') delete env[key];
    }
    child = spawn(
      process.execPath,
      [
        join(deployed, 'dist/src/main.js'),
        'serve',
        '--data',
        join(temporary, 'data'),
        '--host',
        '127.0.0.1',
        '--port',
        String(address.port),
      ],
      { cwd: temporary, env, stdio: 'ignore' },
    );
    const origin = `http://127.0.0.1:${address.port}`;
    let healthy = false;
    for (let retry = 0; retry < 100; retry++) {
      assert.equal(child.exitCode, null, 'Deployed CLI exited before listening');
      try {
        healthy = (await fetch(`${origin}/health`)).ok;
        if (healthy) break;
      } catch {}
      await delay(100);
    }
    assert.ok(healthy, 'Deployed CLI must become healthy');
    const response = await fetch(`${origin}/ui/`);
    assert.equal(response.status, 200, 'Deployed CLI must discover its packaged UI');
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(
      (match) => match[1],
    );
    assert.ok(
      assets.some((asset) => asset.endsWith('.js')),
      'Built HTML must reference JavaScript',
    );
    assert.ok(
      assets.some((asset) => asset.endsWith('.css')),
      'Built HTML must reference CSS',
    );
    for (const asset of assets) {
      const url = new URL(asset, `${origin}/ui/`);
      assert.equal(url.origin, origin);
      const fetched = await fetch(url);
      assert.equal(fetched.status, 200, `Missing bundled asset ${url.pathname}`);
      assert.match(fetched.headers.get('content-type'), /javascript|text\/css/);
      assert.ok((await fetched.arrayBuffer()).byteLength > 0);
    }
  } finally {
    if (child && child.exitCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      await stopped;
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
