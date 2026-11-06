import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareUpdateDirectory, readUpdateState, runtime } from '../src/update-files.js';

const candidate = 'b'.repeat(64);

for (const fails of [false, true]) {
  test(`launcher ${fails ? 'rolls back a failed migration startup' : 'activates a new build after readiness'}`, {
    timeout: 20_000,
  }, async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'ecs-update-launcher-'));
    const data = join(base, 'data');
    const startup = join(base, 'bootstrap');
    const updates = await prepareUpdateDirectory(data);
    await fixture(startup, data, false, false);
    await fixture(join(updates, 'builds', candidate), data, true, fails);
    const module = new URL('../src/supervise.js', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { supervise } from ${JSON.stringify(module)};
       await supervise(${JSON.stringify(data)}, ['serve'], ${JSON.stringify(startup)});`,
      ],
      { stdio: 'ignore' },
    );
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') {
          await writeFile(join(data, 'stop'), '');
          await exited;
        } else {
          child.kill('SIGTERM');
          await exited;
        }
      }
      await rm(base, { recursive: true, force: true });
    });

    const expected = fails ? 'old' : 'new';
    const marker = join(data, expected);
    for (let i = 0; i < 150; i++) {
      assert.equal(child.exitCode, null);
      if ((await readFile(marker, 'utf8').catch(() => '')) === expected) break;
      await delay(50);
    }
    assert.equal(await readFile(marker, 'utf8'), expected);
    const state = await readUpdateState(updates);
    assert.equal(state.pending, undefined);
    assert.equal(state.active, fails ? undefined : candidate);
    assert.equal(state.failed, fails ? candidate : undefined);
    const database = new DatabaseSync(join(data, 'library.sqlite'), { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT value FROM example').get()?.value, expected);
    } finally {
      database.close();
    }
  });
}

async function fixture(root: string, data: string, trial: boolean, fails: boolean): Promise<void> {
  const executable = runtime(root);
  await mkdir(dirname(executable), { recursive: true });
  await link(process.execPath, executable).catch(() => copyFile(process.execPath, executable));
  const script = join(root, 'server', 'dist', 'src', 'main.js');
  await mkdir(dirname(script), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(
    script,
    `
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { DatabaseSync } from 'node:sqlite';
    const data = ${JSON.stringify(data)};
    const tried = join(data, 'tried');
    const db = new DatabaseSync(join(data, 'library.sqlite'));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS example(value)");
    if (!db.prepare('SELECT value FROM example').get()) db.exec("INSERT INTO example VALUES ('old')");
    if (${trial}) db.exec("UPDATE example SET value='new'");
    if (${fails}) process.exit(1);
    process.on('message', ({ type }) => {
      if (type === 'ecs-stop') { db.close(); process.exit(0); }
      if (type !== 'ecs-activate') return;
      if (!${trial} && !existsSync(tried)) {
        writeFileSync(tried, '');
        process.send({ type: 'ecs-install', id: '${candidate}' });
      } else {
        const { value } = db.prepare('SELECT value FROM example').get();
        writeFileSync(join(data, value), value);
      }
    });
    process.on('disconnect', () => process.exit(0));
    setInterval(() => { if (existsSync(join(data, 'stop'))) process.exit(0); }, 50);
    process.send({ type: 'ecs-ready' });
  `,
  );
}
