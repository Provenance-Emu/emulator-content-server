#!/usr/bin/env node
import { stat } from 'node:fs/promises';
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
  useLocation,
} from './lifecycle.js';

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
  const displayName = value('--name') ?? 'Emulator Content Server';
  const prepared = await printInit(dataDir, displayName);
  const host = value('--host') ?? '127.0.0.1';
  const port = Number(value('--port') ?? process.env.ECS_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port is invalid');
  const uiDir = await webAssets(value('--ui'));
  const server = await openServer({
    dataDir,
    displayName,
    limits: limitsFromEnv(process.env),
    logger: true,
    uiDir,
  });
  assertListenPolicy({
    host,
    bootstrapped: server.catalog.server().bootstrapped,
    allowUnconfiguredLan: has('--allow-lan') || process.env.ECS_ALLOW_LAN === '1',
    publicInternet: has('--public'),
    tlsTerminated: has('--tls-terminated') || process.env.ECS_TLS_TERMINATED === '1',
  });
  await server.app.listen({ host, port });
  let announcement: { stop(): void } | undefined;
  if (has('--advertise')) {
    announcement = advertise({
      displayName: server.catalog.server().displayName,
      port,
      serverId: server.catalog.server().serverId,
      tls: has('--tls-terminated') || process.env.ECS_TLS_TERMINATED === '1',
      pairing: !prepared.bootstrapped || server.catalog.hasBootstrapToken(),
    });
  }
  console.log(`listening on http://${host}:${port}`);
  if (uiDir) console.log(`interface at http://${host}:${port}/ui/`);
  const shutdown = async () => {
    announcement?.stop();
    await server.close();
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

async function printInit(dataDir: string, displayName: string) {
  const prepared = await initData(dataDir, displayName);
  if (prepared.token) {
    console.log(`Bootstrap token: ${prepared.token}`);
    console.log(`Saved to: ${prepared.tokenFile}`);
  } else if (!prepared.bootstrapped) {
    console.log(`Bootstrap is still pending. The token file remains at ${prepared.tokenFile}`);
  }
  return prepared;
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
ecs serve --data ./content-data [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--advertise] [--ui <dir>|none]
ecs doctor --data ./content-data
ecs backup --data ./content-data --to ./backup
ecs roots list --data ./content-data
ecs roots add --data ./content-data --path /Volumes/Games --label Games [--library <id>]
ecs roots remove --data ./content-data --id <rootId>
ecs locations list --data ./content-data
ecs locations add --data ./content-data --path /mnt/library --label Library
ecs locations use --data ./content-data --id <locationId>
ecs locations use --data ./content-data --primary
ecs locations remove --data ./content-data --id <locationId>`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Command failed';
  console.error(message);
  process.exitCode = 1;
});
