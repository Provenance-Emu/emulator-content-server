import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// pnpm verify runs this on Windows without Pester or a Rust toolchain. Never
// create, run, or stop a real task on the developer's machine or in CI.
test('Windows script enforces task ownership and controls only the existing task', {
  skip: process.platform !== 'win32',
}, async () => {
  const script = await readFile(
    new URL('../../src-tauri/src/service.ps1', import.meta.url),
    'utf8',
  );
  const fixture = await readFile(
    new URL('../../test/scheduler-fixture.ps1', import.meta.url),
    'utf8',
  );
  const directory = await mkdtemp(join(tmpdir(), 'ecs-tray-task-'));
  const eventFile = join(directory, 'event.txt');
  const cases = [
    { action: 'status', state: 4, result: 'running', event: null },
    { action: 'status', state: 4, accountName: true, result: 'running', event: null },
    { action: 'status', state: 1, result: null, event: null },
    { action: 'status', state: 3, result: 'stopped', event: null },
    { action: 'status', state: 2, result: 'starting', event: null },
    { action: 'status', missing: true, result: 'absent', event: null },
    { action: 'start', missing: true, result: null, event: null },
    { action: 'start', state: 3, result: 'starting', event: 'run' },
    { action: 'start', state: 4, result: 'running', event: null },
    { action: 'stop', state: 4, result: 'stopping', event: 'stop' },
    { action: 'stop', state: 2, result: 'stopping', event: 'stop' },
    { action: 'stop', state: 3, result: 'stopping', event: null },
    { action: 'start', foreign: true, result: null, event: null },
    { action: 'stop', foreign: true, result: null, event: null },
    { action: 'start', runLevel: 1, result: null, event: null },
    { action: 'start', logonType: 5, result: null, event: null },
  ];
  try {
    for (const scenario of cases) {
      await rm(eventFile, { force: true });
      const prelude = `
$testEventFile = '${eventFile.replaceAll("'", "''")}'
$testState = ${scenario.state ?? 3}
$testMissing = $${scenario.missing ?? false}
$testForeign = $${scenario.foreign ?? false}
$testAccountName = $${scenario.accountName ?? false}
$testRunLevel = ${scenario.runLevel ?? 0}
$testLogonType = ${scenario.logonType ?? 3}
`;
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `${prelude}\n${fixture}\n& { ${script} } -Action ${scenario.action}`,
        ],
        { encoding: 'utf8', timeout: 15_000, windowsHide: true },
      );
      assert.ifError(result.error);
      assert.equal(result.status, scenario.result === null ? 1 : 0, JSON.stringify(scenario));
      assert.equal(result.stdout.trim(), scenario.result ?? '', JSON.stringify(scenario));
      const event = await readFile(eventFile, 'utf8').catch(() => null);
      assert.equal(event, scenario.event, JSON.stringify(scenario));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
