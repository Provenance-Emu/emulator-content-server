import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lockUpdateFile,
  prepareUpdateDirectory,
  readUpdateState,
  runtime,
  updateDirectory,
} from './update-files.js';
import { exitStatus, supervise } from './update-supervisor.js';

const bootstrap = fileURLToPath(new URL('../../../', import.meta.url));
const cli = (root: string) => join(root, 'server', 'dist', 'src', 'main.js');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dataFlag = args.indexOf('--data');
  const dataDir = resolve((dataFlag === -1 ? undefined : args[dataFlag + 1]) ?? './content-data');
  if (args[0] !== 'serve' || args.includes('--help') || args.includes('-h')) {
    const help = !args[0] || args[0] === 'help' || args.includes('--help') || args.includes('-h');
    const directory = help ? updateDirectory(dataDir) : await prepareUpdateDirectory(dataDir);
    const commandLock = help ? undefined : lockUpdateFile(directory, 'commands', false, 3000);
    try {
      const { active, pending } = help ? {} : await readUpdateState(directory);
      if (pending) throw new Error('Start the server to recover its interrupted update first');
      const root = active ? join(directory, 'builds', active) : bootstrap;
      const command = spawn(runtime(root), [cli(root), ...args], {
        stdio: 'inherit',
        env: { ...process.env, ECS_SERVER_BOOTSTRAP: bootstrap },
      });
      const result = await exitStatus(command);
      process.exitCode = result ?? 1;
    } finally {
      commandLock?.close();
    }
    return;
  }
  await supervise(dataDir, args, bootstrap);
}

await main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
