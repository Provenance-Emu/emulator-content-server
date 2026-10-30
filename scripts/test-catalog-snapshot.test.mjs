import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { loadMetadataSnapshot } from './catalog-snapshot.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const xml =
  Buffer.from(`<?xml version="1.0"?><datafile><header><version>2026-10-23</version></header>
<game name="Example &amp; Game (USA) (Unl) (Alt 1)"><rom name="Example &amp; Game (USA) (Unl) (Alt 1).cue" size="7" crc="12345678" md5="${'1'.repeat(32)}" sha1="${'2'.repeat(40)}"/><rom name="Example &amp; Game (USA) (Unl) (Alt 1) (Track 01).bin" size="16" crc="abcdef01" md5="${'3'.repeat(32)}" sha1="${'4'.repeat(40)}"/><rom name="Example &amp; Game (USA) (Unl) (Alt 1) (Track 02).bin" size="32" crc="87654321" md5="${'5'.repeat(32)}" sha1="${'6'.repeat(40)}"/></game></datafile>`);
function archive(bytes = xml) {
  const name = Buffer.from('snapshot.dat');
  const compressed = deflateRawSync(bytes);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(crc32(bytes), 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, compressed]);
}
const bytes = archive();
const snapshot = {
  sourceId: 'redump-fixture',
  sourceName: 'Generated DAT',
  url: 'https://example.com/datfile/',
  revision: '2026-10-23',
  systemId: 'com.provenance.jaguarcd',
  license: 'CC0-1.0 generated test data',
  notice: 'Generated fixture.',
  archive: { filename: 'snapshot.zip', bytes: bytes.length, sha256: digest(bytes) },
  dat: { filename: 'snapshot.dat', bytes: xml.length, sha256: digest(xml), records: 1 },
};
test('snapshot verifies both pins and retains one first-track fact per full release name', async () => {
  const loaded = await loadMetadataSnapshot(snapshot, { fetcher: async () => new Response(bytes) });
  assert.deepEqual(loaded.records, [
    {
      title: 'Example & Game (USA) (Unl) (Alt 1)',
      name: 'Example & Game (USA) (Unl) (Alt 1) (Track 01).bin',
      size: 16,
      crc32: 'abcdef01',
      md5: '3'.repeat(32),
      sha1: '4'.repeat(40),
    },
  ]);
  assert.deepEqual(loaded.receipt, {
    sourceId: snapshot.sourceId,
    url: snapshot.url,
    revision: snapshot.revision,
    archive: snapshot.archive,
    dat: snapshot.dat,
  });
  assert.deepEqual(loaded.archiveBytes, bytes);
});
test('snapshot rejects changed archives, changed DAT pins, oversized declarations and wrong record counts', async () => {
  for (const altered of [
    { ...snapshot, archive: { ...snapshot.archive, sha256: '0'.repeat(64) } },
    { ...snapshot, dat: { ...snapshot.dat, sha256: '0'.repeat(64) } },
    { ...snapshot, archive: { ...snapshot.archive, bytes: 2 * 1024 * 1024 } },
    { ...snapshot, dat: { ...snapshot.dat, bytes: 2 * 1024 * 1024 } },
    { ...snapshot, dat: { ...snapshot.dat, records: 2 } },
  ])
    await assert.rejects(
      loadMetadataSnapshot(altered, { fetcher: async () => new Response(bytes) }),
    );
});
test('snapshot never treats a later audio track or a descriptor checksum as the game fingerprint', async () => {
  const badXml = Buffer.from(xml.toString().replace('(Track 01)', '(Track 03)'));
  const badArchive = archive(badXml);
  await assert.rejects(
    loadMetadataSnapshot(
      {
        ...snapshot,
        archive: { ...snapshot.archive, bytes: badArchive.length, sha256: digest(badArchive) },
        dat: { ...snapshot.dat, bytes: badXml.length, sha256: digest(badXml) },
      },
      { fetcher: async () => new Response(badArchive) },
    ),
    /first track/,
  );
});

test('complete release titles retain one exact automatic candidate across alternate, demo and reissue siblings', async () => {
  const { matchLibretro, automaticEvidence } = await import(
    '../packages/plugins/dist/src/matching.js'
  );
  const titles = [
    '',
    ' (Alt 1)',
    ' (Alt 2)',
    ' (Demo)',
    ' (Demo) (Alt)',
    ' (Unl)',
    ' (Songbird)',
    ' (Rev 1)',
  ].map((tag) => `Generated Disc (USA)${tag}`);
  const records = titles.map((title, index) => ({
    title,
    name: `${title} (Track 01).bin`,
    size: 16 + index,
    crc32: index.toString(16).padStart(8, '0'),
    systemId: 'com.provenance.jaguarcd',
  }));
  for (const title of titles) {
    const input = {
      name: `${title}.cue`,
      systemId: 'com.provenance.jaguarcd',
      companions: [],
      allowExactNames: true,
    };
    const automatic = matchLibretro(input, records).filter((row) => automaticEvidence(input, row));
    assert.equal(automatic.length, 1, title);
    assert.equal(automatic[0].title, title);
    assert.equal(automatic[0].metadata.romName, `${title} (Track 01).bin`);
    assert.equal(automaticEvidence({ ...input, allowExactNames: false }, automatic[0]), false);
  }
});
