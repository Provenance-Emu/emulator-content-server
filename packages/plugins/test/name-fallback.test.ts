import assert from 'node:assert/strict';
import test from 'node:test';
import {
  automaticFillRank,
  createLibretroMatcher,
  type MatchCandidate,
  type MatchingInput,
} from '../src/matching.js';
import { nameFallbackScore } from '../src/matching-names.js';

const systemId = 'com.provenance.jaguar';
const input: MatchingInput = {
  name: 'Raly Racer (1995).jag',
  systemId,
  allowExactNames: true,
  companions: [],
  facts: {
    version: 1,
    pluginIds: [],
    names: [],
    identifiers: [],
    warnings: [],
    hashes: [
      { algorithm: 'md5', value: 'a'.repeat(32), size: 4, representation: 'raw', verified: true },
    ],
  },
};
const candidate: MatchCandidate = {
  id: 'name',
  title: 'Rally Racer (USA)',
  kind: 'metadata',
  confidence: 'name',
  metadata: {
    systemId,
    md5: 'b'.repeat(32),
    hashSize: '4',
    identityConflict: 'true',
    matchEvidence: 'hash-conflict',
  },
};

test('filename fallback accepts close names and edition variations without inventing verified evidence', () => {
  const rank = automaticFillRank(input, candidate, [candidate]);
  assert.ok(rank > 0 && rank < 1);
  assert.equal(candidate.confidence, 'name');
  assert.ok(nameFallbackScore('MystDemo.cdi', 'Myst (USA) (Demo)') > 0);
  assert.equal(nameFallbackScore('Rally Racer 2', 'Rally Racer'), 0);
  assert.equal(nameFallbackScore('Rally Racer II', 'Rally Racer'), 0);
  assert.equal(nameFallbackScore('track01.bin', 'Rally Racer'), 0);
  assert.equal(
    automaticFillRank(
      input,
      { ...candidate, metadata: { ...candidate.metadata, systemId: 'com.provenance.nes' } },
      [candidate],
    ),
    0,
  );
});

test('a verified catalog identity outranks names and blocks fallback to another game', () => {
  const verified = {
    ...candidate,
    id: 'hash',
    title: 'Actual inspected game',
    metadata: { systemId, md5: 'a'.repeat(32), hashSize: '4', identityConflict: 'true' },
  };
  assert.equal(automaticFillRank(input, candidate, [candidate, verified]), 0);
  assert.equal(automaticFillRank(input, verified, [candidate, verified]), 4);
  assert.ok(input.facts);
  const conflict = { ...input, facts: { ...input.facts, warnings: ['disc-system-conflict'] } };
  assert.equal(automaticFillRank(conflict, candidate, [candidate]), 0);
  const otherPlatform = {
    ...input,
    facts: {
      ...input.facts,
      identifiers: [
        {
          type: 'serial' as const,
          value: 'SLUS-12345',
          verified: true,
          systemId: 'com.provenance.psx',
        },
      ],
    },
  };
  assert.equal(automaticFillRank(otherPlatform, candidate, [candidate]), 0);
});

test('compiled public catalogs return close name candidates when hashes and exact names miss', () => {
  const match = createLibretroMatcher([
    {
      title: 'Rally Racer (USA)',
      name: 'Rally Racer (USA).j64',
      systemId,
      md5: 'b'.repeat(32),
      size: 4,
    },
    { title: 'Rally Racer 2 (USA)', name: 'Rally Racer 2.j64', systemId },
    { title: 'Completely Different', name: 'Different.j64', systemId },
  ]);
  const found = match(input);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.title, 'Rally Racer (USA)');
  assert.ok(found[0]);
  assert.ok(automaticFillRank(input, found[0], found) > 0);
});

test('a verified serial identifies another dump even if its bytes differ from the catalog edition', () => {
  const serialInput = {
    ...input,
    name: 'renamed.bin',
    facts: {
      ...input.facts,
      version: 1 as const,
      pluginIds: [],
      hashes: input.facts?.hashes ?? [],
      names: [],
      warnings: [],
      identifiers: [{ type: 'serial' as const, value: 'SLUS-12345', verified: true, systemId }],
    },
  };
  const serial = {
    ...candidate,
    title: 'Actual identified game',
    metadata: { ...candidate.metadata, serials: '["SLUS-12345"]' },
  };
  assert.equal(automaticFillRank(serialInput, serial, [serial]), 3);
});
