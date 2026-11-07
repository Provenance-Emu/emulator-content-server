import { lstat, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { SevenZipModuleFactory } from '7z-wasm';
import { preparationLease } from './player-upstream-archive.js';

export interface ArchiveExtraction {
  archive: string;
  output: string;
  files: { file: string; sizeBytes: number }[];
}

/** The parent starts this dedicated process with bounded JS and WASM heaps and a deadline. */
async function extract(input: ArchiveExtraction) {
  const SevenZip = createRequire(import.meta.url)('7z-wasm') as SevenZipModuleFactory;
  let listing = '';
  let listingMode = true;
  const seven = await SevenZip({
    print(line) {
      if (!listingMode) return;
      listing += `${line}\n`;
      if (listing.length > 1024 * 1024) throw new Error('Archive member listing exceeds limit');
    },
    printErr() {},
  });
  seven.FS.mkdir('/input');
  seven.FS.mount(seven.NODEFS, { root: dirname(input.archive) }, '/input');
  seven.FS.mkdir('/output');
  seven.FS.mount(seven.NODEFS, { root: input.output }, '/output');
  const archive = `/input/${basename(input.archive)}`;
  seven.callMain(['l', archive, '-slt', '-bd']);
  const wanted = new Map(input.files.map((file) => [`retroarch/${file.file}`, file.sizeBytes]));
  const found = new Set<string>();
  for (const record of listing.split(/\n\s*\n/)) {
    const path = /^Path = (.+)$/m.exec(record)?.[1];
    if (!path || (!wanted.has(path) && path !== 'retroarch')) continue;
    if (found.has(path) || /^(?:Symbolic Link|Hard Link) =/m.test(record))
      throw new Error('Archive member is ambiguous or is a link');
    const attributes = /^Attributes = (.*)$/m.exec(record)?.[1] ?? '';
    if (/\bl[rwx-]/.test(attributes)) throw new Error('Archive member is a link');
    if (path !== 'retroarch') {
      if (attributes.includes('D') || /^Folder = \+$/m.test(record))
        throw new Error('Archive member is not a file');
      const size = /^Size = (\d+)$/m.exec(record)?.[1];
      if (!size || Number(size) !== wanted.get(path))
        throw new Error('Archive member size mismatch');
    }
    found.add(path);
  }
  if (input.files.some((file) => !found.has(`retroarch/${file.file}`)))
    throw new Error('Archive is missing a pinned member');
  listingMode = false;
  seven.callMain([
    'x',
    archive,
    ...wanted.keys(),
    '-o/output',
    '-y',
    '-bd',
    '-bb0',
    '-mmt=1',
    '-spd',
  ]);
  const root = join(input.output, 'retroarch');
  if (!(await lstat(root)).isDirectory()) throw new Error('Archive output directory is unsafe');
  const names = await readdir(root);
  if (names.length !== input.files.length)
    throw new Error('Archive output contains unexpected members');
  for (const file of input.files) {
    const info = await lstat(join(root, file.file));
    if (!info.isFile() || info.size !== file.sizeBytes)
      throw new Error('Archive output size mismatch');
  }
}

if (isMainThread) {
  process.once('message', (input: ArchiveExtraction) => {
    void runChild(input);
  });
} else {
  void extract(workerData as ArchiveExtraction).then(
    () => {
      parentPort?.postMessage({ ok: true });
    },
    () => {
      parentPort?.postMessage({ ok: false });
    },
  );
}

async function runChild(input: ArchiveExtraction) {
  let release: (() => void) | undefined;
  let worker: Worker | undefined;
  let finished = false;
  const deadline = setTimeout(
    () => {
      process.exit(1);
    },
    3 * 60 * 1000,
  );
  process.once('disconnect', () => {
    if (finished) return;
    if (worker)
      void worker.terminate().finally(() => {
        process.exit(1);
      });
    else process.exit(1);
  });
  try {
    release = await preparationLease(dirname(dirname(input.archive)), '.extract.sqlite');
    if (!process.connected) return;
    worker = new Worker(new URL(import.meta.url), {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    const success = await new Promise<boolean>((resolve, reject) => {
      let ok = false;
      worker?.on('message', (message) => {
        ok = !!message && message.ok === true;
      });
      worker?.once('error', reject);
      worker?.once('exit', (code) => {
        resolve(ok && code === 0);
      });
    });
    process.send?.({ ok: success });
    if (!success) process.exitCode = 1;
  } catch {
    process.send?.({ ok: false });
    process.exitCode = 1;
  } finally {
    finished = true;
    clearTimeout(deadline);
    release?.();
    if (process.connected) process.disconnect();
  }
}
