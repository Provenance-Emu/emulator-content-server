export type CleanupFindingKind =
  | 'identity-conflict'
  | 'suspected-mismatch'
  | 'missing-front-artwork'
  | 'questionable-front-artwork'
  | 'unavailable-selected-artwork';
export interface CleanupObservation {
  sourceId: string;
  kind: CleanupFindingKind;
  reason: string;
  evidenceIds: string[];
  candidateIds: string[];
}
/** Candidate references are proposals, never authority to write or to assert verified hashes. */
export interface CleanupProposalDraft {
  sourceId: string;
  findingId: string;
  action: 'replace-metadata' | 'replace-system' | 'replace-front-artwork';
  candidateId: string;
  evidenceIds: string[];
  reason: string;
}

import { invalid, list, object, text, unique } from './values.js';

function references(value: unknown): void {
  const ids = list(value).map((value) => text(value));
  unique(ids);
}

export function validateCleanupObservation(value: unknown): CleanupObservation {
  const observation = object(value, ['sourceId', 'kind', 'reason', 'evidenceIds', 'candidateIds']);
  text(observation.sourceId);
  text(observation.reason, 4096);
  if (
    ![
      'identity-conflict',
      'suspected-mismatch',
      'missing-front-artwork',
      'questionable-front-artwork',
      'unavailable-selected-artwork',
    ].includes(String(observation.kind))
  )
    invalid('Invalid cleanup finding kind');
  references(observation.evidenceIds);
  references(observation.candidateIds);
  return value as CleanupObservation;
}

export function validateCleanupProposalDraft(value: unknown): CleanupProposalDraft {
  const proposal = object(value, [
    'sourceId',
    'findingId',
    'action',
    'candidateId',
    'evidenceIds',
    'reason',
  ]);
  text(proposal.sourceId);
  text(proposal.findingId);
  text(proposal.candidateId);
  text(proposal.reason, 4096);
  if (
    !['replace-metadata', 'replace-system', 'replace-front-artwork'].includes(
      String(proposal.action),
    )
  )
    invalid('Invalid cleanup action');
  references(proposal.evidenceIds);
  return value as CleanupProposalDraft;
}
