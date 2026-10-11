import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openServer } from '../src/index.js';

async function withServer(
  uiDir: string | null,
  use: (server: Awaited<ReturnType<typeof openServer>>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-ui-'));
  const server = await openServer({ dataDir: dir, uiDir });
  try {
    await use(server);
  } finally {
    await server.close();
  }
}

test('the interface is served from the same origin as the API', async () => {
  const assets = await mkdtemp(join(tmpdir(), 'ecs-assets-'));
  await writeFile(join(assets, 'index.html'), '<!doctype html><title>UI</title>', 'utf8');
  await mkdir(join(assets, 'assets'));
  await writeFile(join(assets, 'assets', 'app.js'), 'export const ok = true;\n', 'utf8');
  const secret = await mkdtemp(join(tmpdir(), 'ecs-outside-'));
  await writeFile(join(secret, 'private.txt'), 'not for the web', 'utf8');

  await withServer(assets, async (server) => {
    const page = await server.app.inject({ method: 'GET', url: '/ui/' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<title>UI<\/title>/);
    assert.match(page.headers['content-type'] as string, /text\/html/);

    const policy = page.headers['content-security-policy'] as string;
    assert.match(policy, /default-src 'none'/, 'the page cannot reach another origin');
    assert.match(policy, /script-src 'self'/, 'and cannot run injected inline script');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');

    const script = await server.app.inject({ method: 'GET', url: '/ui/assets/app.js' });
    assert.equal(script.statusCode, 200);
    assert.match(script.headers['content-type'] as string, /javascript/);

    await writeFile(join(assets, 'assets', 'rebuilt.js'), 'export const fresh = true;\n', 'utf8');
    const rebuilt = await server.app.inject({ method: 'GET', url: '/ui/assets/rebuilt.js' });
    assert.equal(rebuilt.statusCode, 200, 'a rebuilt bundle is served without a restart');

    const bare = await server.app.inject({ method: 'GET', url: '/ui' });
    assert.equal(bare.statusCode, 308, 'the directory form is where relative assets resolve');
    assert.equal(bare.headers.location, '/ui/');

    const api = await server.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    assert.equal(api.statusCode, 200, 'mounting assets does not shadow the API');

    for (const url of [
      '/ui/../../../etc/passwd',
      '/ui/%2e%2e%2f%2e%2e%2fetc/passwd',
      `/ui/..${secret}/private.txt`,
    ]) {
      const attempt = await server.app.inject({ method: 'GET', url });
      assert.ok(
        attempt.statusCode >= 400 || !attempt.body.includes('not for the web'),
        `${url} must not read outside the asset directory`,
      );
    }
  });
});

test('a server with no built interface serves no interface', async () => {
  await withServer(null, async (server) => {
    const page = await server.app.inject({ method: 'GET', url: '/ui/' });
    assert.equal(page.statusCode, 404);
    const health = await server.app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200, 'the API is unaffected by the absent interface');
  });
});
