#!/usr/bin/env node
/** Fresh official pair pins and startup through the unchanged production opaque sandbox. */
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boundedDownload,
  LIBRETRO_LIMITS,
  LIBRETRO_WEB,
  parseCoreInfo,
  parseCoreList,
} from './libretro-audit.mjs';
import { smokeLibretroPairs } from './libretro-runtime-audit.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const match = /^--(cores|output)=(.+)$/.exec(argument);
    if (!match)
      throw new Error(
        'Usage: audit-libretro-web.mjs [--cores=core,core] [--output=NEW_EXTERNAL_DIRECTORY]',
      );
    return [match[1], match[2]];
  }),
);
const output = resolve(
  options.output ?? join(homedir(), '.cache', `ecs-libretro-audit-${Date.now()}`),
);
const actualParent = await realpath(resolve(output, '..'));
const within = relative(repository, join(actualParent, output.split(/[\\/]/).at(-1)));
if (!isAbsolute(within) && within !== '..' && !within.startsWith('../'))
  throw new Error('Audit output must be outside repository');
await mkdir(output);
const artifacts = join(output, 'pairs');
await mkdir(artifacts);
const selector = await boundedDownload(`${LIBRETRO_WEB}/core_list.js`, 1024 * 1024);
await writeFile(join(output, 'core_list.js'), selector.bytes);
const selectorCores = parseCoreList(selector.bytes.toString('utf8'));
const cores = options.cores ? [...new Set(options.cores.split(','))] : selectorCores;
if (!cores.length || cores.some((core) => !/^[A-Za-z0-9_]{1,80}$/.test(core)))
  throw new Error('Invalid core selection');
const revisionResponse = await boundedDownload(
  'https://api.github.com/repos/libretro/libretro-super/commits/master',
  1024 * 1024,
);
const infoRevision = JSON.parse(revisionResponse.bytes).sha;
if (!/^[a-f0-9]{40}$/.test(infoRevision)) throw new Error('Missing immutable core-info revision');
const records = [];
let cursor = 0;
async function fetchWorker() {
  while (cursor < cores.length) {
    const core = cores[cursor++],
      record = { core, artifacts: {}, errors: [] };
    records.push(record);
    for (const ext of ['js', 'wasm']) {
      const url = `${LIBRETRO_WEB}/${core}_libretro.${ext}`;
      try {
        const result = await boundedDownload(url, LIBRETRO_LIMITS[ext]);
        await writeFile(join(artifacts, `${core}_libretro.${ext}`), result.bytes);
        record.artifacts[ext] = {
          url,
          status: 'downloaded',
          bytes: result.bytes.length,
          sha256: result.sha256,
          lastModified: result.lastModified,
        };
      } catch (error) {
        record.errors.push(`${ext}: ${error.message}`);
      }
    }
    const infoUrl = `https://raw.githubusercontent.com/libretro/libretro-super/${infoRevision}/dist/info/${core}_libretro.info`;
    try {
      const result = await boundedDownload(infoUrl, 256 * 1024);
      record.info = {
        url: infoUrl,
        sha256: result.sha256,
        fields: parseCoreInfo(result.bytes.toString('utf8')),
      };
      await writeFile(join(artifacts, `${core}.info`), result.bytes);
    } catch (error) {
      record.errors.push(`info: ${error.message}`);
    }
    await writeFile(join(output, 'downloads.json'), JSON.stringify(records, null, 2));
  }
}
await Promise.all([fetchWorker(), fetchWorker()]);
const pairs = records.filter((record) => record.artifacts.js && record.artifacts.wasm);
const { results, sandboxSha256 } = await smokeLibretroPairs(
  pairs.map((record) => ({
    core: record.core,
    loaderPath: join(artifacts, `${record.core}_libretro.js`),
    wasmPath: join(artifacts, `${record.core}_libretro.wasm`),
  })),
  output,
);
const summary = {
  selectorCores: selectorCores.length,
  selected: cores.length,
  downloadedPairs: pairs.length,
  passed: results.filter(
    (result) =>
      result.ok && result.pageErrors.length === 0 && result.unexpectedRequests.length === 0,
  ).length,
  failed: results.filter(
    (result) => !result.ok || result.pageErrors.length || result.unexpectedRequests.length,
  ),
  infoRevision,
  sandboxSha256,
  output,
};
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
