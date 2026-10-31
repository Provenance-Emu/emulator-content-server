import { type ContentClient, ContentError } from '@ecs/client';
import { type JsonValue, validateWorkflowJson } from '@ecs/plugins/workflows';
import type { ResolvedWorkflowBinding } from '../runtime.js';

/** Trusted host adapter. Installed modules receive results, never the service client or its token. */
export function createCatalogTool(runId: string, client: ContentClient): ResolvedWorkflowBinding {
  return {
    id: 'org.ecs.catalog@1',
    async invoke(method, request, _handle, beforeDispatch, signal) {
      validateWorkflowJson(request.input);
      const input = request.input as { sourceId?: unknown };
      if (
        method !== 'start' ||
        request.capability !== 'catalog.search' ||
        request.major !== 1 ||
        !input ||
        typeof input.sourceId !== 'string' ||
        Object.keys(input).length !== 1
      )
        return { state: 'failed', error: { code: 'invalid-input' } };
      signal.throwIfAborted();
      await beforeDispatch();
      signal.throwIfAborted();
      try {
        return {
          state: 'completed',
          output: (await client.searchWorkflowCatalog(
            runId,
            input.sourceId,
          )) as unknown as JsonValue,
        };
      } catch (error) {
        if (error instanceof ContentError)
          return {
            state: 'failed',
            error: {
              code:
                error.status === 401 || error.status === 403
                  ? 'authentication'
                  : error.status === 429
                    ? 'rate-limit'
                    : 'unavailable',
            },
          };
        // Read-only catalog inspection has no paid or mutating submission to reconcile.
        return { state: 'failed', error: { code: 'unavailable' } };
      }
    },
  };
}
