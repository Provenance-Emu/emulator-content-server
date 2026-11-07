import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openApiFile } from '@ecs/protocol';
import { openServer } from '../src/index.js';

test('API-only servers serve Swagger UI and the bundled contract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-api-docs-'));
  const server = await openServer({ dataDir: dir, uiDir: null, localTrust: false });
  try {
    const redirect = await server.app.inject('/docs');
    assert.equal(redirect.statusCode, 308);
    assert.equal(redirect.headers.location, '/docs/');
    const page = await server.app.inject('/docs/');
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'] ?? '', /text\/html/);
    assert.match(page.headers['content-security-policy'] ?? '', /connect-src 'self'/);

    const assets = [...page.body.matchAll(/(?:src|href)="(\/docs\/[^" ]+)"/g)];
    assert.equal(assets.length, 3);
    for (const [, path] of assets) {
      assert.ok(path);
      const asset = await server.app.inject(path);
      assert.equal(asset.statusCode, 200, path);
      if (path.endsWith('/init.js')) assert.match(asset.body, /url: '\/openapi\.yaml'/);
    }

    const contract = await server.app.inject('/openapi.yaml');
    assert.equal(contract.statusCode, 200);
    assert.equal(contract.body, await readFile(openApiFile(), 'utf8'));
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
