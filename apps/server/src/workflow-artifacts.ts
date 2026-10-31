import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import {
  DomainError,
  type SourceMatchRecord,
  type WorkflowArtifact,
  type WorkflowProposal,
  type WorkflowRun,
} from '@ecs/domain';
import {
  automaticEvidence,
  hasIdentityConflict,
  type MatchCandidate,
  type MatchingInput,
} from '@ecs/plugins/matching';
import { type CleanupProposalDraft, validateCleanupProposalDraft } from '@ecs/plugins/workflows';
import { validateSystemIdentifier } from '@ecs/protocol';
import type { ServerContext } from './context.js';
import { describeRaster } from './matching-files.js';
import { localSource } from './source-groups.js';
import type { SourceMatchingService } from './source-matching.js';
import { sourceMetadata } from './source-metadata.js';
import { workflowHash } from './workflow-values.js';

export interface WorkflowCandidateRecord {
  type: 'candidate';
  candidate: MatchCandidate & { providerId: string };
  input: MatchingInput;
  stamps: Record<string, string>;
  selectionRevision: number;
}
function publicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    a < 224 &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 0 || b === 168)) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113)
  );
}
export function validateWorkflowArtworkDestination(value: string, addresses: string[]): URL {
  const url = new URL(value);
  if (
    url.origin !== 'https://raw.githubusercontent.com' ||
    !url.pathname.startsWith('/libretro-thumbnails/') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !addresses.length ||
    addresses.some((address) => !publicIpv4(address))
  )
    throw new DomainError(
      'workflow-artwork-destination',
      403,
      'Artwork destination is not authorized',
    );
  return url;
}
async function remoteArtwork(value: string, signal: AbortSignal): Promise<Buffer> {
  // Only this fixed catalog origin is permitted. Inference endpoints do not grant artwork fetch rights.
  const parsed = validateWorkflowArtworkDestination(value, ['1.1.1.1']);
  const addresses = await lookup(parsed.hostname, { all: true, family: 4 });
  const url = validateWorkflowArtworkDestination(
    value,
    addresses.map((a) => a.address),
  );
  const pinned = addresses[0]?.address;
  if (!pinned)
    throw new DomainError('workflow-artwork-destination', 403, 'Artwork destination unavailable');
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        agent: false,
        family: 4,
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [{ address: pinned, family: 4 }]);
          else callback(null, pinned, 4);
        },
      },
      (response) => {
        if (
          response.statusCode !== 200 ||
          Number(response.headers['content-length'] ?? 0) > 2 * 1024 * 1024
        ) {
          response.destroy();
          reject(
            new DomainError(
              'workflow-artwork-unavailable',
              404,
              'Artwork is unavailable; redirects are not followed',
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            response.destroy(new Error('Artwork exceeds limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', () =>
          reject(new DomainError('workflow-artwork-unavailable', 404, 'Artwork download failed')),
        );
        response.once('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    req.once('error', () =>
      reject(new DomainError('workflow-artwork-unavailable', 404, 'Artwork download failed')),
    );
    req.end();
  });
}

export async function stageWorkflowArtwork(
  context: ServerContext,
  run: WorkflowRun,
  sourceId: string,
  receipt: WorkflowCandidateRecord,
  matching: Pick<SourceMatchingService, 'validateInspection' | 'readResource'>,
  signal: AbortSignal,
): Promise<WorkflowArtifact> {
  const candidate = receipt.candidate;
  if (candidate.kind !== 'artwork' || (candidate.metadata.artworkRole ?? 'front') !== 'front')
    throw new DomainError('invalid-request', 400, 'Cleanup stages front covers only');
  const actor = context.catalog.actorForUser(run.actorId);
  if (!actor?.isOwner) throw new DomainError('forbidden', 403, 'Workflow creator unavailable');
  await matching.validateInspection(actor, receipt.stamps);
  let bytes: Buffer;
  if (candidate.fileId)
    bytes = (await matching.readResource(actor, sourceId, candidate, signal)).bytes;
  else {
    if (!run.options.online || candidate.providerId !== 'org.ecs.libretro' || !candidate.url)
      throw new DomainError(
        'workflow-artwork-destination',
        403,
        'This run cannot download that artwork',
      );
    bytes = await remoteArtwork(candidate.url, signal);
  }
  const raster = describeRaster(bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (candidate.metadata.resourceSha256 && candidate.metadata.resourceSha256 !== sha256)
    throw new DomainError(
      'workflow-artwork-changed',
      409,
      'Artwork differs from its catalog digest',
    );
  const attributionJson = JSON.stringify({
    providerId: candidate.providerId,
    title: candidate.title,
    origin: candidate.fileId ? 'local' : 'catalog',
    sourceUrl: candidate.url ?? null,
    license: candidate.metadata.license ?? null,
    attribution: candidate.metadata.attribution ?? null,
  });
  const artifact: WorkflowArtifact = {
    id: workflowHash([run.id, sourceId, sha256, attributionJson]),
    runId: run.id,
    sourceId,
    sha256,
    size: bytes.length,
    ...raster,
    attributionJson,
    expiresAt: null,
  };
  return context.catalog.workflowProposals.stageArtifact(
    artifact,
    bytes,
    `staging:${candidate.id}`,
  );
}

export async function materializeCleanupProposal(
  context: ServerContext,
  run: WorkflowRun,
  value: CleanupProposalDraft,
  matching: Pick<SourceMatchingService, 'validateInspection' | 'readResource'>,
  signal: AbortSignal,
): Promise<WorkflowProposal> {
  let draft: CleanupProposalDraft;
  try {
    draft = validateCleanupProposalDraft(value);
  } catch {
    throw new DomainError('invalid-request', 400, 'Invalid cleanup proposal');
  }
  if (
    !['running', 'completed'].includes(run.state) ||
    !context.catalog.workflowRuns.sourceSnapshot(run.id, draft.sourceId)
  )
    throw new DomainError(
      'workflow-state-conflict',
      409,
      'This source is unavailable for proposal creation',
    );
  if (!context.catalog.workflowRuns.sourceIsCurrent(run.id, draft.sourceId))
    throw new DomainError('workflow-source-changed', 409, 'Source location or library changed');
  const finding = context.catalog.workflowProposals.getFinding(draft.findingId);
  if (!finding || finding.runId !== run.id || finding.sourceId !== draft.sourceId)
    throw new DomainError('not-found', 404, 'Finding unavailable');
  if (context.catalog.workflowProposals.isDismissed(finding))
    throw new DomainError('workflow-finding-dismissed', 409, 'This finding was kept or dismissed');
  if (
    draft.action === 'replace-front-artwork'
      ? ![
          'missing-front-artwork',
          'questionable-front-artwork',
          'unavailable-selected-artwork',
        ].includes(finding.kind)
      : !['identity-conflict', 'suspected-mismatch'].includes(finding.kind)
  )
    throw new DomainError('invalid-request', 400, 'Proposal does not address this finding');
  let record: WorkflowCandidateRecord | undefined, validator: string | undefined;
  for (const id of draft.evidenceIds) {
    const receipt = context.catalog.workflowProposals.getEvidence(run.id, draft.sourceId, id);
    if (!receipt) throw new DomainError('invalid-request', 400, 'Unknown proposal evidence');
    const payload = JSON.parse(receipt.payloadJson) as WorkflowCandidateRecord;
    if (payload.type === 'candidate' && payload.candidate.id === draft.candidateId) {
      record = payload;
      validator = receipt.sourceValidator;
    }
  }
  if (!record || !validator)
    throw new DomainError('invalid-request', 400, 'Candidate needs an immutable catalog receipt');
  const candidate = record.candidate;
  const kind =
    draft.action === 'replace-front-artwork'
      ? 'artwork'
      : draft.action === 'replace-system'
        ? 'rom'
        : 'metadata';
  if (
    candidate.kind !== kind ||
    hasIdentityConflict(record.input, [candidate]) ||
    candidate.metadata.identityConflict === 'true'
  )
    throw new DomainError(
      'invalid-request',
      400,
      'Candidate conflicts with this source or selection slot',
    );
  if (candidate.metadata.systemId && validateSystemIdentifier(candidate.metadata.systemId))
    throw new DomainError('invalid-request', 400, 'Candidate has an invalid system identifier');
  if (kind === 'rom' && !candidate.metadata.systemId)
    throw new DomainError(
      'invalid-request',
      400,
      'System proposal needs a catalog system identifier',
    );
  const actor = context.catalog.actorForUser(run.actorId);
  if (!actor?.isOwner) throw new DomainError('forbidden', 403, 'Workflow creator unavailable');
  async function validateCurrent() {
    const file = await localSource(context, actor as NonNullable<typeof actor>, draft.sourceId);
    const current = context.catalog.sourceMatches(draft.sourceId);
    if (
      workflowHash((await sourceMetadata(file.path, draft.sourceId)).etag) !== validator ||
      current.revision !== record?.selectionRevision ||
      workflowHash(current) !== finding?.currentValueDigest
    )
      throw new DomainError(
        'workflow-selection-changed',
        409,
        'Source or saved selections changed; inspect again',
      );
  }
  await validateCurrent();
  const id = workflowHash([run.id, draft.sourceId, finding.id, draft.action, candidate.id]);
  const existing = context.catalog.workflowProposals.getProposal(id);
  if (
    existing &&
    existing.sourceValidator === validator &&
    existing.selectionRevision === record.selectionRevision
  )
    return existing;
  await matching.validateInspection(actor, record.stamps);
  const artifact =
    kind === 'artwork'
      ? await stageWorkflowArtwork(context, run, draft.sourceId, record, matching, signal)
      : null;
  signal.throwIfAborted();
  await validateCurrent();
  const snapshot: SourceMatchRecord = {
    id: candidate.id,
    providerId: candidate.providerId,
    kind: candidate.kind,
    title: candidate.title,
    confidence: candidate.confidence,
    metadata: { ...candidate.metadata },
    originKind: candidate.fileId ? (kind === 'artwork' ? 'artwork' : null) : null,
    ...(candidate.fileId ? { originFileId: candidate.fileId } : {}),
    ...(candidate.url ? { originUrl: candidate.url } : {}),
    contentAvailable: !!artifact,
    contentType: artifact?.contentType ?? null,
    fileName: artifact
      ? `cover.${artifact.contentType === 'image/jpeg' ? 'jpg' : artifact.contentType === 'image/webp' ? 'webp' : 'png'}`
      : null,
    updatedAt: new Date().toISOString(),
  };
  return context.catalog.workflowProposals.saveProposal(
    {
      id,
      runId: run.id,
      findingId: finding.id,
      sourceId: draft.sourceId,
      sourceName: record.input.name,
      evidenceClass:
        automaticEvidence({ ...record.input, allowExactNames: false }, candidate) &&
        ['verified-hash', 'verified-serial'].includes(candidate.metadata.matchEvidence ?? '')
          ? 'verified-source'
          : candidate.confidence === 'local'
            ? 'local'
            : candidate.confidence === 'name'
              ? 'filename'
              : 'unverified',
      sourceValidator: validator,
      selectionRevision: record.selectionRevision,
      currentValueDigest: finding.currentValueDigest,
      change: {
        action: draft.action,
        candidateId: candidate.id,
        artifactId: artifact?.id ?? null,
        snapshotJson: JSON.stringify(snapshot),
      },
      evidenceIds: draft.evidenceIds,
      reason: draft.reason,
    },
    { reuseCurrentSnapshot: true },
  );
}
