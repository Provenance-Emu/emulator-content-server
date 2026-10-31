import {
  type JsonValue,
  validateCapabilityDescription,
  validateOperationResult,
  validateWorkflowJson,
  validateWorkflowPlan,
} from '@ecs/plugins/workflows';

export type WorkflowWorkerMethod = 'advance' | 'describe' | 'start' | 'poll' | 'cancel';
export interface WorkflowWorkerContext {
  connection?: { endpoint: string; model?: string; configuration?: JsonValue };
  credentials?: Record<string, string>;
}
export function validateWorkerValue(method: WorkflowWorkerMethod, value: unknown): JsonValue {
  validateWorkflowJson(value, undefined, true);
  if (method === 'advance') validateWorkflowPlan(value);
  else if (method === 'start' || method === 'poll') validateOperationResult(value);
  else if (method === 'describe') {
    if (!Array.isArray(value) || value.length > 32)
      throw new Error('Invalid workflow capability response');
    value.forEach(validateCapabilityDescription);
  } else if (value !== null) throw new Error('Invalid workflow cancellation response');
  return value as JsonValue;
}
