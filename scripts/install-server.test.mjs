import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const label = 'app.emulator-content-server';
const source = new URL('./install-server.sh', import.meta.url);
const fakeTools = String.raw`#!/bin/bash
set -eu
case "$(basename "$0")" in
  uname) if [[ $1 == -s ]]; then echo Darwin; else echo arm64; fi ;;
  id) if [[ $1 == -u ]]; then echo 501; else echo ecs-test; fi ;;
  curl) echo '{"ok":true}' ;;
  sudo)
    if [[ $1 == -n ]]; then shift; fi
    if [[ $1 == -v ]]; then exit 0; fi
    "$@"
    ;;
  launchctl)
    printf '%s\n' "$*" >> "$FIXTURE/calls"
    case "$1 $2" in
      "print gui/501") exit 0 ;;
      "print gui/501/$LABEL") exit 113 ;;
      "print system/$LABEL")
        [[ -e $FIXTURE/running ]] || exit 113
        printf '\tstate = running\n'
        ;;
      "bootstrap system")
        if [[ $FAIL_BOOT == yes ]]; then exit 5; fi
        touch "$FIXTURE/running"
        ;;
      "bootstrap gui/501"|"enable system/$LABEL"|"bootout system/$LABEL") exit 0 ;;
      *) exit 99 ;;
    esac
    ;;
esac
`;

for (const fail of [false, true]) {
  test(`macOS boot migration ${fail ? 'restores the login registration on failure' : 'keeps the portable launcher and server arguments'}`, {
    skip: process.platform !== 'darwin',
  }, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'ecs-boot-installer-'));
    try {
      const home = join(fixture, 'home');
      const agents = join(home, 'Library', 'LaunchAgents');
      const daemons = join(fixture, 'LaunchDaemons');
      const tools = join(fixture, 'bin');
      const launcher = join(fixture, 'Server Launcher');
      await Promise.all(
        [agents, daemons, tools, join(launcher, 'runtime'), join(launcher, 'server/dist/src')].map(
          (path) => mkdir(path, { recursive: true }),
        ),
      );
      const runtime = join(launcher, 'runtime/node');
      const supervisor = join(launcher, 'server/dist/src/supervise.js');
      await writeFile(runtime, '', { mode: 0o755 });
      await writeFile(supervisor, '');
      const agent = join(agents, `${label}.plist`);
      const daemon = join(daemons, `${label}.plist`);
      const args = [
        runtime,
        supervisor,
        'serve',
        '--data',
        join(home, 'My Library'),
        '--host',
        '0.0.0.0',
        '--port',
        '9876',
        '--advertise',
      ];
      const plist = { Label: label, ProgramArguments: args, RunAtLoad: true, KeepAlive: true };
      await writeFile(agent, JSON.stringify(plist));
      execFileSync('/usr/bin/plutil', ['-convert', 'xml1', agent]);
      const original = await readFile(agent);
      await writeFile(join(tools, 'fixture'), fakeTools, { mode: 0o755 });
      for (const tool of ['curl', 'id', 'launchctl', 'sudo', 'uname'])
        await symlink('fixture', join(tools, tool));
      const installer = join(fixture, 'install.sh');
      const script = (await readFile(source, 'utf8'))
        .replaceAll('/Library/LaunchDaemons/', '$FIXTURE/LaunchDaemons/')
        .replaceAll('/bin/launchctl', '$FIXTURE/bin/launchctl');
      await writeFile(installer, script);
      const env = {
        ...process.env,
        HOME: home,
        FIXTURE: fixture,
        FAIL_BOOT: fail ? 'yes' : 'no',
        LABEL: label,
        PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`,
      };
      const run = (...args) =>
        spawnSync('/bin/bash', [installer, ...args], { env, encoding: 'utf8' });
      const result = run('nightly', 'server', '--boot');
      const calls = await readFile(join(fixture, 'calls'), 'utf8');
      if (fail) {
        assert.notEqual(result.status, 0);
        assert.deepEqual(await readFile(agent), original, result.stderr);
        await assert.rejects(readFile(daemon), { code: 'ENOENT' });
        assert.match(calls, /bootstrap gui\/501/);
      } else {
        assert.equal(result.status, 0, result.stderr);
        const installed = JSON.parse(
          execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', daemon], {
            encoding: 'utf8',
          }),
        );
        assert.deepEqual(installed, {
          ...plist,
          UserName: 'ecs-test',
          WorkingDirectory: home,
          EnvironmentVariables: { HOME: home },
          ProcessType: 'Interactive',
        });
        await assert.rejects(readFile(agent), { code: 'ENOENT' });
        assert.match(calls, /bootstrap system/);
        const again = run('nightly', 'server', '--boot');
        assert.equal(again.status, 0, again.stderr);
        assert.match(again.stdout, /Boot service: running/);
        assert.match(again.stdout, /127\.0\.0\.1:9876/);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
