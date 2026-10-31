import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { ContentClient } from '@ecs/client';
import {
  type JsonValue,
  validateSchemaValue,
  validateWorkflowPlan,
  type WorkflowPlan,
  type WorkflowStep,
} from '@ecs/plugins/workflows';
import type { WorkflowRun } from '@ecs/protocol';
import { createCatalogTool } from './cleanup/catalog-tool.js';
import { activeWorkflowPackages, resolveWorkflowPackage } from './packages.js';
import {
  type ResolvedWorkflowBinding,
  runWorkflowLease,
  WorkflowRecoveryRequired,
} from './runtime.js';
import { openWorkflowState } from './state.js';
import { WorkflowWorkerPool } from './worker.js';

export async function readWorkflowCredential(path: string): Promise<string> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 8192 ||
    (process.platform !== 'win32' &&
      ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))
  )
    throw new Error('Workflow credential requires a private regular file');
  const file = await open(path, 'r');
  try {
    const actual = await file.stat();
    if (actual.ino !== info.ino || actual.dev !== info.dev)
      throw new Error('Workflow credential changed while opening');
    const value = (await file.readFile('utf8')).trim();
    if (!value || value.length > 8192 || /\s/.test(value))
      throw new Error('Invalid workflow credential file');
    return value;
  } finally {
    await file.close();
  }
}

async function hostLock(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, 'host-lock.sqlite');
  try {
    const file = await open(path, 'wx', 0o600);
    await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
  )
    throw new Error('Invalid private workflow host lock');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
  } catch {
    db.close();
    throw new Error('Workflow host is already running');
  }
  // The kernel releases this separate database lock even after an unclean host exit.
  return async () => {
    db.exec('ROLLBACK');
    db.close();
  };
}

export interface WorkflowHostOptions {
  stateDirectory: string;
  server: string;
  credentialFile?: string;
  client?: ContentClient;
  resolveBinding?: (
    run: WorkflowRun,
    step: WorkflowStep,
    pool: WorkflowWorkerPool,
  ) => Promise<ResolvedWorkflowBinding>;
  publishPlan?: (run: WorkflowRun, sourceId: string, plan: WorkflowPlan) => Promise<void>;
  pause?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
}

export async function startWorkflowHost(
  options: WorkflowHostOptions,
  signal: AbortSignal,
): Promise<void> {
  const url = new URL(options.server);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.pathname !== '/'
  )
    throw new Error('Invalid workflow server URL');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local)
    throw new Error('Workflow server URL requires HTTPS outside loopback');
  const client =
    options.client ??
    new ContentClient(url.origin, await readWorkflowCredential(options.credentialFile ?? ''));
  const state = await openWorkflowState(options.stateDirectory);
  let unlock: (() => Promise<void>) | undefined;
  const pool = new WorkflowWorkerPool();
  const tasks = new Set<Promise<void>>();
  const pause =
    options.pause ??
    (async (ms: number, s: AbortSignal) => {
      await delay(ms, undefined, { signal: s });
    });
  try {
    unlock = await hostLock(options.stateDirectory);
    // Reconcile final receipts even when the server already completed the run and will not claim it again.
    for (const lease of state.savedLeases()) {
      if (signal.aborted) break;
      for (const publication of state.pendingPublications(lease.runId)) {
        try {
          await client.publishWorkflowRun(lease, publication);
          state.acknowledgePublication(lease.runId, publication.sequence);
        } catch {
          break;
        }
      }
    }
    let failures = 0,
      advertisedAt = 0;
    while (!signal.aborted) {
      if (Date.now() - advertisedAt > 15_000) {
        try {
          await client.advertiseWorkflowHost(await activeWorkflowPackages(options.stateDirectory));
          advertisedAt = Date.now();
        } catch {
          /* Polling also reports unavailable or revoked credentials with bounded backoff. */
        }
      }
      if (tasks.size >= 2) {
        await Promise.race(tasks);
        continue;
      }
      try {
        const claim = await client.claimWorkflowRun(1000);
        failures = 0;
        if (!claim.lease || !claim.run) {
          await pause(250, signal);
          continue;
        }
        const lease = claim.lease,
          run = claim.run;
        let task: Promise<void>;
        task = (async () => {
          try {
            await runWorkflowLease(
              lease,
              {
                state,
                run,
                async assertWorkflowAvailable() {
                  const installed = await resolveWorkflowPackage(
                    options.stateDirectory,
                    run.workflowId,
                    run.workflowDigest,
                  );
                  if (installed.manifest.kind !== 'workflow')
                    throw new Error('Selected package is not a workflow');
                  const renewed = await client.heartbeatWorkflowRun(lease);
                  state.saveLease(renewed.lease);
                },
                async advance(snapshot, s) {
                  const installed = await resolveWorkflowPackage(
                    options.stateDirectory,
                    run.workflowId,
                    run.workflowDigest,
                  );
                  const inputSchema = installed.manifest.inputSchema
                    ? installed.schemas[installed.manifest.inputSchema]
                    : undefined;
                  if (inputSchema === undefined)
                    throw new Error('Workflow input schema is missing');
                  validateSchemaValue(inputSchema, snapshot.input);
                  const plan = validateWorkflowPlan(
                    await pool.invoke(
                      join(installed.directory, installed.manifest.entry),
                      'advance',
                      snapshot as unknown as JsonValue,
                      { signal: s, scope: `workflow:${run.id}` },
                    ),
                  );
                  const outputSchema = installed.manifest.outputSchema
                    ? installed.schemas[installed.manifest.outputSchema]
                    : undefined;
                  if (
                    plan.state === 'completed' &&
                    plan.output !== undefined &&
                    outputSchema !== undefined
                  )
                    validateSchemaValue(outputSchema, plan.output);
                  return plan;
                },
                async resolveBinding(step) {
                  const installed = await resolveWorkflowPackage(
                    options.stateDirectory,
                    run.workflowId,
                    run.workflowDigest,
                  );
                  const declared = installed.manifest.bindings?.[step.binding];
                  if (
                    !declared ||
                    declared.capability !== step.capability ||
                    declared.major !== step.major
                  )
                    throw new Error('Workflow requested an undeclared binding');
                  if (
                    step.binding === 'catalog' &&
                    step.capability === 'catalog.search' &&
                    step.major === 1
                  ) {
                    if (!installed.manifest.effects?.includes('library.read'))
                      throw new Error('Workflow has no library inspection grant');
                    return createCatalogTool(run.id, client);
                  }
                  if (!options.resolveBinding)
                    throw new Error('Workflow binding is not configured');
                  return options.resolveBinding(run, step, pool);
                },
                work: (cursor) => client.workflowWork(run.id, cursor),
                async publish(current, publication) {
                  await client.publishWorkflowRun(current, publication);
                },
                async heartbeat(current) {
                  const next = await client.heartbeatWorkflowRun(current);
                  state.saveLease(next.lease);
                  return next.lease;
                },
                async publishPlan(sourceId, plan) {
                  const installed = await resolveWorkflowPackage(
                    options.stateDirectory,
                    run.workflowId,
                    run.workflowDigest,
                  );
                  if (
                    (plan.observations?.length || plan.proposals?.length) &&
                    !installed.manifest.effects?.includes('proposal.create')
                  )
                    throw new Error('Workflow has no suggestion grant');
                  if (options.publishPlan) {
                    await options.publishPlan(run, sourceId, plan);
                    return;
                  }
                  if (plan.observations?.length || plan.proposals?.length)
                    await client.submitWorkflowSuggestions(
                      run.id,
                      sourceId,
                      plan.observations ?? [],
                      plan.proposals ?? [],
                    );
                },
                pause,
              },
              signal,
            );
          } catch (error) {
            try {
              await client.interruptWorkflowRun(lease, error instanceof WorkflowRecoveryRequired);
            } catch {
              /* Revocation, cancellation or a fenced lease already stopped this run. */
            }
            options.log?.(
              error instanceof WorkflowRecoveryRequired
                ? 'Workflow recovery required'
                : 'Workflow interrupted',
            );
          }
        })().finally(() => {
          tasks.delete(task);
        });
        tasks.add(task);
      } catch {
        if (signal.aborted) break;
        try {
          await pause(Math.min(250 * 2 ** Math.min(failures++, 7), 30_000), signal);
        } catch {
          if (!signal.aborted) throw new Error('Workflow polling failed');
        }
      }
    }
  } finally {
    await Promise.all(tasks);
    await pool.close();
    await unlock?.();
    state.close();
  }
}
