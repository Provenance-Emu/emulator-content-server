import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/main.js', import.meta.url));
test('serve accepts CHD flag/environment configuration and flag wins over environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ecs-cli-chd-'));
  try {
    for (const mode of ['flag', 'environment', 'precedence', 'missing-argument']) {
      const result = spawnSync(
        process.execPath,
        [
          cli,
          'serve',
          '--data',
          join(root, mode),
          '--ui',
          'none',
          ...(mode === 'flag' ? ['--chdman', join(root, 'missing')] : []),
          ...(mode === 'precedence' ? ['--chdman', 'relative-tool'] : []),
          ...(mode === 'missing-argument' ? ['--chdman'] : []),
        ],
        {
          env: {
            ...process.env,
            ECS_CHDMAN_PATH:
              mode === 'environment' || mode === 'precedence' ? join(root, 'missing') : '',
          },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      assert.equal(result.status, 1, mode);
      assert.match(
        result.stderr,
        mode === 'precedence' || mode === 'missing-argument'
          ? /absolute executable path/
          : /executable is missing/,
        mode,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const option of [
  { flag: '--chdman', environment: 'ECS_CHDMAN_PATH', error: /absolute executable path/ },
  { flag: '--player-dir', environment: 'ECS_PLAYER_DIR', error: /absolute directory path/ },
]) {
  test(`${option.flag} rejects relative flag and environment values while selecting service configuration`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ecs-cli-relative-'));
    try {
      for (const mode of ['flag', 'environment']) {
        const env = { ...process.env };
        delete env.ECS_CHDMAN_PATH;
        delete env.ECS_PLAYER_DIR;
        if (mode === 'environment') env[option.environment] = 'relative-tool';
        // status shares configuration selection with install and never installs a service.
        const result = spawnSync(
          process.execPath,
          [
            cli,
            'service',
            'status',
            '--data',
            root,
            ...(mode === 'flag' ? [option.flag, 'relative-tool'] : []),
          ],
          {
            env,
            encoding: 'utf8',
            timeout: 10000,
          },
        );
        assert.equal(result.status, 1, mode);
        assert.match(result.stderr, option.error, mode);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
