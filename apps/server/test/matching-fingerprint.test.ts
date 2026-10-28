import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { boundedFingerprint } from '../src/matching-files.js';

test('bounded streaming fingerprint matches known MD5 and CRC32 and honors limit/cancellation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-fingerprint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'generated');
  await writeFile(path, '123456789');
  assert.deepEqual(await boundedFingerprint(path, 9), {
    md5: createHash('md5').update('123456789').digest('hex'),
    crc32: 'cbf43926',
    size: 9,
  });
  await assert.rejects(boundedFingerprint(path, 8), /read limit/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(boundedFingerprint(path, 9, abort.signal));
  await writeFile(path, Buffer.alloc(8 * 1024 * 1024, 0x42));
  const active = new AbortController();
  const promise = boundedFingerprint(path, 8 * 1024 * 1024, active.signal);
  setTimeout(() => active.abort(), 1);
  await assert.rejects(promise);
});
