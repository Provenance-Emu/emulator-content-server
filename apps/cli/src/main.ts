#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertListenPolicy } from '@ecs/auth';
import { advertise } from '@ecs/discovery';
import { openServer } from '@ecs/server';
import {
  addLocation,
  addRoot,
  backupData,
  doctor,
  initData,
  limitsFromEnv,
  listLocations,
  listRoots,
  removeLocation,
  removeRoot,
  scanRoots,
  useLocation,
} from './lifecycle.js';
import { captureDaemonLogs } from './log.js';
import {
  installService,
  readBootstrapped,
  removeServicePid,
  type ServiceSpec,
  serviceStatus,
  uninstallService,
  writeServicePid,
} from './service.js';

const DEFAULT_PORT = 8473;

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === '--help' || command === 'help') {
    printHelp();
    return;
  }
  const dataDir = value('--data') ?? './content-data';
  if (command === 'init') {
    await printInit(dataDir, value('--name') ?? 'Emulator Content Server');
    return;
  }
  if (command === 'doctor') {
    const report = await doctor(dataDir);
    for (const line of report.lines) console.log(line);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === 'backup') {
    const destination = value('--to');
    if (!destination) throw new Error('backup requires --to');
    await backupData(dataDir, destination);
    console.log(`backup written to ${destination}`);
    return;
  }
  if (command === 'roots') {
    await roots(dataDir);
    return;
  }
  if (command === 'locations') {
    await locations(dataDir);
    return;
  }
  if (command === 'scan') {
    const results = await scanRoots(dataDir, value('--id') ?? null);
    for (const result of results) {
      const state = result.online ? result.medium : 'offline';
      console.log(`${result.label}  ${state}  ${result.count}`);
    }
    return;
  }
  if (command === 'service') {
    await service(dataDir);
    return;
  }
  if (command === 'serve') {
    await serve(dataDir);
    return;
  }
  throw new Error(`Unknown command ${command}`);
}

async function roots(dataDir: string): Promise<void> {
  const action = process.argv[3];
  if (action === 'list') {
    for (const root of listRoots(dataDir)) {
      console.log(`${root.id}  ${root.label}  ${root.path}`);
    }
    return;
  }
  if (action === 'add') {
    const path = value('--path');
    const label = value('--label');
    if (!path || !label) throw new Error('roots add requires --path and --label');
    const root = await addRoot(dataDir, { path, label, libraryId: value('--library') ?? null });
    console.log(`saved ${root.id} ${root.path}`);
    return;
  }
  if (action === 'remove') {
    const id = value('--id');
    if (!id) throw new Error('roots remove requires --id');
    removeRoot(dataDir, id);
    console.log(`removed ${id}`);
    return;
  }
  throw new Error('roots takes list, add, or remove');
}

async function locations(dataDir: string): Promise<void> {
  const action = process.argv[3];
  if (action === 'list') {
    const listed = listLocations(dataDir);
    if (!listed.writeLocationId) console.log('write primary');
    for (const location of listed.locations) {
      const mark = location.id === listed.writeLocationId ? '  write' : '';
      console.log(`${location.id}  ${location.label}  ${location.path}${mark}`);
    }
    return;
  }
  if (action === 'add') {
    const path = value('--path');
    const label = value('--label');
    if (!path || !label) throw new Error('locations add requires --path and --label');
    const location = await addLocation(dataDir, { path, label });
    console.log(`saved ${location.id} ${location.path}`);
    return;
  }
  if (action === 'use') {
    const id = value('--id');
    if (has('--primary') === Boolean(id)) {
      throw new Error('locations use requires --id or --primary');
    }
    useLocation(dataDir, has('--primary') ? null : (id ?? null));
    console.log(has('--primary') ? 'write primary' : `write ${id}`);
    return;
  }
  if (action === 'remove') {
    const id = value('--id');
    if (!id) throw new Error('locations remove requires --id');
    removeLocation(dataDir, id);
    console.log(`removed ${id}`);
    return;
  }
  throw new Error('locations takes list, add, use, or remove');
}

async function serve(dataDir: string): Promise<void> {
  await serveOnTerminal(dataDir, !process.stdout.isTTY);
}

async function serveOnTerminal(dataDir: string, daemon: boolean): Promise<void> {
  const displayName = value('--name') ?? 'Emulator Content Server';
  const prepared = await printInit(dataDir, displayName, !daemon);
  const logging = daemon ? await captureDaemonLogs(dataDir) : null;
  const listen = listenConfig();
  const uiDir = await webAssets(value('--ui'));
  let server: Awaited<ReturnType<typeof openServer>>;
  try {
    server = await openServer({
      dataDir,
      displayName,
      limits: limitsFromEnv(process.env),
      logger: true,
      uiDir,
      playerDir: playerDirectory(),
      webdavEnabled: listen.webdavEnabled,
      // A public bind sits behind a proxy on loopback, so the socket address
      // cannot decide who is local.
      localTrust: !listen.publicInternet,
    });
  } catch (error) {
    await logging?.close();
    throw error;
  }
  try {
    assertListenPolicy({
      host: listen.host,
      bootstrapped: server.catalog.server().bootstrapped,
      allowUnconfiguredLan: listen.allowLan,
      publicInternet: listen.publicInternet,
      tlsTerminated: listen.tlsTerminated,
    });
    await server.app.listen({ host: listen.host, port: listen.port });
  } catch (error) {
    await server.close();
    await logging?.close();
    throw error;
  }
  if (daemon) await writeServicePid(dataDir);
  let announcement: { stop(): void } | undefined;
  if (has('--advertise')) {
    announcement = advertise({
      displayName: server.catalog.server().displayName,
      port: listen.port,
      serverId: server.catalog.server().serverId,
      tls: has('--tls-terminated') || process.env.ECS_TLS_TERMINATED === '1',
      pairing: !prepared.bootstrapped || server.catalog.hasBootstrapToken(),
    });
  }
  console.log(`listening on http://${listen.host}:${listen.port}`);
  if (uiDir) console.log(`interface at http://${listen.host}:${listen.port}/ui/`);
  const shutdown = async () => {
    announcement?.stop();
    await server.close();
    if (daemon) await removeServicePid(dataDir);
    await logging?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/**
 * Where the built interface lives. The assets ship beside this command, so the
 * usual case needs no flag, and a checkout that has not run the web build
 * simply serves no interface rather than failing to start.
 */
async function webAssets(override: string | undefined): Promise<string | null> {
  if (override === 'none') return null;
  const candidate = override
    ? resolve(override)
    : fileURLToPath(new URL('../../../web/dist', import.meta.url));
  const found = await stat(join(candidate, 'index.html')).catch(() => null);
  if (found?.isFile()) return candidate;
  if (override) throw new Error(`No built interface at ${candidate}`);
  return null;
}

async function printInit(dataDir: string, displayName: string, showToken = true) {
  const prepared = await initData(dataDir, displayName);
  if (prepared.token) {
    if (showToken) console.log(`Bootstrap token: ${prepared.token}`);
    console.log(`Saved to: ${prepared.tokenFile}`);
  } else if (!prepared.bootstrapped) {
    console.log(`Bootstrap is still pending. The token file remains at ${prepared.tokenFile}`);
  }
  return prepared;
}

async function service(dataDir: string): Promise<void> {
  const action = process.argv[3];
  const spec = serviceSpec(dataDir);
  if (action === 'install') {
    await installService(spec);
    console.log(`service installed for ${spec.dataDir}`);
    return;
  }
  if (action === 'uninstall') {
    await uninstallService(spec);
    console.log('service removed');
    return;
  }
  if (action === 'status') {
    const report = await serviceStatus(spec);
    for (const line of report.lines) console.log(line);
    return;
  }
  throw new Error('service takes install, uninstall, or status');
}

function serviceSpec(dataDir: string): ServiceSpec {
  const listen = listenConfig();
  const absolute = resolve(dataDir);
  return {
    platform: process.platform,
    home: homedir(),
    dataDir: absolute,
    playerDir: playerDirectory(),
    executable: process.execPath,
    script: process.argv[1] ?? fileURLToPath(import.meta.url),
    host: listen.host,
    port: listen.port,
    advertise: listen.advertise,
    webdavEnabled: listen.webdavEnabled,
    allowLan: listen.allowLan,
    publicInternet: listen.publicInternet,
    tlsTerminated: listen.tlsTerminated,
    bootstrapped: readBootstrapped(absolute),
    uid: process.getuid?.() ?? 0,
  };
}

function playerDirectory(): string | undefined {
  const selected = value('--player-dir');
  if (has('--player-dir') && (!selected || selected.startsWith('--'))) {
    throw new Error('--player-dir requires an absolute directory path');
  }
  return selected ?? process.env.ECS_PLAYER_DIR;
}

function listenConfig(): {
  host: string;
  port: number;
  advertise: boolean;
  webdavEnabled: boolean;
  allowLan: boolean;
  publicInternet: boolean;
  tlsTerminated: boolean;
} {
  const host = value('--host') ?? '127.0.0.1';
  const port = Number(value('--port') ?? process.env.ECS_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port is invalid');
  return {
    host,
    port,
    advertise: has('--advertise'),
    webdavEnabled: has('--webdav') || process.env.ECS_WEBDAV === '1',
    allowLan: has('--allow-lan') || process.env.ECS_ALLOW_LAN === '1',
    publicInternet: has('--public'),
    tlsTerminated: has('--tls-terminated') || process.env.ECS_TLS_TERMINATED === '1',
  };
}

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function printHelp(): void {
  console.log(`ecs init --data ./content-data
ecs serve --data ./content-data [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--advertise] [--webdav] [--ui <dir>|none] [--player-dir <absolute-path>]
ecs doctor --data ./content-data
ecs backup --data ./content-data --to ./backup
ecs roots list --data ./content-data
ecs roots add --data ./content-data --path /Volumes/Games --label Games [--library <id>]
ecs roots remove --data ./content-data --id <rootId>
ecs locations list --data ./content-data
ecs locations add --data ./content-data --path /mnt/library --label Library
ecs locations use --data ./content-data --id <locationId>
ecs locations use --data ./content-data --primary
ecs locations remove --data ./content-data --id <locationId>
ecs scan --data ./content-data [--id <rootId>]
ecs service install --data ./content-data [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--webdav] [--player-dir <absolute-path>]
ecs service uninstall --data ./content-data
ecs service status --data ./content-data`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Command failed';
  console.error(message);
  process.exitCode = 1;
});
