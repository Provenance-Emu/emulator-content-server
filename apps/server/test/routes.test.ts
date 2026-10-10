import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HTTP_OPERATIONS } from '@ecs/protocol';
import { openServer } from '../src/index.js';

test('the server registers every v1 contract operation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-routes-'));
  const server = await openServer({ dataDir: dir });
  try {
    for (const operation of HTTP_OPERATIONS) {
      const space = operation.indexOf(' ');
      const method = operation.slice(0, space);
      const url = operation.slice(space + 1);
      assert.equal(server.app.hasRoute({ method: method as 'GET', url }), true, operation);
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
