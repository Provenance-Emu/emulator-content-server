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
