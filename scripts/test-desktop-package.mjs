import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const publisher = fileURLToPath(new URL('./publish-desktop.mjs', import.meta.url));
test('staging nightly installers validates the set, names and hashes without invoking gh', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'ecs-installer-stage-'));
  const source = join(temporary, 'installers');
  const suffixes =
    process.platform === 'darwin'
      ? ['.dmg']
      : process.platform === 'win32'
        ? ['.msi']
        : ['.deb', '.AppImage'];
  const label =
    process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  const bytes = Buffer.from('original generated installer fixture');
  try {
    await mkdir(source);
    for (const suffix of suffixes) await writeFile(join(source, `generated${suffix}`), bytes);
    // No gh executable is available. Staging must succeed without a remote operation.
    execFileSync(process.execPath, [publisher, 'nightly', source, '--stage-only'], {
      cwd: temporary,
      env: { ...process.env, PATH: temporary },
      stdio: 'pipe',
    });
    const output = join(temporary, 'dist-release/desktop');
    const sums = await readFile(
      join(output, `SHA256SUMS-desktop-${process.platform}-${process.arch}.txt`),
      'utf8',
    );
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal((await readdir(output)).length, suffixes.length + 1);
    for (const suffix of suffixes) {
      const name = `Emulation-Server-nightly-${label}-${process.arch}${suffix}`;
      assert.deepEqual(await readFile(join(output, name)), bytes);
      assert.ok(sums.includes(`${digest}  ${name}\n`));
    }
    // Missing an expected installer must fail before publication or an incomplete asset set.
    await rm(join(source, `generated${suffixes[0]}`));
    assert.throws(() =>
      execFileSync(process.execPath, [publisher, 'nightly', source, '--stage-only'], {
        cwd: temporary,
        env: { ...process.env, PATH: temporary },
        stdio: 'pipe',
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
