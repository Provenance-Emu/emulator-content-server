import { ContentError } from '@ecs/client';

/**
 * What to show a person when a call fails. The server already explains itself in
 * a problem document, so its wording is preferred over anything invented here.
 */
export function explain(error: unknown): string {
  if (error instanceof ContentError) {
    return error.problem?.detail ?? error.problem?.title ?? `The server answered ${error.status}.`;
  }
  if (error instanceof Error && error.name === 'TypeError') {
    return 'The server is unreachable.';
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/** True when the server refused because this account is not the owner. */
export function isForbidden(error: unknown): boolean {
  return error instanceof ContentError && error.status === 403;
}
