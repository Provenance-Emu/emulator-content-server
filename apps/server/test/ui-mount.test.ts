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

test('the public isolated play document has its own policy and reuses unchanged UI assets', async () => {
  const assets = await mkdtemp(join(tmpdir(), 'ecs-play-shell-'));
  await mkdir(join(assets, 'play'));
  await mkdir(join(assets, 'assets'));
  await writeFile(join(assets, 'index.html'), '<title>Library</title>');
  await writeFile(
    join(assets, 'play', 'index.html'),
    '<title>Player</title><script src="/ui/assets/player.js"></script>',
  );
  await writeFile(join(assets, 'assets', 'player.js'), 'export const player = true;');
  await withServer(assets, async ({ app }) => {
    const redirect = await app.inject({ url: '/play' });
    assert.equal(redirect.statusCode, 308);
    assert.equal(redirect.headers.location, '/play/');
    const play = await app.inject({ url: '/play/' });
    assert.equal(play.statusCode, 200, 'navigation needs no bearer header');
    assert.match(play.body, /Player/);
    assert.equal(
      play.headers['content-security-policy'],
      "default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'",
    );
    assert.equal(play.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(play.headers['cross-origin-embedder-policy'], 'require-corp');
    assert.equal(play.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(play.headers['referrer-policy'], 'no-referrer');
    assert.equal(play.headers['x-content-type-options'], 'nosniff');
    const ui = await app.inject({ url: '/ui/' });
    assert.equal(
      ui.headers['content-security-policy'],
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    assert.equal(ui.headers['cross-origin-opener-policy'], undefined);
    const script = await app.inject({ url: '/ui/assets/player.js' });
    assert.equal(script.statusCode, 200);
    assert.equal(script.headers['content-security-policy'], ui.headers['content-security-policy']);
    assert.equal((await app.inject({ url: '/play/not-present.js' })).statusCode, 404);
    assert.equal((await app.inject({ url: '/play/../index.html' })).statusCode, 404);
  });
});
