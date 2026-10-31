import { capabilityName } from './capabilities.js';
import type { CleanupObservation, CleanupProposalDraft } from './cleanup.js';
import { validateCleanupObservation, validateCleanupProposalDraft } from './cleanup.js';
import type { OperationResult } from './operations.js';
import {
  integer,
  invalid,
  type JsonValue,
  jsonValue,
  list,
  object,
  text,
  unique,
  WORKFLOW_LIMITS,
} from './values.js';

export interface WorkflowStep {
  id: string;
  binding: string;
  capability: string;
  major: number;
  input: JsonValue;
}
export interface WorkflowSnapshot {
  input: JsonValue;
  checkpoint: JsonValue;
  completed: Record<string, OperationResult>;
}
export interface WorkflowPlan {
  state: 'waiting' | 'completed';
  checkpoint: JsonValue;
  operations: WorkflowStep[];
  observations?: CleanupObservation[];
  proposals?: CleanupProposalDraft[];
  output?: JsonValue;
}
export interface WorkflowPluginV2 {
  advance(snapshot: WorkflowSnapshot): Promise<WorkflowPlan>;
}

export function validateWorkflowPlan(value: unknown): WorkflowPlan {
  jsonValue(value, WORKFLOW_LIMITS.envelope, true);
  const plan = object(value, [
    'state',
    'checkpoint',
    'operations',
    'observations',
    'proposals',
    'output',
  ]);
  if (!['waiting', 'completed'].includes(String(plan.state))) invalid('Invalid workflow state');
  jsonValue(plan.checkpoint, WORKFLOW_LIMITS.checkpoint, true);
  const operations = list(plan.operations, 64);
  const ids: string[] = [];
  for (const value of operations) {
    const operation = object(value, ['id', 'binding', 'capability', 'major', 'input']);
    ids.push(text(operation.id));
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(text(operation.binding, 64)))
      invalid('Invalid operation binding');
    capabilityName(operation.capability);
    integer(operation.major, 1, 1000);
    jsonValue(operation.input, undefined, true);
  }
  unique(ids);
  if (plan.state === 'completed' && operations.length)
    invalid('Completed workflows cannot request operations');
  if (plan.state === 'waiting' && !operations.length)
    invalid('Waiting workflows must request work');
  if (plan.observations !== undefined)
    list(plan.observations, 100).forEach(validateCleanupObservation);
  if (plan.proposals !== undefined) list(plan.proposals, 10).forEach(validateCleanupProposalDraft);
  return value as WorkflowPlan;
}
