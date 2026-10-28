import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/main.js', import.meta.url));
test('serve enables playback only for the explicit player flag or environment', async () => {
  for (const mode of ['off', 'flag', 'environment']) {
    const dir = await mkdtemp(join(tmpdir(), 'ecs-cli-player-'));
    const playerDir = join(dir, 'trusted core');
    await mkdir(playerDir);
    const loader = 'export default async () => ({});';
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(playerDir, 'fceumm_libretro.js'), loader);
    await writeFile(join(playerDir, 'fceumm_libretro.wasm'), wasm);
    await writeFile(
      join(playerDir, 'core.json'),
      JSON.stringify({
        version: 1,
        id: 'fceumm',
        name: 'FCEUmm',
        systems: ['com.provenance.nes'],
        runtime: 'retroarch-emscripten-esm',
        threaded: false,
        filesystem: 'memfs',
        saveCompletion: 'command-reply-v1',
        frontendCommit: '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66',
        coreCommit: 'ac0d00a7fc01166f84c7bac01d1084ebfd2b865e',
        emscriptenVersion: '3.1.46',
        contentExtension: 'nes',
        maxContentBytes: 67108864,
        loader: { file: 'fceumm_libretro.js', sha256: sha(loader) },
        wasm: { file: 'fceumm_libretro.wasm', sha256: sha(wasm) },
      }),
    );
    const reserve = createServer();
    reserve.listen(0, '127.0.0.1');
    await once(reserve, 'listening');
    const address = reserve.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const env = { ...process.env };
    delete env.ECS_PLAYER_DIR;
    if (mode === 'environment') env.ECS_PLAYER_DIR = playerDir;
    const child = spawn(
      process.execPath,
      [
        cli,
        'serve',
        '--data',
        join(dir, 'data'),
        '--port',
        String(port),
        '--ui',
        'none',
        ...(mode === 'flag' ? ['--player-dir', playerDir] : []),
      ],
      { env, stdio: 'ignore' },
    );
    try {
      let enabled: boolean | undefined;
      for (let retry = 0; retry < 100; retry++) {
        if (child.exitCode !== null) throw new Error('Fixture server exited before listening');
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/v1/capabilities`);
          enabled = ((await response.json()) as { features: { webPlayback: boolean } }).features
            .webPlayback;
          break;
        } catch {
          await delay(100);
        }
      }
      assert.equal(enabled, mode !== 'off');
    } finally {
      child.kill('SIGTERM');
      if (child.exitCode === null) await once(child, 'exit');
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('an explicitly selected player flag without its required path fails clearly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-cli-player-missing-'));
  try {
    const env = { ...process.env };
    delete env.ECS_PLAYER_DIR;
    const result = spawnSync(
      process.execPath,
      [cli, 'serve', '--data', dir, '--ui', 'none', '--port', '18973', '--player-dir'],
      { env, timeout: 5000, encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /player.*(path|directory)/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('player plugins flag and environment install a live portable player catalog', async () => {
  for (const mode of ['flag', 'environment']) {
    const dir = await mkdtemp(join(tmpdir(), 'ecs-cli-player-plugins-'));
    const registry = join(dir, 'players');
    const plugin = join(registry, 'fixture');
    await mkdir(plugin, { recursive: true });
    const loader = 'export default async () => ({});';
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(plugin, 'loader.js'), loader);
    await writeFile(join(plugin, 'core.wasm'), wasm);
    await writeFile(
      join(plugin, 'plugin.json'),
      JSON.stringify({
        id: 'org.example.player',
        name: 'Fixture',
        kind: 'player',
        version: '1',
        engine: 'ecs.plugin/1',
        apps: ['org.example.app'],
        player: {
          systems: ['com.provenance.nes'],
          module: 'core.wasm',
          web: {
            profileVersion: 1,
            runtime: 'emscripten-esm-v1',
            filesystem: 'memfs',
            threaded: false,
            saveCompletion: 'none',
            contentExtensions: ['nes'],
            maxContentBytes: 1024,
            buildVersion: 'fixture-1',
            loader: { file: 'loader.js', sha256: sha(loader) },
            wasm: { file: 'core.wasm', sha256: sha(wasm) },
            assets: [],
          },
        },
      }),
    );
    const reserve = createServer();
    reserve.listen(0, '127.0.0.1');
    await once(reserve, 'listening');
    const address = reserve.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const env = { ...process.env };
    delete env.ECS_PLAYER_DIR;
    delete env.ECS_PLAYER_PLUGINS;
    if (mode === 'environment') env.ECS_PLAYER_PLUGINS = registry;
    const child = spawn(
      process.execPath,
      [
        cli,
        'serve',
        '--data',
        join(dir, 'data'),
        '--port',
        String(port),
        '--ui',
        'none',
        ...(mode === 'flag' ? ['--player-plugins', registry] : []),
      ],
      { env, stdio: 'ignore' },
    );
    try {
      let ready = false;
      for (let retry = 0; retry < 100; retry++) {
        if (child.exitCode !== null)
          throw new Error('Fixture plugin server exited before listening');
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/v1/capabilities`);
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* Startup is asynchronous. */
        }
        await delay(100);
      }
      assert.equal(ready, true);
      const bootstrap = await fetch(`http://127.0.0.1:${port}/api/v1/auth/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: (await readFile(join(dir, 'data', 'bootstrap.token'), 'utf8')).trim(),
          username: 'owner',
          password: 'fixture-password',
        }),
      });
      assert.equal(bootstrap.status, 201);
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/player/profiles`);
      assert.equal(response.status, 200);
      const catalog = (await response.json()) as {
        items: { id: string }[];
        defaultProfileId: string | null;
      };
      assert.equal(catalog?.items[0]?.id, 'org.example.player');
      assert.equal(catalog?.defaultProfileId, 'org.example.player');
    } finally {
      child.kill('SIGTERM');
      if (child.exitCode === null) await once(child, 'exit');
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('player plugins rejects a missing path before listening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-cli-plugins-missing-'));
  try {
    const env = { ...process.env };
    delete env.ECS_PLAYER_PLUGINS;
    const result = spawnSync(
      process.execPath,
      [cli, 'serve', '--data', dir, '--ui', 'none', '--player-plugins'],
      { env, timeout: 10000, encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /player.*(path|directory)/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
