import type {
  CleanupObservation,
  JsonValue,
  WorkflowPlan,
  WorkflowSnapshot,
} from '@ecs/plugins/workflows';
import type { WorkflowCatalogResult } from '@ecs/protocol';

/** No host imports: the compiled module is packaged unchanged as the default community ABI workflow. */
export async function advance(snapshot: WorkflowSnapshot): Promise<WorkflowPlan> {
  const input = snapshot.input as { source?: { sourceId?: string } };
  const sourceId = input.source?.sourceId;
  if (!sourceId) throw new Error('Cleanup needs a scoped source');
  const inspected = snapshot.completed.inspect;
  if (!inspected)
    return {
      state: 'waiting',
      checkpoint: { stage: 'inspect' },
      operations: [
        {
          id: 'inspect',
          binding: 'catalog',
          capability: 'catalog.search',
          major: 1,
          input: { sourceId },
        },
      ],
    };
  if (inspected.state !== 'completed')
    return {
      state: 'completed',
      checkpoint: null,
      operations: [],
      observations: [],
      proposals: [],
      output: { unresolved: 'inspection-failed' },
    };
  const result = inspected.output as unknown as WorkflowCatalogResult;
  if (result.facts.sourceId !== sourceId) throw new Error('Cleanup source scope changed');
  const observations: CleanupObservation[] = [];
  let proposed = 0;
  const take = (ids: string[]) => {
    const selected = ids.slice(0, 10 - proposed);
    proposed += selected.length;
    return selected;
  };
  const add = (kind: CleanupObservation['kind'], reason: string, candidateIds: string[] = []) =>
    observations.push({
      sourceId,
      kind,
      reason,
      evidenceIds: [
        ...new Set([
          ...result.facts.evidenceIds,
          ...result.candidates
            .filter(
              (c) =>
                candidateIds.includes(c.id) || (kind === 'identity-conflict' && c.identityConflict),
            )
            .flatMap((c) => c.evidenceIds),
        ]),
      ].slice(0, 100),
      candidateIds,
    });
  const conflicts =
    result.facts.selected.some((s) => s.identityConflict) ||
    result.candidates.some((c) => c.identityConflict);
  const safe =
    result.problems.length || conflicts ? [] : result.candidates.filter((c) => !c.identityConflict);
  if (conflicts)
    add(
      'identity-conflict',
      'Saved details or catalog editions disagree with the verified source identity.',
    );
  const metadata = result.facts.selected.find((s) => s.kind === 'metadata');
  if (
    metadata &&
    !conflicts &&
    safe.some(
      (c) =>
        c.kind === 'metadata' && c.evidenceClass === 'verified-source' && !c.agreesWithSelection,
    )
  )
    add(
      'suspected-mismatch',
      'Verified catalog evidence suggests different game details.',
      take(
        safe
          .filter((c) => c.kind === 'metadata' && c.evidenceClass === 'verified-source')
          .map((c) => c.id),
      ),
    );
  const front = result.facts.selected.find(
    (s) => s.kind === 'artwork' && s.artworkRole === 'front',
  );
  const art = take(
    safe.filter((c) => c.kind === 'artwork' && c.artworkRole === 'front').map((c) => c.id),
  );
  if (!front) add('missing-front-artwork', 'No front cover is saved for this game.', art);
  else if (!front.contentAvailable)
    add('unavailable-selected-artwork', 'The selected front cover has no available image.', art);
  return {
    state: 'completed',
    checkpoint: { stage: 'complete' },
    operations: [],
    observations,
    proposals: [],
    output: {
      unresolved: result.problems.length
        ? 'provider-failed'
        : !result.supportedIdentity
          ? 'unsupported-identity'
          : null,
      problems: result.problems,
    } as JsonValue,
  };
}
export default { advance };
