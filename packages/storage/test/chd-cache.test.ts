import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { VirtualContentProvider } from '@ecs/domain';
import { placeBlob } from '../src/blobs.js';
import { ensureLayout } from '../src/layout.js';
import { FileContentReader } from '../src/reader.js';
import { VirtualProviderRegistry } from '../src/virtual.js';
import { openVirtualEntry } from '../src/virtual-cache.js';
import { fixture, probeRunner, QUOTA, type Runner, synthetic, track } from './chd-fixture.js';

const CUE =
  'FILE "disc.bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:00:01\n';
async function cacheFixture(delay = 0) {
  let decodes = 0;
  const runner: Runner = (exe, args, options) => {
    if (args[0] === 'help') return probeRunner(exe, args, options);
    decodes += 1;
    const child = probeRunner(exe, args, options);
    return {
      ...child,
      exited: (async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        await writeFile(join(options.cwd, 'disc.bin'), Buffer.alloc(4400, 37));
        await writeFile(join(options.cwd, 'tool.cue'), CUE);
        return { code: 0 };
      })(),
    };
  };
  const f = await fixture(synthetic([track(1, 'MODE1', 1), track(2, 'AUDIO', 1)], false), runner);
  await ensureLayout(f.root);
  const blob = await placeBlob(f.root, f.path);
  const registry = new VirtualProviderRegistry([f.provider], QUOTA);
  return { ...f, blob, registry, decodes: () => decodes };
}

test('simultaneous CUE/BIN opens publish one complete group and reuse verified ranged bytes', async () => {
  const f = await cacheFixture(15);
  try {
    const [cue, bin] = await Promise.all(
      ['0', '1'].map((id) => openVirtualEntry(f.root, f.blob.sha256, f.registry, id)),
    );
    assert.ok(cue);
    assert.ok(bin);
    assert.equal(f.decodes(), 1);
    assert.equal(cue.logicalPath, 'disc.cue');
    assert.equal(bin.logicalPath, 'disc.bin');
    assert.equal(dirname(cue.path), dirname(bin.path));
    assert.equal(await readFile(cue.path, 'utf8'), CUE);
    const chunks: Buffer[] = [];
    for await (const chunk of new FileContentReader(bin.path, bin.size).openRange(13, 31))
      chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(19, 37));
    assert.equal((await openVirtualEntry(f.root, f.blob.sha256, f.registry, '1'))?.path, bin.path);
    assert.equal(f.decodes(), 1);
    const manifest = JSON.parse(await readFile(join(dirname(bin.path), 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, 'chd-v1');
    assert.equal(manifest.files.length, 2);
    assert.equal(
      manifest.files[1].sha256,
      createHash('sha256').update(Buffer.alloc(4400, 37)).digest('hex'),
    );
  } finally {
    await f.cleanup();
  }
});

for (const mode of ['manifest', 'version', 'hash', 'truncated', 'symlink'] as const) {
  test(`cache rejects stale or invalid ${mode} and re-extracts the complete group`, async () => {
    const f = await cacheFixture();
    try {
      const bin = await openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
      assert.ok(bin);
      const manifestPath = join(dirname(bin.path), 'manifest.json');
      if (mode === 'manifest') await writeFile(manifestPath, '{}');
      if (mode === 'version') {
        const m = JSON.parse(await readFile(manifestPath, 'utf8'));
        m.version = 'chd-v0';
        await writeFile(manifestPath, JSON.stringify(m));
      }
      if (mode === 'hash') await writeFile(bin.path, Buffer.alloc(4400, 0));
      if (mode === 'truncated') await writeFile(bin.path, Buffer.alloc(2));
      if (mode === 'symlink') {
        await rm(bin.path);
        await symlink(f.blob.path, bin.path);
      }
      const rebuilt = await openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
      assert.ok(rebuilt);
      assert.deepEqual(await readFile(rebuilt.path), Buffer.alloc(4400, 37));
      assert.equal(f.decodes(), 2);
    } finally {
      await f.cleanup();
    }
  });
}

test('independent registries atomically validate the winning complete group', async () => {
  const f = await cacheFixture(15);
  try {
    const other = new VirtualProviderRegistry([f.provider], QUOTA);
    const [a, b] = await Promise.all(
      [f.registry, other].map((registry) => openVirtualEntry(f.root, f.blob.sha256, registry, '1')),
    );
    assert.ok(a);
    assert.ok(b);
    assert.equal(a.path, b.path);
    assert.deepEqual(await readFile(a.path), Buffer.alloc(4400, 37));
    const files = await readdir(join(f.root, 'virtual-cache'), { recursive: true });
    assert.equal(
      files.some((name) => name.endsWith('.partial')),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test('bundle nested after an expansion or exposed as a window is explicitly refused', async () => {
  const f = await cacheFixture();
  const zip: VirtualContentProvider = {
    format: 'outer',
    async inspect() {
      return null;
    },
    async resolve(path) {
      return path === f.blob.path
        ? { kind: 'expand', entryId: '0', remainder: '0', path: 'nested' }
        : null;
    },
    async materialize(_path, _id, dest) {
      const bytes = await readFile(f.blob.path);
      await writeFile(dest, bytes);
      return { size: bytes.length, sha256: f.blob.sha256 };
    },
  };
  try {
    const registry = new VirtualProviderRegistry([zip, f.provider], QUOTA);
    await assert.rejects(
      openVirtualEntry(f.root, f.blob.sha256, registry, '0.0'),
      /nested|expansion/i,
    );
    assert.equal(f.decodes(), 0);
    await assert.rejects(
      f.registry.inspect(f.blob.path, { offset: 0, length: 124 }),
      /nested|window/i,
    );
  } finally {
    await f.cleanup();
  }
});

test('registry closes owned providers and dispatches bundle quotas', async () => {
  const f = await cacheFixture();
  try {
    const bin = await openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
    assert.ok(bin);
    assert.equal(typeof (f.registry as unknown as { close?: unknown }).close, 'function');
    await (f.registry as unknown as { close(): Promise<void> }).close();
    await rm(dirname(bin.path), { recursive: true });
    await assert.rejects(openVirtualEntry(f.root, f.blob.sha256, f.registry, '1'), /closed/i);
  } finally {
    await f.cleanup();
  }
});

test('disconnecting one bundle waiter leaves the other download alive', async () => {
  const f = await cacheFixture(100);
  try {
    const controller = new AbortController();
    const first = openVirtualEntry(
      f.root,
      f.blob.sha256,
      f.registry,
      '0',
      f.root,
      controller.signal,
    );
    const rejected = assert.rejects(first, /cancelled/i);
    const second = openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await rejected;
    const bin = await second;
    assert.ok(bin);
    assert.deepEqual(await readFile(bin.path), Buffer.alloc(4400, 37));
    assert.equal(f.decodes(), 1);
  } finally {
    await f.cleanup();
  }
});

test('the last cancelled waiter joins extraction before removing all private staging', async () => {
  const f = await cacheFixture(100);
  try {
    const controller = new AbortController();
    const pending = openVirtualEntry(
      f.root,
      f.blob.sha256,
      f.registry,
      '0',
      f.root,
      controller.signal,
    );
    const rejected = assert.rejects(pending, /cancelled/i);
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await rejected;
    const files = await readdir(f.root, { recursive: true });
    assert.equal(
      files.some((name) => name.includes('.partial-')),
      false,
    );
    assert.equal(
      files.some((name) => name.endsWith('manifest.json')),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test('a failed extraction never publishes a complete manifest', async () => {
  const f = await cacheFixture();
  const provider: VirtualContentProvider = {
    ...f.provider,
    async materializeBundle(_path, _id, destination) {
      await writeFile(join(destination, 'side'), 'failed');
      throw new Error('synthetic extraction failure');
    },
  };
  try {
    await assert.rejects(
      openVirtualEntry(f.root, f.blob.sha256, new VirtualProviderRegistry([provider], QUOTA), '0'),
    );
    const files = await readdir(f.root, { recursive: true });
    assert.equal(
      files.some((name) => name.includes('.partial-') || name.endsWith('manifest.json')),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test('representation versions cannot reuse an older group even when its artifacts are valid', async () => {
  const f = await cacheFixture();
  try {
    const bin = await openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
    assert.ok(bin);
    const current = dirname(bin.path);
    const oldKey = createHash('sha256')
      .update(JSON.stringify([f.blob.sha256, 'chd', 'chd-v0', 'disc']))
      .digest('hex');
    const old = join(dirname(current), oldKey);
    await mkdir(old);
    for (const name of ['disc.cue', 'disc.bin', 'manifest.json'])
      await writeFile(join(old, name), await readFile(join(current, name)));
    await rm(current, { recursive: true });
    const rebuilt = await openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
    assert.ok(rebuilt);
    assert.equal(rebuilt.path, bin.path);
    assert.notEqual(dirname(rebuilt.path), old);
    assert.equal(f.decodes(), 2);
  } finally {
    await f.cleanup();
  }
});

test('registry shutdown joins cache jobs and removes their private staging before returning', async () => {
  const f = await cacheFixture();
  let begin: () => void = () => {};
  const begun = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const provider: VirtualContentProvider = {
    ...f.provider,
    async materializeBundle(_path, _id, destination, _quota, signal) {
      await writeFile(join(destination, 'side'), 'pending');
      begin();
      await new Promise((resolve) => {
        const abort = () => setTimeout(resolve, 40);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      throw new Error('cancelled synthetic native work');
    },
  };
  const registry = new VirtualProviderRegistry([provider], QUOTA);
  try {
    const pending = openVirtualEntry(f.root, f.blob.sha256, registry, '0');
    const rejected = assert.rejects(pending);
    await begun;
    await registry.close();
    const names = await readdir(f.root, { recursive: true });
    assert.equal(
      names.some((name) => name.includes('.partial-')),
      false,
    );
    await rejected;
  } finally {
    await f.cleanup();
  }
});
