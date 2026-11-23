import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareUpdateDirectory, runtime } from '../src/update-files.js';

// Windows has no signals to send; its service is a logon task the user already controls.
const skip = process.platform === 'win32';

for (const hangs of [false, true]) {
  test(`the launcher restarts, stops and starts ${hangs ? 'a server that ignores it' : 'its server'} when its owner signals it`, {
    timeout: 30_000,
    skip,
  }, async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'ecs-supervisor-control-'));
    const data = join(base, 'data');
    const startup = join(base, 'bootstrap');
    await prepareUpdateDirectory(data);
    await fixture(startup, data, hangs);
    const module = new URL('../src/update-supervisor.js', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { supervise } from ${JSON.stringify(module)};
         await supervise(${JSON.stringify(data)}, ['serve'], ${JSON.stringify(startup)}, { stopGraceMs: 300 });`,
      ],
      { stdio: 'ignore' },
    );
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      await rm(base, { recursive: true, force: true });
    });
    const starts = async () =>
      (await readFile(join(data, 'starts'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
    const alive = (pid: string) => {
      try {
        process.kill(Number(pid), 0);
        return true;
      } catch {
        return false;
      }
    };
    const until = async (check: () => Promise<boolean> | boolean) => {
      for (let i = 0; i < 200; i++) {
        assert.equal(child.exitCode, null, 'the launcher must stay up');
        if (await check()) return;
        await delay(50);
      }
      assert.fail('timed out');
    };

    await until(async () => (await starts()).length === 1);
    const [first] = await starts();

    child.kill('SIGHUP');
    await until(async () => (await starts()).length === 2);
    const second = (await starts())[1] as string;
    assert.notEqual(second, first);
    await until(() => !alive(first as string));

    child.kill('SIGUSR2');
    await until(() => !alive(second));
    await delay(400);
    assert.equal((await starts()).length, 2, 'a stopped server stays stopped');
    assert.equal(child.exitCode, null, 'the launcher waits so launchd does not start another');

    // Stopping twice changes nothing; starting brings it back.
    child.kill('SIGUSR2');
    // Two different signals sent together may arrive in either order.
    await delay(100);
    child.kill('SIGHUP');
    await until(async () => (await starts()).length === 3);

    // A stop that follows a restart wins, whether or not the new server had come up yet.
    child.kill('SIGHUP');
    await delay(100);
    child.kill('SIGUSR2');
    await until(async () => (await starts()).every((pid) => !alive(pid)));
    const stopped = (await starts()).length;
    await delay(400);
    assert.equal((await starts()).length, stopped, 'nothing comes back by itself');
    assert.ok((await starts()).every((pid) => !alive(pid)));
    child.kill('SIGHUP');
    await until(async () => (await starts()).length === stopped + 1);

    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0);
  });
}

async function fixture(root: string, data: string, hangs: boolean): Promise<void> {
  const executable = runtime(root);
  await mkdir(dirname(executable), { recursive: true });
  await link(process.execPath, executable).catch(() => copyFile(process.execPath, executable));
  const script = join(root, 'server', 'dist', 'src', 'main.js');
  await mkdir(dirname(script), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(
    script,
    `
    import { appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    process.on('message', ({ type }) => {
      if (type === 'ecs-stop' && !${hangs}) process.exit(0);
      if (type === 'ecs-activate') appendFileSync(join(${JSON.stringify(data)}, 'starts'), process.pid + '\\n');
    });
    process.on('disconnect', () => process.exit(0));
    setInterval(() => {}, 1000);
    process.send({ type: 'ecs-ready' });
  `,
  );
}
