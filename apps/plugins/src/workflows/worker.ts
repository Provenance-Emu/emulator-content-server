import { type ChildProcess, fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type JsonValue, validateWorkflowJson } from '@ecs/plugins/workflows';
import {
  validateWorkerValue,
  type WorkflowWorkerContext,
  type WorkflowWorkerMethod,
} from './worker-protocol.js';

interface WorkerOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  scope?: string;
  context?: WorkflowWorkerContext;
  beforeDispatch?: () => void | Promise<void>;
}
interface Task {
  id: string;
  key: string;
  entry: string;
  method: WorkflowWorkerMethod;
  input: JsonValue;
  context: WorkflowWorkerContext;
  options: WorkerOptions;
  timer: NodeJS.Timeout;
  abort: () => void;
  settled: boolean;
  worker?: Worker;
  resolve(value: JsonValue): void;
  reject(error: Error): void;
}
interface Worker {
  child: ChildProcess;
  key: string;
  ready: boolean;
  retired: boolean;
  current?: Task;
  idle?: NodeJS.Timeout;
  exited: Promise<void>;
}

export class WorkflowWorkerPool {
  private readonly workers = new Set<Worker>();
  private readonly queue: Task[] = [];
  private closing = false;

  async invoke(
    entry: string,
    method: WorkflowWorkerMethod,
    input: JsonValue,
    options: WorkerOptions = {},
  ): Promise<JsonValue> {
    if (this.closing) throw new Error('Workflow worker pool is closed');
    if (!isAbsolute(entry) || !entry.endsWith('.mjs'))
      throw new Error('Workflow entry must be an installed module path');
    validateWorkflowJson(input, undefined, true);
    const context = options.context ?? {};
    validateWorkflowJson(context.connection ?? {}, 64 * 1024, true);
    const credentials = context.credentials ?? {};
    if (
      Object.keys(credentials).length > 8 ||
      Object.entries(credentials).some(
        ([name, value]) =>
          !/^[a-z][a-zA-Z0-9]{0,63}$/.test(name) ||
          typeof value !== 'string' ||
          value.length > 8192,
      )
    )
      throw new Error('Invalid private workflow credential context');
    if (Object.keys(credentials).length && (method === 'advance' || !options.scope))
      throw new Error('Workflow credentials require an isolated translator scope');
    validateWorkflowJson({ input, context });
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000)
      throw new Error('Invalid worker deadline');
    if (options.signal?.aborted) throw new Error('Workflow operation cancelled');
    const key = JSON.stringify([entry, options.scope ?? 'default']);
    if (this.workers.size >= 2 && this.queue.length >= 64)
      throw new Error('Workflow worker queue is full');
    return new Promise((resolve, reject) => {
      const task: Task = {
        id: randomUUID(),
        key,
        entry,
        method,
        input: structuredClone(input),
        context: structuredClone(context),
        options,
        resolve,
        reject,
        settled: false,
        abort: () => this.finish(task, new Error('Workflow operation cancelled')),
        timer: setTimeout(
          () => this.finish(task, new Error('Workflow worker deadline exceeded')),
          timeout,
        ),
      };
      options.signal?.addEventListener('abort', task.abort, { once: true });
      this.queue.push(task);
      this.drain();
    });
  }
  private spawn(entry: string, key: string): Worker {
    const child = fork(fileURLToPath(new URL('./worker-entry.js', import.meta.url)), [entry], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      detached: process.platform !== 'win32',
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), LANG: 'en_US.UTF-8' },
      execArgv: ['--max-old-space-size=192'],
    });
    let stopped: () => void = () => {};
    const worker: Worker = {
      child,
      key,
      ready: false,
      retired: false,
      exited: new Promise((resolve) => {
        stopped = resolve;
      }),
    };
    this.workers.add(worker);
    child.on('message', (raw: unknown) => {
      try {
        const message = validateWorkflowJson(raw, undefined, true) as Record<string, JsonValue>;
        if (message.ready === true && !worker.ready && Object.keys(message).length === 1) {
          worker.ready = true;
          if (worker.current) void this.send(worker.current);
          return;
        }
        const task = worker.current;
        if (
          !task ||
          message.id !== task.id ||
          !worker.ready ||
          Object.keys(message).some((key) => !['id', 'value', 'error'].includes(key))
        )
          throw new Error('Invalid workflow worker response');
        if (message.error === true) {
          this.finish(task, new Error('Workflow worker failed'));
          return;
        }
        this.finish(task, undefined, validateWorkerValue(task.method, message.value));
      } catch {
        if (worker.current)
          this.finish(worker.current, new Error('Invalid workflow worker response'));
        else this.retire(worker);
      }
    });
    child.once('error', () => {
      if (worker.current) this.finish(worker.current, new Error('Workflow worker unavailable'));
      this.retire(worker);
    });
    child.once('close', () => {
      clearTimeout(worker.idle);
      this.workers.delete(worker);
      if (worker.current) this.finish(worker.current, new Error('Workflow worker stopped'));
      stopped();
      this.drain();
    });
    return worker;
  }
  private async send(task: Task): Promise<void> {
    try {
      if (task.settled || !task.worker) return;
      await task.options.beforeDispatch?.();
      if (task.settled || task.options.signal?.aborted) return;
      task.worker.child.send(
        { id: task.id, method: task.method, input: task.input, context: task.context },
        (error) => {
          if (error) this.finish(task, new Error('Workflow worker unavailable'));
        },
      );
    } catch {
      this.finish(task, new Error('Workflow operation could not be dispatched'));
    }
  }
  private drain(): void {
    if (this.closing) return;
    while (this.queue.length) {
      const task = this.queue[0];
      if (!task) return;
      let worker = [...this.workers].find(
        (worker) => !worker.retired && !worker.current && worker.key === task.key,
      );
      if (!worker && this.workers.size < 2) {
        try {
          worker = this.spawn(task.entry, task.key);
        } catch {
          this.finish(task, new Error('Workflow worker unavailable'));
          continue;
        }
      }
      if (!worker) {
        const idle = [...this.workers].find((worker) => !worker.current && !worker.retired);
        if (idle) this.retire(idle);
        return;
      }
      this.queue.shift();
      clearTimeout(worker.idle);
      worker.current = task;
      task.worker = worker;
      worker.child.ref();
      worker.child.channel?.ref();
      if (worker.ready) void this.send(task);
    }
  }
  private finish(task: Task, error?: Error, value?: JsonValue): void {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.timer);
    task.options.signal?.removeEventListener('abort', task.abort);
    const index = this.queue.indexOf(task);
    if (index >= 0) this.queue.splice(index, 1);
    const worker = task.worker;
    if (worker?.current === task) {
      worker.current = undefined;
      if (error || this.closing) this.retire(worker);
      else {
        worker.idle = setTimeout(() => this.retire(worker), 5000);
        worker.idle.unref();
        worker.child.unref();
        worker.child.channel?.unref();
      }
    }
    if (error) task.reject(error);
    else task.resolve(value ?? null);
    this.drain();
  }
  private retire(worker: Worker): void {
    if (worker.retired) return;
    worker.retired = true;
    clearTimeout(worker.idle);
    worker.child.ref();
    worker.child.channel?.ref();
    if (process.platform === 'win32' && worker.child.pid) {
      const killer = spawn('taskkill', ['/PID', String(worker.child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => worker.child.kill('SIGKILL'));
      killer.once('close', (code) => {
        if (code !== 0) worker.child.kill('SIGKILL');
      });
    } else if (worker.child.pid) {
      try {
        process.kill(-worker.child.pid, 'SIGKILL');
      } catch {
        worker.child.kill('SIGKILL');
      }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const task of [...this.queue]) this.finish(task, new Error('Workflow worker pool closed'));
    const workers = [...this.workers];
    for (const worker of workers) {
      if (worker.current) this.finish(worker.current, new Error('Workflow worker pool closed'));
      this.retire(worker);
    }
    await Promise.all(workers.map((worker) => worker.exited));
  }
}
