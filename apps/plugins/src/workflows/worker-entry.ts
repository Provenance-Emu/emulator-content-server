import { pathToFileURL } from 'node:url';
import { type JsonValue, validateWorkflowJson } from '@ecs/plugins/workflows';
import {
  validateWorkerValue,
  type WorkflowWorkerContext,
  type WorkflowWorkerMethod,
} from './worker-protocol.js';

const entry = process.argv[2];
if (!entry || !process.send) throw new Error('Workflow worker requires a private IPC channel');
let modulePromise: Promise<Record<string, (...args: unknown[]) => unknown>> | null = null;
let busy = false;
process.on('message', async (raw: unknown) => {
  const message = raw as {
    id?: unknown;
    method?: unknown;
    input?: unknown;
    context?: WorkflowWorkerContext;
  } | null;
  if (busy || !message || typeof message.id !== 'string') return;
  const id = message.id;
  busy = true;
  try {
    const method = message.method as WorkflowWorkerMethod;
    if (!['advance', 'describe', 'start', 'poll', 'cancel'].includes(method))
      throw new Error('Unknown worker operation');
    const input = validateWorkflowJson(message.input, undefined, true);
    modulePromise ??= import(pathToFileURL(entry).href).then((module) => module.default ?? module);
    const plugin = await modulePromise;
    const execute = plugin[method];
    if (typeof execute !== 'function') throw new Error('Plugin operation is unavailable');
    const privateContext = message.context ?? {};
    const credentials = privateContext.credentials ?? {};
    const context = {
      signal: new AbortController().signal,
      connection: privateContext.connection ?? { endpoint: '', configuration: {} },
      credential: (name: string) =>
        Object.hasOwn(credentials, name) ? credentials[name] : undefined,
    };
    let value: unknown;
    if (method === 'advance') value = await execute.call(plugin, input);
    else if (method === 'describe') value = await execute.call(plugin, context);
    else if (method === 'start') value = await execute.call(plugin, input, context);
    else {
      const { request, handle } = input as { request: JsonValue; handle: JsonValue };
      value = await execute.call(plugin, request, handle, context);
      if (method === 'cancel') value = null;
    }
    const response = { id, value: validateWorkerValue(method, value) };
    validateWorkflowJson(response, undefined, true);
    process.send?.(response);
  } catch {
    // Installed code can throw secrets or paths; only a fixed failure crosses IPC.
    process.send?.({ id, error: true });
  } finally {
    busy = false;
  }
});
process.send({ ready: true });
