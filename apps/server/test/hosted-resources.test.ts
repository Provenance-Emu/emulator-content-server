import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { normalizeCheats } from '@ecs/plugins/cheats';
import type { MatchCandidate } from '@ecs/plugins/matching';
import type { MatchingReply } from '@ecs/plugins/matching-host';
import { verifyHostedResource } from '../src/hosted-resources.js';

function fixture(kind: 'patch' | 'cheats') {
  const bytes =
    kind === 'patch'
      ? Buffer.concat([Buffer.from('BPS1'), Buffer.from([0x84, 0x85, 0x80]), Buffer.alloc(12)])
      : Buffer.from('cheats = "1"\ncheat0_code = "0000:01"\ncheat0_enable = "true"\n');
  if (kind === 'patch') {
    bytes.writeUInt32LE(0x12345678, bytes.length - 12);
    bytes.writeUInt32LE(crc32(bytes.subarray(0, -4)), bytes.length - 4);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const format = kind === 'patch' ? 'bps' : 'retroarch-cht';
  const candidate: MatchCandidate = {
    id: 'generated',
    kind,
    title: 'Generated',
    confidence: 'checksum',
    metadata: {
      catalogRelease: 'v1',
      format,
      resourceSha256: sha256,
      resourceBytes: String(bytes.length),
      crc32: '12345678',
      hashSize: '4',
    },
  };
  const reply: MatchingReply = {
    plugins: [],
    file: bytes.toString('base64'),
    catalogResource: { kind, format, release: 'v1', sha256, bytes: bytes.length },
  };
  return { bytes, candidate, reply };
}
test('host verifies raw cheat payload before normalization forces codes disabled', () => {
  const { bytes, candidate, reply } = fixture('cheats');
  const result = verifyHostedResource(candidate, reply);
  assert.deepEqual(result.bytes, bytes);
  assert.match(normalizeCheats(result.bytes).text, /cheat0_enable = "false"/);
  for (const metadata of <Record<string, string>[]>[
    { resourceSha256: '0'.repeat(64) },
    { resourceBytes: '1' },
    { catalogRelease: 'v2' },
    { format: 'bps' },
  ])
    assert.throws(() =>
      verifyHostedResource(
        { ...candidate, metadata: { ...candidate.metadata, ...metadata } },
        reply,
      ),
    );
  assert.throws(() =>
    verifyHostedResource(candidate, { ...reply, file: Buffer.from('tampered').toString('base64') }),
  );
});
test('host rejects validly hashed patches for a different declared base CRC or size', () => {
  const { bytes, candidate, reply } = fixture('patch');
  assert.deepEqual(verifyHostedResource(candidate, reply).bytes, bytes);
  for (const metadata of <Record<string, string>[]>[
    { crc32: '87654321' },
    { hashSize: '5' },
    { crc32: '' },
  ])
    assert.throws(() =>
      verifyHostedResource(
        { ...candidate, metadata: { ...candidate.metadata, ...metadata } },
        reply,
      ),
    );
});
