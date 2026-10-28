import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('help after a command prints usage before creating data or running that command', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-cli-help-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, 'must-not-be-created');
  const main = fileURLToPath(new URL('../src/main.js', import.meta.url));
  for (const command of [['init'], ['service', 'install'], ['backup'], ['roots', 'remove']]) {
    const result = spawnSync(process.execPath, [main, ...command, '--help', '--data', data], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('ecs serve --data'), 'Subcommand help should print usage');
  }
  await assert.rejects(stat(data), { code: 'ENOENT' });
});
