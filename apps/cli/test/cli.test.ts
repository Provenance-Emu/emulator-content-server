import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/main.js', import.meta.url));

test('init prints a bootstrap token once and doctor accepts the data directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-cli-'));
  try {
    const first = run(['init', '--data', dir, '--name', 'Test Library']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Bootstrap token:/);
    const mode = (await stat(join(dir, 'bootstrap.token'))).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600);
    const second = run(['init', '--data', dir]);
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /Bootstrap token:/);
    const report = run(['doctor', '--data', dir]);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /integrity ok/);
    assert.match(report.stdout, /bootstrap pending/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
