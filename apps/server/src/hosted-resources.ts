import { createHash } from 'node:crypto';
import { DomainError } from '@ecs/domain';
import { type MatchCandidate, patchFingerprint } from '@ecs/plugins/matching';
import type { MatchingReply } from '@ecs/plugins/matching-host';

/** Recheck isolated worker output against the private saved proposal before persisting bytes. */
export function verifyHostedResource(candidate: MatchCandidate, fetched: MatchingReply) {
  const proof = fetched.catalogResource;
  const bytes = Buffer.from(fetched.file ?? '', 'base64');
  if (
    !proof ||
    proof.kind !== candidate.kind ||
    proof.release !== candidate.metadata.catalogRelease ||
    proof.format !== candidate.metadata.format ||
    proof.sha256 !== candidate.metadata.resourceSha256 ||
    proof.bytes !== bytes.length ||
    bytes.length !== Number(candidate.metadata.resourceBytes) ||
    bytes.length > (candidate.kind === 'cheats' ? 256 * 1024 : 2 * 1024 * 1024) ||
    createHash('sha256').update(bytes).digest('hex') !== proof.sha256
  )
    throw new DomainError(
      'matching-resource-changed',
      409,
      'Catalog content failed integrity verification.',
    );
  if (candidate.kind === 'patch') {
    const fingerprint = patchFingerprint(bytes);
    if (
      !fingerprint ||
      fingerprint.format !== proof.format ||
      (fingerprint.sourceCrc32 &&
        fingerprint.sourceCrc32.toLowerCase() !== candidate.metadata.crc32?.toLowerCase()) ||
      (fingerprint.sourceSize !== undefined &&
        fingerprint.sourceSize !== Number(candidate.metadata.hashSize))
    )
      throw new DomainError(
        'unsupported-patch',
        415,
        'Patch does not match its catalog base identity.',
      );
  }
  return { bytes, fileName: `selected.${proof.format === 'retroarch-cht' ? 'cht' : proof.format}` };
}
