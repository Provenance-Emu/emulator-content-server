import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  decodeCursor,
  encodeCursor,
  etagMatches,
  extractSurface,
  findBreakingChanges,
  ifRangeMatches,
  isCompatibleMajor,
  loadOpenApi,
  missingContractOperations,
  parseChangeCursor,
  parseSingleRange,
  problem,
  validateSystemIdentifier,
} from '../src/index.js';

const baselinePath = join(
  repoRoot(dirname(fileURLToPath(import.meta.url))),
  'docs',
  'protocol',
  'v1-surface.json',
);

function repoRoot(start: string): string {
  let current = start;
  while (!existsSync(join(current, 'pnpm-workspace.yaml'))) {
    const parent = dirname(current);
    if (parent === current) throw new Error('Repository root was not found');
    current = parent;
  }
  return current;
}

test('problem responses use stable URN types', () => {
  const body = problem({
    code: 'forbidden',
    title: 'Forbidden',
    status: 403,
    detail: 'Guest cannot read this asset',
    requestId: 'req-1',
  });
  assert.equal(body.type, 'urn:ecs:problem:forbidden');
  assert.equal(body.status, 403);
  assert.equal(body.requestId, 'req-1');
});

test('v1 compatibility is major-version exact', () => {
  assert.equal(isCompatibleMajor(1), true);
  assert.equal(isCompatibleMajor(2), false);
});

test('cursors round-trip and reject malformed change cursors', () => {
  assert.equal(decodeCursor(encodeCursor('item-1')), 'item-1');
  assert.equal(decodeCursor('not a cursor'), null);
  assert.equal(parseChangeCursor(undefined), 0);
  assert.equal(parseChangeCursor('12'), 12);
  assert.equal(Number.isNaN(parseChangeCursor('-1')), true);
  assert.equal(Number.isNaN(parseChangeCursor('1.5')), true);
});

test('single byte ranges clamp, reject multiples, and honor suffixes', () => {
  assert.deepEqual(parseSingleRange('bytes=1-3', 10), {
    type: 'partial',
    start: 1,
    end: 3,
  });
  assert.deepEqual(parseSingleRange('bytes=8-', 10), {
    type: 'partial',
    start: 8,
    end: 9,
  });
  assert.deepEqual(parseSingleRange('bytes=-2', 10), {
    type: 'partial',
    start: 8,
    end: 9,
  });
  assert.equal(parseSingleRange('bytes=0-1,2-3', 10).type, 'invalid');
  assert.equal(parseSingleRange('bytes=20-30', 10).type, 'unsatisfiable');
  assert.equal(etagMatches('W/"abc", "def"', '"def"'), true);
  assert.equal(ifRangeMatches('W/"abc"', '"abc"'), false);
  assert.equal(ifRangeMatches('"abc"', '"abc"'), true);
});

test('system identifiers preserve Provenance mixed-case ids', () => {
  assert.equal(validateSystemIdentifier('com.provenance.32X'), null);
  assert.equal(validateSystemIdentifier('com.provenance.appleII'), null);
  assert.ok(validateSystemIdentifier('../nes'));
});

test('OpenAPI contains every v1 operation and matches the committed surface', () => {
  const document = loadOpenApi();
  assert.deepEqual(missingContractOperations(document), []);
  const current = extractSurface(document);
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as typeof current;
  assert.deepEqual(findBreakingChanges(baseline, current), []);
  assert.deepEqual(current, baseline);
});
