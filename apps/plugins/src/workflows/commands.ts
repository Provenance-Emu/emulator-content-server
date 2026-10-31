import { installBundledCleanup } from './bundled.js';
import {
  activateWorkflowPackage,
  disableWorkflowPackage,
  installWorkflowPackage,
  listWorkflowPackages,
  readWorkflowBundle,
  resolveWorkflowPackage,
  snapshotWorkflowDirectory,
} from './packages.js';
import { startWorkflowHost } from './transport.js';

export interface WorkflowCommandIo {
  log(line: string): void;
  error(line: string): void;
}

export async function runWorkflowCommand(
  argv: readonly string[],
  io: WorkflowCommandIo,
): Promise<number> {
  if (argv.some((argument) => ['--token', '--api-key', '--password'].includes(argument)))
    throw new Error('Credentials are not accepted as command-line arguments');
  function flag(name: string): string | undefined {
    const index = argv.indexOf(name);
    const value = argv[index + 1];
    return index >= 0 && value && !value.startsWith('--') ? value : undefined;
  }
  function required(name: string): string {
    const value = flag(name);
    if (!value) throw new Error(`Workflow command requires ${name}`);
    return value;
  }
  const state = required('--state');
  switch (argv[3]) {
    case 'install-defaults': {
      const installed = await installBundledCleanup(state);
      io.log(
        `${installed.manifest.id}\t${installed.manifest.version}\t${installed.digest}\tactive`,
      );
      return 0;
    }
    case 'serve': {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        await startWorkflowHost(
          {
            stateDirectory: state,
            server: required('--server'),
            credentialFile: required('--credential-file'),
            log: io.log,
          },
          controller.signal,
        );
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
      return 0;
    }
    case 'install': {
      const directory = flag('--directory');
      if (directory && flag('--bundle')) throw new Error('Choose one workflow package source');
      const bytes = directory
        ? await snapshotWorkflowDirectory(directory)
        : await readWorkflowBundle(required('--bundle'));
      const installed = await installWorkflowPackage(state, bytes);
      io.log(
        `${installed.manifest.id}\t${installed.manifest.version}\t${installed.digest}\tinstalled; activation required`,
      );
      return 0;
    }
    case 'activate':
      await activateWorkflowPackage(state, required('--id'), required('--digest'));
      io.log('Workflow package activated');
      return 0;
    case 'disable':
      await disableWorkflowPackage(state, required('--id'));
      io.log('Workflow package disabled');
      return 0;
    case 'list':
      for (const installed of await listWorkflowPackages(state)) {
        let active = false;
        try {
          active =
            (await resolveWorkflowPackage(state, installed.manifest.id)).digest ===
            installed.digest;
        } catch {
          /* Installed but not active. */
        }
        io.log(
          `${installed.manifest.id}\t${installed.manifest.version}\t${installed.digest}\t${active ? 'active' : 'inactive'}`,
        );
      }
      return 0;
    default:
      throw new Error('Unknown workflow command');
  }
}
