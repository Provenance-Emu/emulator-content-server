import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import {
  type JsonValue,
  type OperationRequest,
  type OperationResult,
  validateOperationResult,
  validateWorkflowPlan,
  type WorkflowPlan,
  type WorkflowSnapshot,
  type WorkflowStep,
} from '@ecs/plugins/workflows';
import type {
  WorkflowLease,
  WorkflowPage,
  WorkflowPublication,
  WorkflowRun,
  WorkflowSourceSnapshot,
} from '@ecs/protocol';
import type { WorkflowStateStore } from './state.js';

export class WorkflowRecoveryRequired extends Error {
  constructor() {
    super('Workflow recovery required: reconcile private operation state before resuming');
  }
}

/** A selected translator or tool. Credentials and native handles remain inside this boundary. */
export interface ResolvedWorkflowBinding {
  id: string;
  invoke(
    method: 'start' | 'poll',
    request: OperationRequest,
    handle: JsonValue | undefined,
    beforeDispatch: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<OperationResult>;
  cancel?(request: OperationRequest, handle: JsonValue): Promise<void>;
}
export interface WorkflowRuntimeDependencies {
  state: WorkflowStateStore;
  run: WorkflowRun;
  assertWorkflowAvailable(): Promise<void>;
  advance(snapshot: WorkflowSnapshot, signal: AbortSignal): Promise<WorkflowPlan>;
  resolveBinding(step: WorkflowStep): Promise<ResolvedWorkflowBinding>;
  work(cursor?: string): Promise<WorkflowPage<WorkflowSourceSnapshot>>;
  publish(lease: WorkflowLease, publication: WorkflowPublication): Promise<void>;
  heartbeat(lease: WorkflowLease): Promise<WorkflowLease>;
  /** Must be idempotent for this run/source/plan; invoked again after a lost acknowledgement. */
  publishPlan(sourceId: string, plan: WorkflowPlan): Promise<void>;
  pause?(milliseconds: number, signal: AbortSignal): Promise<void>;
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Workflow cancelled');
}

export async function invokeWorkflowOperation(
  request: OperationRequest,
  binding: ResolvedWorkflowBinding,
  context: {
    state: WorkflowStateStore;
    signal: AbortSignal;
    beforeDispatch: () => Promise<void>;
    checkpoint: JsonValue;
    pause: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<OperationResult> {
  let operation = context.state.getOperation(request.operationId);
  if (!operation) throw new Error('Workflow operation was not prepared');
  if (operation.result) return operation.result;
  if (operation.state === 'submitting') {
    context.state.markUncertain(request.operationId);
    throw new WorkflowRecoveryRequired();
  }
  if (operation.state === 'uncertain') throw new WorkflowRecoveryRequired();
  const guard = async () => {
    cancelled(context.signal);
    await context.beforeDispatch();
    cancelled(context.signal);
  };
  try {
    if (operation.state === 'prepared') {
      let submitted = false;
      let result: OperationResult;
      try {
        result = validateOperationResult(
          await binding.invoke(
            'start',
            request,
            undefined,
            async () => {
              await guard();
              context.state.markSubmitting(request.operationId);
              submitted = true;
            },
            context.signal,
          ),
        );
        if (!submitted) throw new Error('Workflow binding omitted its dispatch guard');
      } catch (error) {
        if (submitted) {
          context.state.markUncertain(request.operationId);
          throw new WorkflowRecoveryRequired();
        }
        throw error;
      }
      if (result.state !== 'pending') {
        if (result.state === 'failed' && result.error.code === 'uncertain-submission') {
          context.state.markUncertain(request.operationId);
          throw new WorkflowRecoveryRequired();
        }
        context.state.commitStep(request.operationId, result, context.checkpoint);
        return result;
      }
      context.state.saveAcceptedHandle(request.operationId, result.resumeHandle);
      await context.pause(result.pollAfterMs, context.signal);
    }
    for (;;) {
      cancelled(context.signal);
      operation = context.state.getOperation(request.operationId);
      if (operation?.state !== 'pending' || operation.handle === undefined)
        throw new WorkflowRecoveryRequired();
      if (Date.now() >= Date.parse(request.deadline))
        throw new Error('Workflow backend polling deadline exceeded');
      const result = validateOperationResult(
        await binding.invoke('poll', request, operation.handle, guard, context.signal),
      );
      if (result.state !== 'pending') {
        context.state.commitStep(request.operationId, result, context.checkpoint);
        return result;
      }
      context.state.saveAcceptedHandle(request.operationId, result.resumeHandle);
      await context.pause(result.pollAfterMs, context.signal);
    }
  } catch (error) {
    const pending = context.state.getOperation(request.operationId);
    if (
      context.signal.aborted &&
      pending?.state === 'pending' &&
      pending.handle !== undefined &&
      binding.cancel
    ) {
      try {
        await binding.cancel(request, pending.handle);
      } catch {
        /* The handle remains durable for reconciliation. */
      }
    }
    throw error;
  }
}

export async function runWorkflowLease(
  initialLease: WorkflowLease,
  dependencies: WorkflowRuntimeDependencies,
  parentSignal: AbortSignal,
): Promise<void> {
  const { state, run } = dependencies;
  if (initialLease.runId !== run.id || initialLease.hostId !== run.hostId)
    throw new Error('Workflow lease assignment mismatch');
  if (!state.hasRun(run.id)) {
    if (initialLease.fence !== 1) throw new WorkflowRecoveryRequired();
    state.initializeRun(run.id);
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  let lease = initialLease,
    heartbeat: Promise<void> | undefined,
    heartbeatError: unknown;
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = dependencies
      .heartbeat(lease)
      .then(
        (next) => {
          lease = next;
        },
        (error) => {
          heartbeatError = error;
          controller.abort();
        },
      )
      .finally(() => {
        heartbeat = undefined;
      });
  }, 20_000);
  timer.unref();
  const flush = async () => {
    for (const publication of state.pendingPublications(run.id)) {
      cancelled(signal);
      await dependencies.publish(lease, publication);
      state.acknowledgePublication(run.id, publication.sequence);
    }
  };
  const wait =
    dependencies.pause ??
    (async (ms: number, s: AbortSignal) => {
      await pause(Math.min(ms, 120_000), undefined, { signal: s });
    });
  try {
    cancelled(signal);
    await dependencies.assertWorkflowAvailable();
    await flush();
    if (state.runFinished(run.id)) return;
    let cursor: string | undefined;
    do {
      cancelled(signal);
      const page = await dependencies.work(cursor);
      for (const source of page.items) {
        cancelled(signal);
        if (state.sourceCompleted(run.id, source.sourceId)) continue;
        state.initializeSource(
          run.id,
          source.sourceId,
          run.workflowDigest,
          JSON.parse(
            JSON.stringify({ scope: run.scope, options: run.options, source }),
          ) as JsonValue,
        );
        for (;;) {
          cancelled(signal);
          await dependencies.assertWorkflowAvailable();
          let plan = state.pendingPlan(run.id, source.sourceId);
          if (!plan) {
            const snapshot = state.resumeSnapshot(run.id, source.sourceId);
            if (!snapshot) throw new WorkflowRecoveryRequired();
            plan = validateWorkflowPlan(await dependencies.advance(snapshot, signal));
            state.savePlan(run.id, source.sourceId, plan);
          }
          if (plan.state === 'waiting') {
            for (const step of plan.operations) {
              cancelled(signal);
              await dependencies.assertWorkflowAvailable();
              const binding = await dependencies.resolveBinding(step);
              const operationId = createHash('sha256')
                .update(JSON.stringify([run.id, source.sourceId, step.id]))
                .digest('hex');
              const existing = state.getOperation(operationId);
              const request: OperationRequest = {
                operationId,
                capability: step.capability,
                major: step.major,
                input: step.input,
                deadline:
                  existing?.request.deadline ?? new Date(Date.now() + 120_000).toISOString(),
              };
              state.beginOperation({
                runId: run.id,
                sourceId: source.sourceId,
                stepId: step.id,
                bindingId: binding.id,
                workflowDigest: run.workflowDigest,
                request,
              });
              await invokeWorkflowOperation(request, binding, {
                state,
                signal,
                checkpoint: plan.checkpoint,
                pause: wait,
                beforeDispatch: async () => {
                  await dependencies.assertWorkflowAvailable();
                  if ((await dependencies.resolveBinding(step)).id !== binding.id)
                    throw new Error('Workflow binding changed before dispatch');
                },
              });
              await flush();
            }
            await dependencies.publishPlan(source.sourceId, plan);
            state.finishPlan(run.id, source.sourceId);
          } else {
            await dependencies.publishPlan(source.sourceId, plan);
            state.completeSource(run.id, source.sourceId);
            await flush();
            break;
          }
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    state.finishRun(run.id);
    await flush();
  } catch (error) {
    throw heartbeatError ?? error;
  } finally {
    clearInterval(timer);
    await heartbeat;
  }
}
