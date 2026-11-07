import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

const signer = fileURLToPath(new URL('./sign-nightly-macos.sh', import.meta.url));

const signingTools = `#!/bin/bash
set -euo pipefail
case "\${0##*/}" in
  plutil) echo 'app.emulator-content-server' ;;
  node)
    mkdir "$2/dmg"
    cp "$TEST_INPUT" "$2/dmg/fixture.dmg"
    ;;
  xcrun)
    printf '%s %s\\n' "$1" "$2" >> "$TEST_CALLS"
    case "$1 $2" in
      'notarytool submit') echo '{"status":"Accepted"}' ;;
      'stapler staple') ;;
      'stapler validate')
        attempt=$(grep -c '^stapler validate$' "$TEST_CALLS")
        case "$TEST_SCENARIO:$attempt" in
          recovery:3) exit 0 ;;
          recovery:2) echo 'Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."' >&2 ;;
          exhausted:*) echo 'Error Domain=NSURLErrorDomain Code=-1004 "Could not connect to the server."' >&2 ;;
          invalid:*) echo 'The staple and validate action failed because no ticket was attached.' >&2 ;;
          *) echo 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."' >&2 ;;
        esac
        echo 'The validate action failed! Error 68.' >&2
        exit 68
        ;;
      *) exit 99 ;;
    esac
    ;;
  sleep) printf 'sleep %s\\n' "$1" >> "$TEST_CALLS" ;;
esac
`;

const retryCalls = [
  'stapler validate',
  'sleep 5',
  'stapler validate',
  'sleep 10',
  'stapler validate',
];
const stubbedTools = ['hdiutil', 'ditto', 'plutil', 'codesign', 'node', 'xcrun', 'sleep', 'spctl'];

for (const [scenario, description, status, validationCalls] of [
  ['recovery', 'ticket validation recovers from a dropped connection and a timeout', 0, retryCalls],
  ['exhausted', 'ticket validation stops after three transient failures', 68, retryCalls],
  [
    'invalid',
    'a missing ticket fails immediately even with the same exit code',
    68,
    ['stapler validate'],
  ],
]) {
  test(description, { skip: process.platform === 'win32' }, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'ecs-signing-test-'));
    try {
      const tools = join(temporary, 'tools');
      const input = join(temporary, 'unsigned.dmg');
      const output = join(temporary, 'signed.dmg');
      const calls = join(temporary, 'calls');
      await mkdir(tools);
      await writeFile(input, 'generated disk image fixture');
      await writeFile(join(tools, 'fixture'), signingTools, { mode: 0o755 });
      for (const tool of stubbedTools) {
        await symlink('fixture', join(tools, tool));
      }
      const result = spawnSync('/bin/bash', [signer, input, output], {
        env: {
          ...process.env,
          PATH: `${tools}:${process.env.PATH}`,
          TMPDIR: temporary,
          APPLE_SIGNING_IDENTITY: 'fixture',
          ASC_KEY_PATH: join(temporary, 'fixture'),
          ASC_KEY_ID: 'fixture',
          ASC_ISSUER_ID: 'fixture',
          TEST_SCENARIO: scenario,
          TEST_INPUT: input,
          TEST_CALLS: calls,
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, status, result.stderr);
      assert.deepEqual((await readFile(calls, 'utf8')).trimEnd().split('\n'), [
        'notarytool submit',
        'stapler staple',
        ...validationCalls,
      ]);
      if (status === 0) {
        assert.deepEqual(await readFile(output), await readFile(input));
      } else {
        await assert.rejects(readFile(output), { code: 'ENOENT' });
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
