import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = await readFile(new URL('./sign-nightly-macos.sh', import.meta.url), 'utf8');
const retry = script.slice(
  script.indexOf("# Stapler's exit code"),
  script.indexOf('hdiutil verify'),
);

for (const scenario of [
  {
    action: 'staple',
    failure: 'network',
    recover: true,
    status: 0,
    calls: 'staple\nstaple\nstaple\nvalidate\n',
  },
  {
    action: 'validate',
    failure: 'network',
    recover: true,
    status: 0,
    calls: 'staple\nvalidate\nvalidate\nvalidate\n',
  },
  { action: 'staple', failure: 'invalid', recover: false, status: 65, calls: 'staple\n' },
  {
    action: 'staple',
    failure: 'network',
    recover: false,
    status: 68,
    calls: 'staple\nstaple\nstaple\n',
  },
]) {
  test(`ticket ${scenario.action} ${scenario.failure} recovery=${scenario.recover}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ecs-stapler-test-'));
    try {
      const result = spawnSync(
        '/bin/bash',
        [
          '-c',
          `
set -euo pipefail
xcrun() {
  printf '%s\\n' "$2" >> "$CALLS"
  if [[ "$2" == "$ACTION" ]]; then
    count=$(grep -c "^$ACTION$" "$CALLS")
    if [[ "$RECOVER" != true || "$count" -lt 3 ]]; then
      if [[ "$FAILURE" == invalid ]]; then
        echo 'The ticket is invalid.' >&2
        return 65
      fi
      echo 'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."' >&2
      return 68
    fi
  fi
  echo 'The action succeeded!'
}
sleep() { :; }
dmg=generated.dmg
${retry}
`,
        ],
        {
          env: {
            ...process.env,
            ACTION: scenario.action,
            FAILURE: scenario.failure,
            RECOVER: String(scenario.recover),
            CALLS: join(directory, 'calls'),
          },
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, scenario.status, result.stderr);
      assert.equal(await readFile(join(directory, 'calls'), 'utf8'), scenario.calls);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
