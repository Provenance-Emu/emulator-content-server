import type { CapabilityDescription } from './capabilities.js';
import type { SchemaDocument } from './schemas.js';
import { integer, invalid, type JsonValue, jsonValue, object, text } from './values.js';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostMicros?: number | null;
  reportedCostMicros?: number | null;
  currency?: string;
}
export interface OperationError {
  code:
    | 'invalid-input'
    | 'authentication'
    | 'rate-limit'
    | 'unsupported-capability'
    | 'timeout'
    | 'unavailable'
    | 'invalid-output'
    | 'uncertain-submission';
  retryAfterMs?: number;
}
export interface OperationRequest {
  operationId: string;
  capability: string;
  major: number;
  input: JsonValue;
  deadline: string;
}
export type OperationResult =
  | { state: 'completed'; output: JsonValue; usage?: Usage }
  | { state: 'pending'; resumeHandle: JsonValue; pollAfterMs: number }
  | { state: 'failed'; error: OperationError };
export interface OperationContext {
  signal: AbortSignal;
  connection: { endpoint: string; model?: string; configuration: JsonValue };
  credential(name: string): string | undefined;
}
export interface TranslatorPluginV2 {
  describe(context: OperationContext): Promise<CapabilityDescription[]>;
  start(request: OperationRequest, context: OperationContext): Promise<OperationResult>;
  poll?(
    request: OperationRequest,
    handle: JsonValue,
    context: OperationContext,
  ): Promise<OperationResult>;
  cancel?(request: OperationRequest, handle: JsonValue, context: OperationContext): Promise<void>;
}
export type ToolPluginV2 = TranslatorPluginV2;
export interface TextGenerationInput {
  prompt: string;
  responseSchema?: SchemaDocument;
  maxOutputTokens: number;
}
export interface StructuredGenerationOutput {
  value: JsonValue;
}
export interface ImageInspectionInput extends TextGenerationInput {
  artifactIds: string[];
}

export function validateOperationResult(value: unknown): OperationResult {
  jsonValue(value, undefined, true);
  const record = object(value);
  if (record.state === 'completed') {
    object(record, ['state', 'output', 'usage']);
    jsonValue(record.output, undefined, true);
    if (record.usage !== undefined) {
      const usage = object(record.usage, [
        'inputTokens',
        'outputTokens',
        'estimatedCostMicros',
        'reportedCostMicros',
        'currency',
      ]);
      for (const key of ['inputTokens', 'outputTokens'])
        if (usage[key] !== undefined) integer(usage[key]);
      for (const key of ['estimatedCostMicros', 'reportedCostMicros'])
        if (usage[key] !== undefined && usage[key] !== null) integer(usage[key]);
      if (usage.currency !== undefined && !/^[A-Z]{3}$/.test(text(usage.currency, 3)))
        invalid('Invalid usage currency');
    }
  } else if (record.state === 'pending') {
    object(record, ['state', 'resumeHandle', 'pollAfterMs']);
    jsonValue(record.resumeHandle, 64 * 1024, true);
    integer(record.pollAfterMs, 1, 24 * 60 * 60 * 1000);
  } else if (record.state === 'failed') {
    object(record, ['state', 'error']);
    const error = object(record.error, ['code', 'retryAfterMs']);
    if (
      ![
        'invalid-input',
        'authentication',
        'rate-limit',
        'unsupported-capability',
        'timeout',
        'unavailable',
        'invalid-output',
        'uncertain-submission',
      ].includes(String(error.code))
    )
      invalid('Invalid operation error');
    if (error.retryAfterMs !== undefined) integer(error.retryAfterMs, 0, 24 * 60 * 60 * 1000);
  } else invalid('Invalid operation state');
  return value as OperationResult;
}
