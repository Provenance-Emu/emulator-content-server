import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { appendRotatingLog } from '../src/log.js';
import {
  type CommandResult,
  type CommandRunner,
  installService,
  LAUNCH_AGENT,
  registrationFile,
  renderRegistration,
  type ServiceSpec,
  SYSTEMD_UNIT,
  serviceStatus,
  TASK_NAME,
  uninstallService,
  writeServicePid,
} from '../src/service.js';

const SECRET = 'super-secret-token';
const PASSWORD = 'hunter2';

function spec(home: string, dataDir: string, platform: NodeJS.Platform): ServiceSpec {
  return {
    platform,
    home,
    dataDir,
    executable: '/usr/bin/node',
    script: '/opt/ecs/main.js',
    host: '127.0.0.1',
    port: 8473,
    advertise: false,
    allowLan: false,
    publicInternet: false,
    tlsTerminated: false,
    bootstrapped: true,
    uid: 501,
  };
}

function recordingRunner(): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = (argv) => {
    calls.push([...argv]);
    return { status: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

test('each platform registration starts at login and carries no credential', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ecs-service-home-'));
  const dataDir = join(home, 'data');
  const previousToken = process.env.ECS_TOKEN;
  const previousPassword = process.env.PASSWORD;
  process.env.ECS_TOKEN = SECRET;
  process.env.PASSWORD = PASSWORD;
  try {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const text = renderRegistration(spec(home, dataDir, platform));
      assert.equal(text.includes(SECRET), false);
      assert.equal(text.includes(PASSWORD), false);
      assert.equal(text.includes('authorization'), false);
      assert.match(text, /--data/);
      assert.match(text, /--port/);
      if (platform === 'darwin') {
        assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
        assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/);
        assert.doesNotMatch(text, /LaunchDaemons/);
      }
      if (platform === 'linux') {
        assert.match(text, /WantedBy=default\.target/);
        assert.doesNotMatch(text, /^User=root$/m);
      }
      if (platform === 'win32') {
        assert.match(text, /<LogonTrigger>/);
        assert.match(text, /<RunLevel>LeastPrivilege<\/RunLevel>/);
        assert.doesNotMatch(text, /HighestAvailable/);
      }
    }
    const raw = join(home, 'a&b');
    const escaped = renderRegistration({
      ...spec(home, raw, 'darwin'),
      dataDir: raw,
    });
    const written = resolve(raw)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
    assert.ok(escaped.includes(`<string>${written}</string>`));
    assert.equal(escaped.includes('a&b'), false);
  } finally {
    if (previousToken === undefined) delete process.env.ECS_TOKEN;
    else process.env.ECS_TOKEN = previousToken;
    if (previousPassword === undefined) delete process.env.PASSWORD;
    else process.env.PASSWORD = previousPassword;
    await rm(home, { recursive: true, force: true });
  }
});

test('installing twice leaves one registration and uninstall removes only that one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ecs-service-home-'));
  const dataDir = join(home, 'data');
  const darwin = spec(home, dataDir, 'darwin');
  const { runner, calls } = recordingRunner();
  const agents = join(home, 'Library', 'LaunchAgents');
  try {
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, 'com.other.agent.plist'), 'leave me\n');
    await installService(darwin, runner);
    await installService(darwin, runner);
    const files = (await readdir(agents)).sort();
    assert.deepEqual(files, [LAUNCH_AGENT, 'com.other.agent.plist']);
    assert.equal(calls.filter((argv) => argv[1] === 'bootstrap').length, 2);
    const installed = await readFile(registrationFile(darwin) ?? '', 'utf8');
    assert.equal(installed.includes(SECRET), false);

    await uninstallService(darwin, runner);
    await uninstallService(darwin, runner);
    assert.deepEqual(await readdir(agents), ['com.other.agent.plist']);

    const linux = spec(home, dataDir, 'linux');
    await installService(linux, runner);
    await installService(linux, runner);
    const unitDir = join(home, '.config', 'systemd', 'user');
    assert.deepEqual(await readdir(unitDir), [SYSTEMD_UNIT]);
    await uninstallService(linux, runner);
    assert.deepEqual(await readdir(unitDir), []);

    const tasks = new Map<string, string>();
    const windows = spec(home, dataDir, 'win32');
    const taskRunner: CommandRunner = (argv) => {
      const name = argv[argv.indexOf('/TN') + 1] ?? '';
      if (argv.includes('/Create')) {
        const xmlPath = argv[argv.indexOf('/XML') + 1] ?? '';
        tasks.set(name, '');
        return { status: 0, stdout: xmlPath, stderr: '' } satisfies CommandResult;
      }
      if (argv.includes('/Delete')) {
        tasks.delete(name);
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'missing' };
    };
    await installService(windows, taskRunner);
    await installService(windows, taskRunner);
    assert.deepEqual([...tasks.keys()], [TASK_NAME]);
    await uninstallService(windows, taskRunner);
    assert.equal(tasks.size, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a public listen without TLS is refused before a registration is written', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ecs-service-home-'));
  const dataDir = join(home, 'data');
  try {
    await assert.rejects(
      () =>
        installService(
          {
            ...spec(home, dataDir, 'darwin'),
            host: '0.0.0.0',
            publicInternet: true,
            tlsTerminated: false,
          },
          () => {
            throw new Error('registration command ran');
          },
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'tls-required',
    );
    await assert.rejects(readdir(join(home, 'Library')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('status reports the registration, the process, and the port', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ecs-service-home-'));
  const dataDir = join(home, 'data');
  const darwin = spec(home, dataDir, 'darwin');
  try {
    const absent = await serviceStatus(darwin, () => ({ status: 1, stdout: '', stderr: '' }));
    assert.deepEqual(absent.lines, ['registration absent', 'process stopped']);
    await installService(darwin, () => ({ status: 0, stdout: '', stderr: '' }));
    await writeServicePid(dataDir, process.pid);
    const running = await serviceStatus(darwin, () => ({ status: 1, stdout: '', stderr: '' }));
    assert.equal(running.loaded, true);
    assert.equal(running.running, true);
    assert.equal(running.port, 8473);
    assert.deepEqual(running.lines, ['registration loaded', 'process running', 'port 8473']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('log rotation keeps a bounded set, leaves the live file, and drops credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-service-log-'));
  try {
    const limits = { limit: 32, keep: 2 };
    await appendRotatingLog(dir, `${'x'.repeat(40)}\n`, limits);
    await appendRotatingLog(dir, `${'y'.repeat(40)}\n`, limits);
    await appendRotatingLog(dir, `${'z'.repeat(40)}\n`, limits);
    await appendRotatingLog(dir, `authorization: Bearer ${SECRET}\npassword=${PASSWORD}\n`, limits);
    const names = await readdir(dir);
    assert.equal(names.includes('ecs.log'), true);
    assert.equal(names.includes('ecs.log.3'), false);
    assert.ok(names.filter((name) => name.startsWith('ecs.log')).length <= 3);
    const live = await readFile(join(dir, 'ecs.log'), 'utf8');
    assert.match(live, /\[redacted\]/);
    for (const name of names) {
      const text = await readFile(join(dir, name), 'utf8');
      assert.equal(text.includes(SECRET), false, name);
      assert.equal(text.includes(PASSWORD), false, name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
