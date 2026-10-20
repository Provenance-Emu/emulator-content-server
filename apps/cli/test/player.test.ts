import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
