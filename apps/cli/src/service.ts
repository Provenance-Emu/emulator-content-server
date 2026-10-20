import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { assertListenPolicy } from '@ecs/auth';
import { CatalogDatabase } from '@ecs/database';

export const LAUNCH_AGENT = 'app.emulator-content-server.plist';
export const SYSTEMD_UNIT = 'ecs.service';
export const TASK_NAME = 'EmulatorContentServer';

export interface ServiceSpec {
  platform: NodeJS.Platform;
  home: string;
  dataDir: string;
  executable: string;
  script: string;
  host: string;
  port: number;
  advertise: boolean;
  webdavEnabled?: boolean;
  chdmanPath?: string;
  playerDir?: string;
  allowLan: boolean;
  publicInternet: boolean;
  tlsTerminated: boolean;
  bootstrapped: boolean;
  uid: number;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (argv: readonly string[]) => CommandResult;

interface PlannedCommand {
  argv: string[];
  optional: boolean;
}

export function serveArguments(spec: ServiceSpec): string[] {
  const args = [
    spec.executable,
    spec.script,
    'serve',
    '--data',
    resolve(spec.dataDir),
    '--host',
    spec.host,
    '--port',
    String(spec.port),
  ];
  if (spec.advertise) args.push('--advertise');
  if (spec.webdavEnabled) args.push('--webdav');
  if (spec.chdmanPath !== undefined) {
    if (!isAbsolute(spec.chdmanPath))
      throw new Error('CHD decoder requires an absolute executable path');
    args.push('--chdman', spec.chdmanPath);
  }
  if (spec.playerDir !== undefined) {
    if (!isAbsolute(spec.playerDir)) throw new Error('Player directory must be absolute');
    args.push('--player-dir', spec.playerDir);
  }
  if (spec.allowLan) args.push('--allow-lan');
  if (spec.publicInternet) args.push('--public');
  if (spec.tlsTerminated) args.push('--tls-terminated');
  return args;
}

export function registrationFile(spec: ServiceSpec): string | null {
  if (spec.platform === 'darwin') return join(spec.home, 'Library', 'LaunchAgents', LAUNCH_AGENT);
  if (spec.platform === 'linux') return join(spec.home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
  return null;
}

export function renderRegistration(spec: ServiceSpec): string {
  const args = serveArguments(spec);
  if (spec.platform === 'darwin') return renderPlist(args);
  if (spec.platform === 'linux') return renderUnit(args, resolve(spec.dataDir));
  if (spec.platform === 'win32') return renderTask(args);
  throw new Error(`No per-user service for ${spec.platform}`);
}

export function readBootstrapped(dataDir: string): boolean {
  const filename = join(dataDir, 'library.sqlite');
  try {
    statSync(filename);
  } catch {
    return false;
  }
  const catalog = new CatalogDatabase(filename);
  try {
    return catalog.server().bootstrapped;
  } catch {
    return false;
  } finally {
    catalog.close();
  }
}

export async function installService(
  spec: ServiceSpec,
  runner: CommandRunner = defaultRunner,
): Promise<void> {
  assertListenPolicy({
    host: spec.host,
    bootstrapped: spec.bootstrapped,
    allowUnconfiguredLan: spec.allowLan,
    publicInternet: spec.publicInternet,
    tlsTerminated: spec.tlsTerminated,
  });
  const text = renderRegistration(spec);
  const file = registrationFile(spec);
  if (file) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  if (spec.platform === 'win32') {
    const xmlPath = join(tmpdir(), `${TASK_NAME}-${spec.uid}.xml`);
    await writeFile(xmlPath, text);
    try {
      runRequired(runner, ['schtasks', '/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F']);
    } finally {
      await rm(xmlPath, { force: true });
    }
    return;
  }
  for (const command of installCommands(spec, file)) {
    if (command.optional) runner(command.argv);
    else runRequired(runner, command.argv);
  }
}

export async function uninstallService(
  spec: ServiceSpec,
  runner: CommandRunner = defaultRunner,
): Promise<void> {
  const file = registrationFile(spec);
  for (const command of uninstallCommands(spec, file)) runner(command.argv);
  if (file) await rm(file, { force: true });
}

export async function serviceStatus(
  spec: ServiceSpec,
  runner: CommandRunner = defaultRunner,
): Promise<{ loaded: boolean; running: boolean; port: number | null; lines: string[] }> {
  const text = await registrationText(spec, runner);
  const loaded = text !== null;
  const port = text === null ? null : portFromRegistration(text);
  const pid = await readServicePid(spec.dataDir);
  const running = pid !== null && processAlive(pid);
  const lines = [
    loaded ? 'registration loaded' : 'registration absent',
    running ? 'process running' : 'process stopped',
  ];
  if (port !== null) lines.push(`port ${port}`);
  return { loaded, running, port, lines };
}

export function portFromRegistration(text: string): number | null {
  const plist = text.match(/--port<\/string>\s*<string>(\d+)<\/string>/);
  if (plist?.[1]) return Number(plist[1]);
  const plain = text.match(/--port\s+(\d+)/);
  if (plain?.[1]) return Number(plain[1]);
  return null;
}

export async function writeServicePid(dataDir: string, pid = process.pid): Promise<void> {
  const directory = join(dataDir, 'logs');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'ecs.pid'), `${pid}\n`);
}

export async function readServicePid(dataDir: string): Promise<number | null> {
  const text = await readFile(join(dataDir, 'logs', 'ecs.pid'), 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
  if (text === null) return null;
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export async function removeServicePid(dataDir: string): Promise<void> {
  await rm(join(dataDir, 'logs', 'ecs.pid'), { force: true });
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function defaultRunner(argv: readonly string[]): CommandResult {
  const [command, ...args] = argv;
  if (!command) return { status: 1, stdout: '', stderr: 'missing command' };
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function installCommands(spec: ServiceSpec, file: string | null): PlannedCommand[] {
  if (spec.platform === 'darwin' && file) {
    const domain = `gui/${spec.uid}`;
    return [
      { argv: ['launchctl', 'bootout', domain, file], optional: true },
      { argv: ['launchctl', 'bootstrap', domain, file], optional: false },
    ];
  }
  if (spec.platform === 'linux') {
    return [
      { argv: ['systemctl', '--user', 'daemon-reload'], optional: false },
      { argv: ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT], optional: false },
    ];
  }
  return [];
}

function uninstallCommands(spec: ServiceSpec, file: string | null): PlannedCommand[] {
  if (spec.platform === 'darwin' && file) {
    return [{ argv: ['launchctl', 'bootout', `gui/${spec.uid}`, file], optional: true }];
  }
  if (spec.platform === 'linux') {
    return [
      { argv: ['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT], optional: true },
      { argv: ['systemctl', '--user', 'daemon-reload'], optional: true },
    ];
  }
  if (spec.platform === 'win32') {
    return [{ argv: ['schtasks', '/Delete', '/TN', TASK_NAME, '/F'], optional: true }];
  }
  return [];
}

async function registrationText(spec: ServiceSpec, runner: CommandRunner): Promise<string | null> {
  if (spec.platform === 'win32') {
    const result = runner(['schtasks', '/Query', '/TN', TASK_NAME, '/XML']);
    return result.status === 0 ? result.stdout : null;
  }
  const file = registrationFile(spec);
  if (!file) return null;
  return readFile(file, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
}

function runRequired(runner: CommandRunner, argv: readonly string[]): void {
  const result = runner(argv);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${argv.join(' ')} failed`);
  }
}

function renderPlist(args: readonly string[]): string {
  const items = args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>app.emulator-content-server</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProgramArguments</key>
  <array>
${items}
  </array>
</dict>
</plist>
`;
}

function renderUnit(args: readonly string[], dataDir: string): string {
  return `[Unit]
Description=Emulator Content Server
After=network.target

[Service]
Type=simple
ExecStart=${args.map(quoteArg).join(' ')}
WorkingDirectory=${quoteArg(dataDir)}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

function renderTask(args: readonly string[]): string {
  const command = args[0] ?? '';
  const rest = args.slice(1).map(quoteArg).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Emulator Content Server</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions>
    <Exec>
      <Command>${xml(command)}</Command>
      <Arguments>${xml(rest)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
