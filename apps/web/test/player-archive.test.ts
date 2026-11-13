import assert from 'node:assert/strict';
import test from 'node:test';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js/index-native.js';
import { extractPlayerZip } from '../src/player/archive.js';
import { preparePlayer } from '../src/player/preflight.js';
import { decodeSevenZip } from '../src/player/seven-zip.js';
import { fixture } from './player-fixture.js';

async function archive(files: Record<string, Uint8Array>) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, bytes] of Object.entries(files))
    await writer.add(name, new Uint8ArrayReader(bytes));
  return writer.close();
}
test('browser play extracts one compatible cartridge from a bounded ZIP', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const zip = await archive({ 'Folder/Game.NES': bytes, 'readme.txt': new Uint8Array([5]) });
  const extracted = await extractPlayerZip(zip, ['nes'], 1024);
  assert.equal(extracted.extension, 'nes');
  assert.deepEqual(extracted.bytes, bytes);
  await assert.rejects(extractPlayerZip(zip, ['gb'], 1024), /no game file supported/);
  await assert.rejects(extractPlayerZip(zip, ['nes'], 3), /size limit/);
});
test('ZIP playback refuses ambiguous games, disc references and cancelled work', async () => {
  const bytes = new Uint8Array([1, 2]);
  await assert.rejects(
    extractPlayerZip(await archive({ 'one.nes': bytes, 'two.nes': bytes }), ['nes'], 1024),
    /multiple game files/,
  );
  await assert.rejects(
    extractPlayerZip(await archive({ 'disc.cue': bytes, 'track.bin': bytes }), ['bin'], 1024),
    /disc set/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    extractPlayerZip(await archive({ 'one.nes': bytes }), ['nes'], 1024, controller.signal),
    { name: 'AbortError' },
  );
});

test('normal player preflight prepares ZIP assets and local sources as cartridge bytes', async () => {
  for (const kind of ['asset', 'source'] as const) {
    const f = fixture();
    const rom = new Uint8Array([1, 2, 3]);
    const zip = await archive({ 'game.nes': rom });
    f.source.name = 'game.zip';
    f.source.size = zip.length;
    const file = f.manifest.files[0];
    assert.ok(file);
    file.relativePath = 'game.zip';
    file.size = zip.length;
    f.client.collect = async () => ({ bytes: Uint8Array.from(zip), etag: null });
    f.client.collectSource = async () => ({ bytes: Uint8Array.from(zip), etag: null });
    const prepared = await preparePlayer(
      f.client,
      kind === 'asset'
        ? { kind, itemId: f.item.id, assetId: 'rom' }
        : { kind, sourceId: f.source.id },
      {
        canvas: {} as HTMLCanvasElement,
        importer: f.importer,
      },
    );
    assert.equal(prepared.contentExtension, 'nes');
    assert.deepEqual(prepared.content, rom);
  }
});

// Generated with 7-Zip from text files named .nds. No ROM data is included.
const singleSevenZip =
  'N3q8ryccAAS90wuxDQAAAAAAAABaAAAAAAAAACEGnv8BAAhnYW1lIGRhdGEAAQQGAAEJDQAHCwEAASEhAQAMCQAICgFR6GQ9AAAFARkMAAAAAAAAAAAAAAAAERMAZwBhAG0AZQAuAG4AZABzAAAAGQAUCgEAGA1yCCBz3QEVBgEAIICkgQAA';
const multiSevenZip =
  'N3q8ryccAAQJ6AgsbgAAAAAAAAAgAAAAAAAAAJ5OjPABAAVmb29iYXIAAACBMweuD85vVl76Dfokg9wXd2LyF6CdJkEnhFookZ6OYXMl6x6FMFeF8pPMGdx8P3wdcGUbtzbgvLt/2GSJjMJCcAMr75yV/SZ8vwoQwbpesAFYYsfSiN/BoZqXc46CgAAAABcGCgEJZAAHCwEAASMDAQEFXQAQAAAMdgoBXIYqygAA';

const encryptedSevenZip =
  'N3q8ryccAAQ6pVUSgAAAAAAAAAAuAAAAAAAAAKFysahS69fMCorUtU8yd69ZzhXQHX8ZcOax1zayXHp1LA+LtZK6Vtbgc6NC9gX3wCc4x3UUq//WTL3FiRKLhOOzOfTv8UQ2pvLsRhQEmdG8PFoPw5KsoFU5r3woR/dZtFlgI1SIuzQa36UKANKDKhtEyydm9diGkwd6BtCZecmegUNSgRcGEAEJcAAHCwEAASQG8QcBElMPyO1K+Jc6a/LCOjdLDYEOjwxqCgF6c4rPAAA=';

test('7z playback extracts one supported file and rejects ambiguous, truncated or oversized archives', async () => {
  const single = Buffer.from(singleSevenZip, 'base64');
  const multiple = Buffer.from(multiSevenZip, 'base64');
  const extracted = await decodeSevenZip(single, ['nds'], 1024);
  assert.equal(extracted.extension, 'nds');
  assert.equal(new TextDecoder().decode(extracted.bytes), 'game data');
  await assert.rejects(decodeSevenZip(single, ['nes'], 1024), /no game file supported/);
  await assert.rejects(decodeSevenZip(multiple, ['nds'], 1024), /multiple game files/);
  await assert.rejects(decodeSevenZip(single.subarray(0, -1), ['nds'], 1024), /invalid/i);
  await assert.rejects(decodeSevenZip(single, ['nds'], 64), /size limit/);
  await assert.rejects(
    decodeSevenZip(Buffer.from(encryptedSevenZip, 'base64'), ['nds'], 1024),
    /encrypted|invalid/i,
  );
});
