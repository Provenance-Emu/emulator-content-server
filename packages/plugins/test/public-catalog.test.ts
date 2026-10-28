import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCatalogLoader } from '../src/public-catalog.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ecs-public-catalog-'));
}

test('disk cache is shared between loader instances without another request', async () => {
  const directory = await tempDir();
  try {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response('catalog');
    };
    assert.equal(
      await createCatalogLoader(fetcher, directory).load('https://example.test/shared'),
      'catalog',
    );
    assert.equal(
      await createCatalogLoader(fetcher, directory).load('https://example.test/shared'),
      'catalog',
    );
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('expired and corrupt cache entries are fetched again', async () => {
  const directory = await tempDir();
  try {
    let calls = 0;
    const fetcher: typeof fetch = async () => new Response(`v${++calls}`);
    const originalNow = Date.now;
    const start = originalNow();
    await createCatalogLoader(fetcher, directory).load('https://example.test/expiry');
    const loader = createCatalogLoader(fetcher, directory);
    try {
      Date.now = () => start + 6 * 60 * 60 * 1000 + 60_000;
      assert.equal(await loader.load('https://example.test/expiry', undefined, 3), 'v2');
      assert.equal(calls, 2);
    } finally {
      Date.now = originalNow;
    }
    const files = await (await import('node:fs/promises')).readdir(directory);
    for (const file of files) await writeFile(join(directory, file), 'broken');
    Date.now = () => originalNow() + 13 * 60 * 60 * 1000;
    try {
      assert.equal(
        await createCatalogLoader(fetcher, directory).load('https://example.test/expiry'),
        'v3',
      );
    } finally {
      Date.now = originalNow;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('body and metadata must match before a disk cache hit', async () => {
  const directory = await tempDir();
  try {
    let calls = 0;
    const fetcher: typeof fetch = async () => new Response(`v${++calls}`);
    await createCatalogLoader(fetcher, directory).load('https://example.test/hash-check');
    const files = await (await import('node:fs/promises')).readdir(directory);
    const bodyFile = files.find((name) => name.endsWith('.body'));
    assert.ok(bodyFile);
    await writeFile(join(directory, bodyFile), 'tampered');
    assert.equal(
      await createCatalogLoader(fetcher, directory).load('https://example.test/hash-check'),
      'v2',
    );
    assert.equal(calls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('oversized responses reject and are not cached', async () => {
  const directory = await tempDir();
  try {
    let calls = 0;
    const loader = createCatalogLoader(async () => {
      calls++;
      return new Response('12345');
    }, directory);
    await assert.rejects(loader.load('https://example.test/oversized', undefined, 4));
    await assert.rejects(loader.load('https://example.test/oversized', undefined, 4));
    assert.equal(calls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('abort rejects before fetch and on cache hits', async () => {
  const directory = await tempDir();
  try {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const loader = createCatalogLoader(async () => {
      calls++;
      return new Response('should not happen');
    }, directory);
    await assert.rejects(loader.load('https://example.test/aborted', controller.signal));
    assert.equal(calls, 0);
    const cached = createCatalogLoader(async () => new Response('cached'));
    assert.equal(await cached.load('https://example.test/abort-cache'), 'cached');
    await assert.rejects(cached.load('https://example.test/abort-cache', controller.signal));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid URLs and byte limits reject', async () => {
  const loader = createCatalogLoader(async () => new Response('unused'));
  await assert.rejects(loader.load('file:///etc/passwd'));
  await assert.rejects(loader.load('https://user:pass@example.test/private'));
  await assert.rejects(loader.load('https://example.test/limit', undefined, -1));
});

test('404 is cached briefly and redirects and credential URLs are rejected', async () => {
  const directory = await tempDir();
  try {
    let calls = 0;
    const loader = createCatalogLoader(async (_input, init) => {
      calls++;
      assert.equal(init?.redirect, 'error');
      return new Response(null, { status: 404 });
    }, directory);
    assert.equal(await loader.load('https://example.test/missing-404'), null);
    assert.equal(await loader.load('https://example.test/missing-404'), null);
    assert.equal(calls, 1);
    await assert.rejects(loader.load('https://user:pass@example.test/a'));
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('transport and non-404 HTTP errors reject; injected fetchers do not share memory cache', async () => {
  const first = createCatalogLoader(async () => new Response('first'));
  assert.equal(await first.load('https://example.test/isolation'), 'first');
  let calls = 0;
  const second = createCatalogLoader(async () => {
    calls++;
    throw new Error('offline');
  });
  await assert.rejects(second.load('https://example.test/isolation'));
  await assert.rejects(
    createCatalogLoader(async () => new Response('unavailable', { status: 503 })).load(
      'https://example.test/503',
    ),
  );
  assert.equal(calls, 1);
});

test('symlink cache entries are ignored and never followed', async () => {
  const directory = await tempDir();
  const outside = await tempDir();
  try {
    let calls = 0;
    const loader = createCatalogLoader(async () => {
      calls++;
      return new Response('fresh');
    }, directory);
    await loader.load('https://example.test/symlink');
    const files = await (await import('node:fs/promises')).readdir(directory);
    const bodyFile = files.find((name) => name.endsWith('.body'));
    assert.ok(bodyFile);
    await rm(join(directory, bodyFile));
    await writeFile(join(outside, 'target'), 'private');
    await symlink(join(outside, 'target'), join(directory, bodyFile));
    const originalNow = Date.now;
    Date.now = () => originalNow() + 6 * 60 * 60 * 1000 + 60_000;
    try {
      assert.equal(
        await createCatalogLoader(async () => {
          calls++;
          return new Response('fresh2');
        }, directory).load('https://example.test/symlink'),
        'fresh2',
      );
      assert.equal(calls, 2);
    } finally {
      Date.now = originalNow;
    }
    assert.equal(
      await (await import('node:fs/promises')).readFile(join(outside, 'target'), 'utf8'),
      'private',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
