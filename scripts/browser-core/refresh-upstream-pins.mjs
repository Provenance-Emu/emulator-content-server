#!/usr/bin/env node
/** Refresh known catalog specifications only after strict production-sandbox audit succeeds. */
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { upstreamCorePins } from '../../apps/server/dist/src/player-catalog-upstream-data.js';
export function refreshedPin(pin, record, smoke, date) {
  const core = pin.module.replace(/_libretro\.wasm$/, '');
  if (
    record?.core !== core ||
    smoke?.core !== core ||
    !smoke.ok ||
    smoke.origin !== 'null' ||
    !smoke.productionSandbox ||
    smoke.pageErrors.length ||
    smoke.unexpectedRequests.length
  )
    throw new Error(`Production opaque startup not established: ${core}`);
  const { js, wasm } = record.artifacts;
  if (
    !js ||
    !wasm ||
    !record.info ||
    [js, wasm].some(
      (artifact) => artifact.status !== 'downloaded' || !/^[a-f0-9]{64}$/.test(artifact.sha256),
    )
  )
    throw new Error(`Missing immutable byte pins: ${core}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Explicit audit date required');
  return {
    ...pin,
    buildVersion: `web.libretro.com ${date}`,
    loaderBytes: js.bytes,
    loaderSha256: js.sha256,
    wasmBytes: wasm.bytes,
    wasmSha256: wasm.sha256,
    sourceInfo: record.info.url,
    infoSha256: record.info.sha256,
    license: record.info.fields.license,
    firmware: Object.entries(record.info.fields)
      .filter(([key]) => /^firmware\d+_path$/.test(key))
      .map(([key, path]) => ({
        path,
        optional: record.info.fields[key.replace('_path', '_opt')] === 'true',
      })),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5)
    throw new Error(
      'Usage: refresh-upstream-pins.mjs AUDIT_DIRECTORY YYYY-MM-DD NEW_JSON_SNAPSHOT',
    );
  const [directory, date, output] = process.argv.slice(2),
    records = JSON.parse(await readFile(join(directory, 'downloads.json'), 'utf8')),
    smokes = JSON.parse(await readFile(join(directory, 'smokes.json'), 'utf8'));
  const refreshed = [];
  for (const pin of upstreamCorePins) {
    const core = pin.module.replace(/_libretro\.wasm$/, ''),
      record = records.find((row) => row.core === core);
    const next = refreshedPin(
      pin,
      record,
      smokes.find((row) => row.core === core),
      date,
    );
    for (const [extension, cap] of [
      ['js', 8 * 1024 * 1024],
      ['wasm', 64 * 1024 * 1024],
    ]) {
      const path = join(directory, 'pairs', `${core}_libretro.${extension}`),
        metadata = await stat(path),
        expected = record.artifacts[extension];
      if (!metadata.isFile() || metadata.size !== expected.bytes || metadata.size > cap)
        throw new Error('Artifact size changed since audit');
      if (
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex') !== expected.sha256
      )
        throw new Error('Artifact hash changed since audit');
    }
    refreshed.push(next);
  }
  await writeFile(output, `${JSON.stringify(refreshed, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ profiles: refreshed.length, output }));
}
