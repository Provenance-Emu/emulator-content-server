import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldRestart } from './dev-reload.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const withTray = args.includes('--tray');
const serveArgs = args.filter((arg) => arg !== '--tray');

const children = new Set();

function start(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = start(command, commandArgs);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

let server;
let restarting = false;
let pending = false;

function startServer() {
  server = start(process.execPath, ['apps/cli/dist/src/main.js', 'serve', ...serveArgs]);
  server.on('exit', (code) => {
    if (restarting) return;
    console.error(`server exited with ${code ?? 'a signal'}`);
  });
}

function restartServer() {
  if (!server || server.exitCode !== null) {
    startServer();
    return;
  }
  if (restarting) {
    pending = true;
    return;
  }
  restarting = true;
  const current = server;
  const force = setTimeout(() => current.kill('SIGKILL'), 5_000);
  current.once('exit', () => {
    clearTimeout(force);
    restarting = false;
    startServer();
    if (pending) {
      pending = false;
      restartServer();
    }
  });
  current.kill('SIGTERM');
}

let timer;
function schedule(path) {
  const relative = path.replace(/^\//, '');
  if (!shouldRestart(relative)) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`\nreloading after ${relative}`);
    restartServer();
  }, 400);
}

function watchTree(directory) {
  watch(directory, { recursive: true }, (_event, name) => {
    if (!name) return;
    schedule(join(directory, name).slice(root.length));
  });
}

function shutdown() {
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await run('pnpm', ['exec', 'tsc', '-b', '--pretty', 'false']);
start('pnpm', ['exec', 'tsc', '-b', '--watch', '--preserveWatchOutput', '--pretty', 'false']);
start('pnpm', [
  '--filter',
  '@ecs/web',
  'exec',
  'vite',
  'build',
  '--watch',
  '--mode',
  'development',
]);
startServer();
for (const directory of ['packages', 'apps/server', 'apps/cli']) watchTree(join(root, directory));
if (withTray) start('pnpm', ['tray-dev']);
console.log('watching for code changes. the page reloads itself; the server restarts.');
