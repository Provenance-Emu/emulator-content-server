import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { playerCatalogSelection } from '../src/player-catalog-options.js';
import { renderRegistration, type ServiceSpec, serveArguments } from '../src/service.js';

const cli = fileURLToPath(new URL('../src/main.js', import.meta.url));
const id = 'a'.repeat(64);

test('catalog selection requires both an absolute file and an exact SHA-256 snapshot ID', () => {
  const file = join(tmpdir(), 'catalog.json');
  assert.deepEqual(playerCatalogSelection(file, id), { file, id });
  assert.equal(playerCatalogSelection(undefined, undefined), undefined);
  for (const [path, pin] of [
    [file, undefined],
    [undefined, id],
    ['relative.json', id],
    [file, 'bad'],
    [file, 'A'.repeat(64)],
  ]) {
    assert.throws(() => playerCatalogSelection(path, pin), /player-catalog/i);
  }
});

test('CLI exports a bundled snapshot without creating server data or replacing existing bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-cli-catalog-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'catalog.json');
  const data = join(directory, 'not-created');
  const result = spawnSync(
    process.execPath,
    [cli, 'player-catalog', 'export', '--to', file, '--data', data],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0);
  const before = await readFile(file);
  const catalog = JSON.parse(before.toString('utf8'));
  assert.equal(catalog.schemaVersion, 1);
  assert.match(catalog.id, /^[a-f0-9]{64}$/);
  assert.ok(catalog.entries.length > 0);
  assert.ok(result.stdout.includes(catalog.id));
  await assert.rejects(lstat(data), { code: 'ENOENT' });
  const duplicate = spawnSync(process.execPath, [cli, 'player-catalog', 'export', '--to', file], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(duplicate.status, 1);
  assert.deepEqual(await readFile(file), before);
});

test('serve selects the approved snapshot through flags or environment', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-cli-catalog-serve-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'catalog.json');
  assert.equal(
    spawnSync(process.execPath, [cli, 'player-catalog', 'export', '--to', file], {
      encoding: 'utf8',
      timeout: 10000,
    }).status,
    0,
  );
  const bundled = JSON.parse(await readFile(file, 'utf8'));
  const payload = { entries: [bundled.entries[0]], schemaVersion: 1 };
  const pin = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  await writeFile(file, JSON.stringify({ ...payload, id: pin }));
  for (const mode of ['flags', 'environment']) {
    const data = join(directory, mode);
    const reserve = createServer();
    reserve.listen(0, '127.0.0.1');
    await once(reserve, 'listening');
    const address = reserve.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((done) => reserve.close(() => done()));
    const env = { ...process.env };
    for (const name of [
      'ECS_PLAYER_CATALOG',
      'ECS_PLAYER_CATALOG_ID',
      'ECS_PLAYER_DIR',
      'ECS_PLAYER_PLUGINS',
      'ECS_CHDMAN_PATH',
    ])
      delete env[name];
    if (mode === 'environment') {
      env.ECS_PLAYER_CATALOG = file;
      env.ECS_PLAYER_CATALOG_ID = pin;
    }
    const child = spawn(
      process.execPath,
      [
        cli,
        'serve',
        '--data',
        data,
        '--ui',
        'none',
        '--port',
        String(port),
        ...(mode === 'flags' ? ['--player-catalog', file, '--player-catalog-id', pin] : []),
      ],
      { env, stdio: 'ignore' },
    );
    const base = `http://127.0.0.1:${port}`;
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null)
          throw new Error('Generated catalog server exited before listening');
        try {
          const response = await fetch(`${base}/api/v1/capabilities`);
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* server not ready */
        }
        await delay(100);
      }
      assert.ok(ready, 'Generated catalog server must become ready');
      const bootstrap = await fetch(`${base}/api/v1/auth/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: (await readFile(join(data, 'bootstrap.token'), 'utf8')).trim(),
          username: 'owner',
          password: 'generated-password',
        }),
      });
      assert.equal(bootstrap.status, 201);
      const session = (await bootstrap.json()) as { token: string };
      const response = await fetch(`${base}/api/v1/player/management`, {
        headers: { authorization: `Bearer ${session.token}` },
      });
      assert.equal(response.status, 200);
      const view = (await response.json()) as { available: { id: string }[] };
      assert.deepEqual(
        view.available.map((entry) => entry.id),
        [bundled.entries[0].id],
      );
    } finally {
      child.kill('SIGTERM');
      if (child.exitCode === null) await once(child, 'exit');
    }
  }
});

test('serve flags and environment reject invalid or incomplete pins before creating data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-cli-catalog-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'catalog.json');
  assert.equal(
    spawnSync(process.execPath, [cli, 'player-catalog', 'export', '--to', file], {
      encoding: 'utf8',
      timeout: 10000,
    }).status,
    0,
  );
  const clean = { ...process.env };
  delete clean.ECS_PLAYER_CATALOG;
  delete clean.ECS_PLAYER_CATALOG_ID;
  for (const [index, args] of [
    ['--player-catalog', file],
    ['--player-catalog-id', id],
    ['--player-catalog'],
    ['--player-catalog', file, '--player-catalog-id'],
    ['--player-catalog', file, '--player-catalog-id', id],
  ].entries()) {
    const data = join(directory, `flags-${index}`);
    const result = spawnSync(
      process.execPath,
      [cli, 'serve', '--data', data, '--ui', 'none', ...args],
      { env: clean, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /player.catalog/i);
    await assert.rejects(lstat(data), { code: 'ENOENT' });
  }
  const data = join(directory, 'environment');
  const result = spawnSync(process.execPath, [cli, 'serve', '--data', data, '--ui', 'none'], {
    env: { ...clean, ECS_PLAYER_CATALOG: file, ECS_PLAYER_CATALOG_ID: id },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /snapshot/i);
  await assert.rejects(lstat(data), { code: 'ENOENT' });
});

test('service registrations retain both catalog file and expected ID on all platforms', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const spec: ServiceSpec = {
      platform,
      home: tmpdir(),
      dataDir: join(tmpdir(), 'data'),
      executable: process.execPath,
      script: cli,
      host: '127.0.0.1',
      port: 8473,
      advertise: false,
      allowLan: false,
      publicInternet: false,
      tlsTerminated: false,
      bootstrapped: true,
      uid: 501,
      playerCatalogSnapshot: { file: join(tmpdir(), 'selected catalog.json'), id },
    };
    const args = serveArguments(spec);
    assert.equal(args[args.indexOf('--player-catalog') + 1], spec.playerCatalogSnapshot?.file);
    assert.equal(args[args.indexOf('--player-catalog-id') + 1], id);
    assert.ok(renderRegistration(spec).includes(id));
  }
});
