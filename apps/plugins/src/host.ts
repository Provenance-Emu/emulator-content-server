import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { ContentClient } from '@ecs/client';
import {
  type CloudFetch,
  diagnose,
  HTTP_SCHEMES,
  type LoadedPlugin,
  loadPluginDirectory,
  MOUNT_SCHEMES,
  openConnector,
  PluginError,
  planJit,
  pluginFile,
  readSecrets,
  renderAltStoreSource,
} from '@ecs/plugins';
import type { MatchingInput } from '@ecs/plugins/matching';
import { matchingJob } from '@ecs/plugins/matching-host';
import { publishedFeeds, serveFeeds } from './publish.js';
import { reviewSignerFiles } from './sign.js';
import { syncItem } from './sync.js';
import { runWorkflowCommand } from './workflows/commands.js';

export interface HostIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export function resolveToken(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  if (argv.includes('--token')) {
    throw new PluginError('token-on-command-line', 'Pass the bearer token in ECS_TOKEN');
  }
  const token = env.ECS_TOKEN;
  if (!token) throw new PluginError('missing-token', 'Set ECS_TOKEN');
  return token;
}

export function toolOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const directories = (env.PATH ?? '').split(delimiter).filter((dir) => dir.length > 0);
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      try {
        accessSync(join(directory, `${name}${extension}`), constants.X_OK);
        return true;
      } catch {
        // The next directory may have it.
      }
    }
  }
  return false;
}

export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: HostIo,
): Promise<number> {
  try {
    const command = argv[2];
    if (!command || command === 'help' || command === '--help') {
      for (const line of HELP) io.log(line);
      return 0;
    }
    const directory = flag(argv, '--plugins') ?? env.ECS_PLUGINS ?? './plugins';
    if (command === 'workflows') return await runWorkflowCommand(argv, io);
    if (command === 'providers') {
      const reply = await matchingJob({ operation: 'list', directory });
      for (const plugin of reply.plugins)
        io.log(
          `${plugin.kind}\t${plugin.id}\t${plugin.capabilities.join(',')}\t${plugin.network ? 'online' : 'local'}`,
        );
      return 0;
    }
    if (command === 'match') {
      const path = flag(argv, '--input');
      if (!path) throw new PluginError('invalid-manifest', 'match requires --input <JSON file>');
      const handle = await open(path, 'r');
      let input: MatchingInput;
      try {
        if ((await handle.stat()).size > 256 * 1024) throw new Error('Matching input too large');
        input = JSON.parse(await handle.readFile('utf8'));
      } finally {
        await handle.close();
      }
      input.online = argv.includes('--online');
      const managerId = flag(argv, '--manager');
      const reply = await matchingJob({
        operation: 'match',
        directory,
        input,
        ...(managerId ? { managerId } : {}),
      });
      io.log(JSON.stringify(reply));
      return 0;
    }
    if (command === 'list') return await list(directory, io);
    if (command === 'doctor') return await doctor(directory, env, io);
    if (command === 'feed') return await feed(directory, flag(argv, '--out'), io);
    if (command === 'sync') return await sync(argv, env, directory, io);
    if (command === 'serve') return await serve(argv, directory, io);
    if (command === 'sign-plan') return await signPlan(argv, directory, io);
    if (command === 'jit-plan') return await jitPlan(argv, directory, io);
    throw new PluginError('unknown-command', `Unknown command ${command}`);
  } catch (error) {
    io.error(error instanceof Error ? error.message : 'plugin host failed');
    return 1;
  }
}

async function list(directory: string, io: HostIo): Promise<number> {
  const loaded = await loadPluginDirectory(directory);
  for (const plugin of loaded.plugins) {
    const apps = plugin.manifest.apps.length > 0 ? plugin.manifest.apps.join(',') : '-';
    io.log(`${plugin.manifest.kind}\t${plugin.manifest.id}\t${apps}`);
  }
  for (const problem of loaded.problems) io.error(`${problem.directory}: ${problem.message}`);
  return loaded.problems.length > 0 ? 1 : 0;
}

async function doctor(directory: string, env: NodeJS.ProcessEnv, io: HostIo): Promise<number> {
  const loaded = await loadPluginDirectory(directory);
  let ready = loaded.problems.length === 0;
  for (const problem of loaded.problems) io.error(`${problem.directory}: ${problem.message}`);
  for (const plugin of loaded.plugins) {
    const report = diagnose(plugin.manifest, {
      secrets: await secretsIfAny(plugin),
      rootExists: rootExists(plugin),
      moduleExists: moduleExists(plugin),
      certificateExists: namedFileExists(plugin, plugin.manifest.signer?.certificate),
      profileExists: namedFileExists(plugin, plugin.manifest.signer?.profile),
      toolExists: (name) => toolOnPath(name, env),
    });
    io.log(`${report.ready ? 'ready' : 'attention'}\t${report.id}`);
    for (const line of report.lines) io.log(`  ${line}`);
    if (!report.ready) ready = false;
  }
  return ready ? 0 : 1;
}

async function feed(directory: string, out: string | undefined, io: HostIo): Promise<number> {
  if (!out) throw new PluginError('invalid-manifest', 'feed requires --out');
  const loaded = await loadPluginDirectory(directory);
  await mkdir(out, { recursive: true });
  let count = 0;
  for (const plugin of loaded.plugins) {
    if (plugin.manifest.kind !== 'feed' || !plugin.manifest.feed) continue;
    const source = renderAltStoreSource(plugin.manifest.name, plugin.manifest.feed);
    const path = join(out, `${plugin.manifest.id}.json`);
    await writeFile(path, `${JSON.stringify(source, null, 2)}\n`);
    io.log(path);
    count += 1;
  }
  for (const problem of loaded.problems) io.error(`${problem.directory}: ${problem.message}`);
  if (count === 0) throw new PluginError('invalid-manifest', 'No feed plugins were found');
  return loaded.problems.length > 0 ? 1 : 0;
}

async function sync(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  directory: string,
  io: HostIo,
): Promise<number> {
  const id = flag(argv, '--id');
  const libraryId = flag(argv, '--library');
  const itemId = flag(argv, '--item');
  if (!id || !libraryId || !itemId) {
    throw new PluginError('invalid-manifest', 'sync requires --id, --library, and --item');
  }
  const token = resolveToken(argv, env);
  const plugin = await findPlugin(directory, id);
  const connector = plugin.manifest.connector;
  if (!connector) throw new PluginError('invalid-manifest', `${id} is not a connector`);
  const secrets = HTTP_SCHEMES.has(connector.scheme)
    ? await readSecrets(pluginFile(plugin.directory, 'secrets.json'))
    : undefined;
  const opened = await openConnector(plugin, {
    ...(secrets ? { secrets } : {}),
    fetch: cloudFetch,
  });
  const client = new ContentClient(env.ECS_SERVER ?? 'http://127.0.0.1:8473', token);
  const direction =
    connector.scheme === 'custom' || MOUNT_SCHEMES.has(connector.scheme) ? 'both' : 'push';
  const report = await syncItem({
    client,
    connector: opened,
    libraryId,
    itemId,
    kinds: connector.kinds,
    direction,
  });
  io.log(
    `uploaded ${report.uploaded.length}, downloaded ${report.downloaded.length}, skipped ${report.skipped.length}, refused ${report.refused.length}`,
  );
  for (const refused of report.refused) io.log(`refused ${refused.relativePath} ${refused.reason}`);
  return report.refused.length > 0 ? 1 : 0;
}

async function serve(argv: readonly string[], directory: string, io: HostIo): Promise<number> {
  const loaded = await loadPluginDirectory(directory);
  for (const problem of loaded.problems) io.error(`${problem.directory}: ${problem.message}`);
  const feeds = publishedFeeds(loaded.plugins);
  if (feeds.length === 0) throw new PluginError('invalid-manifest', 'No feed plugins were found');
  const port = tcpPort(flag(argv, '--port'));
  const host = flag(argv, '--host');
  const server = await serveFeeds(feeds, {
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    allowLan: argv.includes('--allow-lan'),
  });
  io.log(server.url);
  for (const feed of feeds) io.log(`${feed.id}  ${server.url}/${feed.id}.json`);
  return new Promise<number>(() => undefined);
}

function tcpPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) throw new PluginError('listen', '--port must be a TCP port');
  const port = Number(value);
  if (port > 65535) throw new PluginError('listen', '--port must be a TCP port');
  return port;
}

async function signPlan(argv: readonly string[], directory: string, io: HostIo): Promise<number> {
  if (argv.includes('--password') || argv.includes('-p')) {
    throw new PluginError(
      'secret-on-command-line',
      'A certificate password is not accepted on the command line',
    );
  }
  const id = flag(argv, '--id');
  const ipa = flag(argv, '--ipa');
  const profile = flag(argv, '--profile');
  const device = flag(argv, '--device');
  if (!id || !ipa || !profile || !device) {
    throw new PluginError(
      'invalid-manifest',
      'sign-plan requires --id, --ipa, --profile, and --device',
    );
  }
  const plugin = await findPlugin(directory, id);
  const signer = plugin.manifest.signer;
  if (!signer) throw new PluginError('invalid-manifest', `${id} is not a signer`);
  const output = flag(argv, '--out') ?? `${ipa.replace(/\.ipa$/i, '')}.signed.ipa`;
  const reviewed = await reviewSignerFiles({
    apps: plugin.manifest.apps,
    ipaPath: ipa,
    profilePath: profile,
    deviceUdid: device,
    output,
    certificate: pluginFile(plugin.directory, signer.certificate),
  });
  if (!reviewed.ok) {
    io.error(`${reviewed.refusal}: ${reviewed.detail}`);
    return 1;
  }
  for (const step of reviewed.plan.steps) io.log(step.join(' '));
  io.log('not run');
  return 0;
}

async function jitPlan(argv: readonly string[], directory: string, io: HostIo): Promise<number> {
  const id = flag(argv, '--id');
  const bundle = flag(argv, '--bundle');
  if (!id || !bundle)
    throw new PluginError('invalid-manifest', 'jit-plan requires --id and --bundle');
  const plugin = await findPlugin(directory, id);
  const plan = planJit({ apps: plugin.manifest.apps, bundleId: bundle });
  for (const step of plan.steps) io.log(step.join(' '));
  io.log('not run');
  return 0;
}

async function findPlugin(directory: string, id: string): Promise<LoadedPlugin> {
  const loaded = await loadPluginDirectory(directory);
  const plugin = loaded.plugins.find((item) => item.manifest.id === id);
  if (!plugin) throw new PluginError('invalid-manifest', `No plugin ${id}`);
  return plugin;
}

async function secretsIfAny(
  plugin: LoadedPlugin,
): Promise<Awaited<ReturnType<typeof readSecrets>> | null> {
  const connector = plugin.manifest.connector;
  if (!connector || !HTTP_SCHEMES.has(connector.scheme)) return null;
  try {
    return await readSecrets(pluginFile(plugin.directory, 'secrets.json'));
  } catch (error) {
    if (error instanceof PluginError && error.code === 'secret-permissions') throw error;
    return null;
  }
}

function rootExists(plugin: LoadedPlugin): boolean {
  const root = plugin.manifest.connector?.root;
  if (!root) return false;
  try {
    return statSync(root).isDirectory();
  } catch {
    return false;
  }
}

function moduleExists(plugin: LoadedPlugin): boolean {
  const relative = plugin.manifest.player?.module ?? plugin.manifest.entry;
  if (!relative) return false;
  try {
    return statSync(pluginFile(plugin.directory, relative)).isFile();
  } catch {
    return false;
  }
}

function namedFileExists(plugin: LoadedPlugin, relative: string | undefined): boolean {
  if (!relative) return false;
  try {
    return statSync(pluginFile(plugin.directory, relative)).isFile();
  } catch {
    return false;
  }
}

const cloudFetch: CloudFetch = async (url, init) => {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
};

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

const HELP = [
  'ecs-plugins workflows install --state <private dir> (--bundle <file> | --directory <dir>)',
  'ecs-plugins workflows activate --state <private dir> --id <plugin> --digest <sha256>',
  'ecs-plugins workflows disable --state <private dir> --id <plugin>',
  'ecs-plugins workflows list --state <private dir>',
  'ecs-plugins workflows install-defaults --state <private dir>',
  'ecs-plugins workflows serve --state <private dir> --server <url> --credential-file <private file>',
  'ecs-plugins list --plugins <dir>',
  'ecs-plugins providers --plugins <dir>',
  'ecs-plugins match --plugins <dir> --input <JSON file> [--online] [--manager <id>]',
  'ecs-plugins doctor --plugins <dir>',
  'ecs-plugins feed --plugins <dir> --out <dir>',
  'ecs-plugins serve --plugins <dir> [--port 8480] [--allow-lan]',
  'ecs-plugins sync --plugins <dir> --id <plugin> --library <id> --item <id>',
  'ecs-plugins sign-plan --plugins <dir> --id <plugin> --ipa <file> --profile <file> --device <udid>',
  'ecs-plugins jit-plan --plugins <dir> --id <plugin> --bundle <bundle id>',
  'The bearer token is read from ECS_TOKEN. The content server stays on ECS_SERVER.',
];
