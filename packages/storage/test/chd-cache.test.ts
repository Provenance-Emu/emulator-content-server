import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import nativeFs from 'node:fs';
import fs, { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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

// Observe real filesystem streams, leaving the decoder, cache validation and
// range reader intact. A warm lookup must never stream an entire sibling BIN.
test('unchanged published groups reuse verification for selected entries and ranged reads', async (t) => {
  const f = await cacheFixture();
  let hashes = 0;
  const original = nativeFs.createReadStream;
  t.mock.method(nativeFs, 'createReadStream', (...args: Parameters<typeof original>) => {
    if (String(args[0]).includes('virtual-cache') && args[1] === undefined) hashes += 1;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const seed = await openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
    assert.ok(seed);
    assert.ok(hashes >= 2, 'publication verifies both generated artifacts');
    hashes = 0;
    for (const id of ['0', '1', '0', '1']) {
      const opened = await openVirtualEntry(f.root, f.blob.sha256, f.registry, id);
      assert.ok(opened);
      const chunks: Buffer[] = [];
      for await (const chunk of new FileContentReader(opened.path, opened.size).openRange(13, 31))
        chunks.push(Buffer.from(chunk));
      assert.deepEqual(
        Buffer.concat(chunks),
        id === '0' ? Buffer.from(CUE).subarray(13, 32) : Buffer.alloc(19, 37),
      );
    }
    assert.equal(hashes, 0, 'warm selected-entry and range opens must not rehash any artifacts');
    assert.equal(f.decodes(), 1);

    const cold = new VirtualProviderRegistry([f.provider], QUOTA);
    assert.ok(await openVirtualEntry(f.root, f.blob.sha256, cold, '0'));
    assert.equal(hashes, 2, 'a cold registry verifies every artifact once');
    assert.ok(await openVirtualEntry(f.root, f.blob.sha256, cold, '1'));
    assert.equal(hashes, 2, 'the cold registry reuses its successful verification');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await f.cleanup();
  }
});

test('warm DVD range opens do not stream the complete ISO again', async (t) => {
  const f = await fixture(synthetic(), (exe, args, options) => {
    const child = probeRunner(exe, args, options);
    if (args[0] === 'help') return child;
    return {
      ...child,
      exited: writeFile(join(options.cwd, 'disc.iso'), Buffer.alloc(4096, 37)).then(() => ({
        code: 0,
      })),
    };
  });
  try {
    await ensureLayout(f.root);
    const blob = await placeBlob(f.root, f.path);
    const registry = new VirtualProviderRegistry([f.provider], QUOTA);
    const seed = await openVirtualEntry(f.root, blob.sha256, registry, '0');
    assert.ok(seed);
    let hashes = 0;
    const original = nativeFs.createReadStream;
    t.mock.method(nativeFs, 'createReadStream', (...args: Parameters<typeof original>) => {
      if (args[0] === seed.path && args[1] === undefined) hashes += 1;
      return original(...args);
    });
    syncBuiltinESMExports();
    for (let index = 0; index < 3; index++) {
      const opened = await openVirtualEntry(f.root, blob.sha256, registry, '0');
      assert.ok(opened);
      const chunks: Buffer[] = [];
      for await (const chunk of new FileContentReader(opened.path, opened.size).openRange(13, 31))
        chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(19, 37));
    }
    assert.equal(hashes, 0, 'small DVD ranges must not hash the full ISO');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await f.cleanup();
  }
});

test('a group changed after one artifact was hashed cannot memoize that earlier verification', async (t) => {
  const f = await cacheFixture();
  try {
    const seed = await openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
    assert.ok(seed);
    const cue = join(dirname(seed.path), 'disc.cue');
    const original = nativeFs.createReadStream;
    let changed = false;
    t.mock.method(nativeFs, 'createReadStream', (...args: Parameters<typeof original>) => {
      if (args[0] === seed.path && !changed) {
        changed = true;
        // CUE was already hashed; mutate it before validation completes BIN.
        nativeFs.writeFileSync(cue, Buffer.alloc(Buffer.byteLength(CUE), 0));
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    const cold = new VirtualProviderRegistry([f.provider], QUOTA);
    assert.ok(await openVirtualEntry(f.root, f.blob.sha256, cold, '0'));
    assert.equal(changed, true);
    assert.equal(await readFile(cue, 'utf8'), CUE);
    assert.equal(f.decodes(), 2, 'concurrent modification invalidates and repairs the whole group');
    assert.ok(await openVirtualEntry(f.root, f.blob.sha256, cold, '0'));
    assert.equal(await readFile(cue, 'utf8'), CUE);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await f.cleanup();
  }
});

for (const mode of ['cancel', 'shutdown'] as const) {
  test(`warm validation still respects ${mode} during filesystem identity checks`, async (t) => {
    const f = await cacheFixture();
    try {
      const seed = await openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
      assert.ok(seed);
      const controller = new AbortController();
      const original = fs.lstat;
      t.mock.method(fs, 'lstat', async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        if (args[0] === seed.path) {
          if (mode === 'cancel') controller.abort();
          else void f.registry.close();
        }
        return result;
      });
      syncBuiltinESMExports();
      await assert.rejects(
        openVirtualEntry(f.root, f.blob.sha256, f.registry, '0', f.root, controller.signal),
        /cancelled|closed/i,
      );
      assert.equal(f.decodes(), 1);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await f.registry.close();
      await f.cleanup();
    }
  });
}

for (const mode of [
  'manifest',
  'missing-manifest',
  'manifest-symlink',
  'version',
  'hash',
  'restored-mtime',
  'truncated',
  'symlink',
  'extra',
] as const) {
  test(`cache rejects stale or invalid ${mode} and re-extracts the complete group`, async () => {
    const f = await cacheFixture();
    try {
      const bin = await openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
      assert.ok(bin);
      const manifestPath = join(dirname(bin.path), 'manifest.json');
      if (mode === 'manifest') await writeFile(manifestPath, '{}');
      if (mode === 'missing-manifest') await rm(manifestPath);
      if (mode === 'manifest-symlink') {
        await rm(manifestPath);
        await symlink(f.blob.path, manifestPath);
      }
      if (mode === 'extra') await writeFile(join(dirname(bin.path), 'unexpected'), 'extra');
      if (mode === 'restored-mtime') {
        const before = await fs.stat(bin.path);
        await writeFile(bin.path, Buffer.alloc(4400, 0));
        await fs.utimes(bin.path, before.atime, before.mtime);
      }
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
      files.some((name) => name.includes('.partial-') || name.endsWith('.lock')),
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
      files.some((name) => name.includes('.partial-') || name.endsWith('.lock')),
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
      files.some(
        (name) =>
          name.includes('.partial-') || name.endsWith('.lock') || name.endsWith('manifest.json'),
      ),
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
      names.some((name) => name.includes('.partial-') || name.endsWith('.lock')),
      false,
    );
    await rejected;
  } finally {
    await f.cleanup();
  }
});

// Schedule the stale validation/discard race at filesystem boundaries while
// keeping real directories, manifests, hashes and published reader paths.
test('concurrent repair cannot discard a valid winner after observing an older invalid group', async (t) => {
  const f = await cacheFixture();
  const gate = () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { wait, release };
  };
  const firstDiscard = gate();
  const firstMayDiscard = gate();
  const secondBlocked = gate();
  const secondMayDiscard = gate();
  const secondRemoved = gate();
  const secondMayFinish = gate();
  let removals = 0;
  let secondReachedDiscard = false;
  let first: ReturnType<typeof openVirtualEntry> | undefined;
  let second: ReturnType<typeof openVirtualEntry> | undefined;
  try {
    const seeded = await openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
    assert.ok(seeded);
    const directory = dirname(seeded.path);
    await writeFile(join(directory, 'manifest.json'), '{}');
    const originalRename = fs.rename;
    const originalMkdir = fs.mkdir;
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      const [source, destination] = args;
      if (source === directory && String(destination).endsWith('.invalid')) {
        removals += 1;
        if (removals === 1) {
          firstDiscard.release();
          await firstMayDiscard.wait;
        } else {
          secondReachedDiscard = true;
          secondBlocked.release();
          await secondMayDiscard.wait;
          await originalRename(...args);
          secondRemoved.release();
          await secondMayFinish.wait;
          return;
        }
      }
      return originalRename(...args);
    });
    t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
      try {
        return await originalMkdir(...args);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'EEXIST' &&
          String(args[0]).startsWith(`${directory}.`)
        )
          secondBlocked.release();
        throw error;
      }
    });
    syncBuiltinESMExports();
    first = openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
    await Promise.race([
      firstDiscard.wait,
      first.then(() => {
        throw new Error('Invalid group was accepted without repair');
      }),
    ]);
    const other = new VirtualProviderRegistry([f.provider], QUOTA);
    second = openVirtualEntry(f.root, f.blob.sha256, other, '1');
    await Promise.race([
      secondBlocked.wait,
      second.then(() => {
        throw new Error('Second repair bypassed arbitration');
      }),
    ]);
    firstMayDiscard.release();
    const winner = await first;
    assert.ok(winner);
    const winnerInfo = await fs.stat(winner.path);
    assert.deepEqual(await readFile(winner.path), Buffer.alloc(4400, 37));
    secondMayDiscard.release();
    // The buggy writer removes the winner here before being allowed to publish
    // another group. A coordinated writer instead completes using that winner.
    const settled = second.then(() => 'complete' as const);
    const event = await Promise.race([secondRemoved.wait.then(() => 'removed' as const), settled]);
    assert.deepEqual(await readFile(winner.path), Buffer.alloc(4400, 37));
    assert.equal((await fs.stat(winner.path)).ino, winnerInfo.ino);
    assert.equal(event, 'complete');
    assert.equal(secondReachedDiscard, false);
    const otherWinner = await second;
    assert.equal(otherWinner?.path, winner.path);
  } finally {
    firstMayDiscard.release();
    secondMayDiscard.release();
    secondMayFinish.release();
    await Promise.allSettled([first, second]);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await f.cleanup();
  }
});

test('independent processes serialize invalid-group repair and preserve every returned winner', async () => {
  const f = await cacheFixture();
  const children: ReturnType<typeof fork>[] = [];
  const exits: Promise<number | null>[] = [];
  let decodes = 0;
  try {
    const seed = await openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
    assert.ok(seed);
    await writeFile(join(dirname(seed.path), 'manifest.json'), '{}');
    const requests = Array.from({ length: 2 }, () => {
      const child = fork(
        new URL('./chd-cache-process.js', import.meta.url),
        [f.root, f.blob.sha256],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      );
      children.push(child);
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
      exits.push(exit);
      let ready: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const result = new Promise<{ path: string; ino: number }>((resolve, reject) => {
        child.on('error', reject);
        child.on('message', (message) => {
          const value = message as { kind: string; path: string; ino: number; error: string };
          if (value.kind === 'ready') ready();
          if (value.kind === 'decode') decodes += 1;
          if (value.kind === 'result') resolve(value);
          if (value.kind === 'error') reject(new Error(value.error));
        });
        void exit.then((code) => {
          if (code !== 0) reject(new Error(`Cache worker failed: ${stderr}`));
        });
      });
      return { child, started, result };
    });
    await Promise.all(
      requests.map((request) =>
        Promise.race([
          request.started,
          request.result.then(() => {
            throw new Error('Cache worker returned before its open request');
          }),
        ]),
      ),
    );
    for (const request of requests) request.child.send('open');
    const winners = await Promise.all(requests.map((request) => request.result));
    assert.equal(decodes, 1);
    for (const winner of winners) {
      assert.equal(winner.path, seed.path);
      assert.deepEqual(await readFile(winner.path), Buffer.alloc(4400, 37));
      assert.equal((await fs.stat(winner.path)).ino, winner.ino);
    }
    assert.deepEqual(await Promise.all(exits), [0, 0]);
    const names = await readdir(f.root, { recursive: true });
    assert.equal(
      names.some((name) => name.includes('.partial-') || name.endsWith('.lock')),
      false,
    );
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.all(exits);
    await f.cleanup();
  }
});

test('an abandoned foreign lock spends the operation deadline without being reclaimed', async () => {
  const f = await cacheFixture();
  try {
    const seed = await openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
    assert.ok(seed);
    const directory = dirname(seed.path);
    const lock = `${directory}.lock`;
    await rm(directory, { recursive: true });
    await mkdir(lock);
    await writeFile(join(lock, 'foreign-owner'), 'paused owner');
    const registry = new VirtualProviderRegistry([f.provider], { ...QUOTA, timeoutMs: 100 });
    await assert.rejects(
      openVirtualEntry(f.root, f.blob.sha256, registry, '1'),
      /timed out|cancelled/i,
    );
    assert.equal(f.decodes(), 1);
    assert.equal(await readFile(join(lock, 'foreign-owner'), 'utf8'), 'paused owner');
    assert.equal(
      (await readdir(dirname(directory))).some((name) => name.includes('.partial-')),
      false,
    );
    // Test-owner recovery follows the same precondition as operator recovery:
    // stop all writers before removing an abandoned foreign lock.
    await rm(lock, { recursive: true });
    const restored = await openVirtualEntry(f.root, f.blob.sha256, f.registry, '1');
    assert.ok(restored);
    assert.deepEqual(await readFile(restored.path), Buffer.alloc(4400, 37));
    assert.equal(f.decodes(), 2);
    await registry.close();
  } finally {
    await f.cleanup();
  }
});

for (const mode of ['retry', 'cancel', 'shutdown', 'deadline']) {
  test(`a late requester respects ${mode} after the cancelled flight finishes cleanup`, async () => {
    const { openChdBundle } = await import('../src/chd-cache.js');
    const f = await cacheFixture();
    let start: () => void = () => {};
    let aborted: () => void = () => {};
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const provider: VirtualContentProvider = {
      ...f.provider,
      async materializeBundle(...args) {
        calls++;
        if (calls === 1) {
          start();
          args[4]?.addEventListener('abort', aborted, { once: true });
          await cancelled;
          await cleanup;
          throw new Error('cancelled flight completed cleanup');
        }
        assert.ok(f.provider.materializeBundle);
        return f.provider.materializeBundle(...args);
      },
    };
    const registry = new VirtualProviderRegistry([provider], QUOTA);
    try {
      const layout = await registry.inspect(f.blob.path);
      assert.ok(layout?.entries[0]);
      assert.ok(layout.entries[1]);
      const controller = new AbortController();
      const first = openChdBundle(
        f.root,
        f.blob.sha256,
        registry,
        'chd',
        f.blob.path,
        'disc',
        layout.entries[0],
        controller.signal,
      );
      const rejected = assert.rejects(first, /cancelled/);
      await started;
      controller.abort();
      await cancelled;
      // Enter directly at the bundle join seam while the cancelled job owns cleanup.
      const secondController = new AbortController();
      const second = openChdBundle(
        f.root,
        f.blob.sha256,
        registry,
        'chd',
        f.blob.path,
        'disc',
        layout.entries[1],
        secondController.signal,
        performance.now() + (mode === 'deadline' ? 20 : QUOTA.timeoutMs),
      );
      const outcome =
        mode === 'retry' ? second : assert.rejects(second, /cancelled|timed out|closed/);
      if (mode === 'cancel') secondController.abort();
      const closing = mode === 'shutdown' ? registry.close() : Promise.resolve();
      if (mode === 'deadline') await new Promise((resolve) => setTimeout(resolve, 40));
      release();
      await rejected;
      const bin = await outcome;
      await closing;
      if (mode === 'retry') {
        assert.ok(bin);
        assert.deepEqual(await readFile(bin.path), Buffer.alloc(4400, 37));
        assert.equal(calls, 2);
      } else assert.equal(calls, 1);
    } finally {
      release();
      await registry.close();
      await f.cleanup();
    }
  });
}
