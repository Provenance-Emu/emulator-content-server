/** Carry the retained historical grants in player packages and corresponding source. */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManifest, parsePlayerPackage } from '../../packages/plugins/dist/src/index.js';

const config = JSON.parse(await readFile(new URL('./buildbot-config.json', import.meta.url)));
const resolutionUrl = new URL(
  '../../docs/operations/sha1-ijg-resolution-2026-11-06.json',
  import.meta.url,
);
const documentationUrl = new URL(
  '../../docs/operations/sha1-ijg-resolution-2026-11-06.md',
  import.meta.url,
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const noticeFile = (file, bytes) => ({
  file,
  bytes,
  sha256: digest(bytes),
  sizeBytes: bytes.length,
});

/** Flat filenames satisfy the player manifest's portable resource-name contract. */
export async function recoveredNoticeFiles(id) {
  if (!config.cores.some((core) => core.id === id)) throw new Error('Unknown buildbot core');
  const reportBytes = await readFile(resolutionUrl);
  const report = JSON.parse(reportBytes);
  const sha1 = report.components.find((component) => component.id === 'frontend-sha1');
  const components = [{ component: sha1, retained: 'sha1-fpl.txt', expected: sha1.grantFile }];
  if (id === 'mednafen-pcfx') {
    const ijg = report.components.find((component) => component.id === 'pcfx-jpeg-idct');
    components.push({ component: ijg, retained: 'ijg-v4-README.txt', expected: ijg.readme });
  }
  let componentNoticeReport;
  let supplementaryComponents = [];
  if (id === 'atari800' || id === 'potator') {
    const file = 'docs/operations/notice-closure-2026-11-07.json';
    const bytes = await readFile(new URL(`../../${file}`, import.meta.url));
    componentNoticeReport = { file, sha256: digest(bytes) };
    supplementaryComponents = JSON.parse(bytes).materials.filter(
      (material) => material.coreId === id,
    );
    if (supplementaryComponents.length !== (id === 'atari800' ? 1 : 3))
      throw new Error('Incorporated component notice evidence is incomplete');
  }
  const files = [];
  for (const { retained, expected } of components) {
    const file = noticeFile(
      retained,
      await readFile(new URL(`../../docs/operations/notices/${retained}`, import.meta.url)),
    );
    if (file.sha256 !== expected.sha256 || file.sizeBytes !== expected.sizeBytes)
      throw new Error(`Retained notice does not match recovery evidence: ${retained}`);
    files.push(file);
  }
  for (const material of supplementaryComponents) {
    const file = noticeFile(
      material.file,
      await readFile(new URL(`../../docs/operations/notices/${material.file}`, import.meta.url)),
    );
    if (file.sha256 !== material.sha256 || file.sizeBytes !== material.sizeBytes)
      throw new Error(`Retained notice does not match component evidence: ${material.file}`);
    files.push(file);
  }
  let scope =
    `Recovered dependency notices for ${id}\n\n` +
    'The RetroArch frontend incorporates Paul E. Jones SHA1 code in libretro-common/hash/lrc_hash.c.\n' +
    "sha1-fpl.txt preserves the matching author distribution's Freeware Public License (FPL) verbatim.\n" +
    'The surrounding lrc_hash.c file MIT notice and incorporated SHA1 grant have separate scopes.\n';
  if (id === 'mednafen-pcfx') {
    const documentation = await readFile(documentationUrl, 'utf8');
    const start = documentation.indexOf('### Incorporated modifications\n');
    const end = documentation.indexOf('\n## Remaining distribution work\n', start);
    if (start < 0 || end <= start)
      throw new Error('Retained IJG modification documentation is missing');
    files.push(
      noticeFile(
        'ijg-modifications.txt',
        Buffer.from(
          'This software is based in part on the work of the Independent JPEG Group.\n\n' +
            documentation.slice(start, end) +
            '\n',
        ),
      ),
    );
    scope +=
      '\nThe Beetle PC-FX mednafen/pcfx/jrevdct.c adaptation incorporates IJG release 4 code.\n' +
      'ijg-v4-README.txt preserves the full historical README verbatim.\n' +
      'ijg-modifications.txt records the compared Mednafen adaptation and its modified final scale.\n\n' +
      'This software is based in part on the work of the Independent JPEG Group.\n';
  }
  if (id === 'atari800')
    scope +=
      '\nAtari800 libretro/retro_utils.c incorporates Caprice32-derived utilities.\n' +
      'atari800-caprice32.txt preserves the complete copyright, conditions and disclaimer, including the documentation/materials reproduction condition.\n';
  if (id === 'potator')
    scope +=
      '\nPotator common/m6502 incorporates M65C02 code.\n' +
      'potator-m6502-source.txt, potator-m6502-header.txt and potator-m6502-tables.txt preserve the complete source banners, including noncommercial distribution terms and the modification notification request.\n' +
      'These full banners supplement the source attribution; they do not resolve the restrictive terms through a broader project license.\n';
  scope +=
    '\nThese supplemental materials accompany the original frontend/core notices and corresponding source.\n' +
    'recovered-notice-evidence.json identifies their retained bytes and recovery provenance.\n';
  files.push(noticeFile('recovered-NOTICES.txt', Buffer.from(scope)));
  const evidence = {
    schemaVersion: 1,
    coreId: id,
    frontendRevision: config.frontend.revision,
    sourceReport: {
      file: 'docs/operations/sha1-ijg-resolution-2026-11-06.json',
      sha256: digest(reportBytes),
    },
    ...(componentNoticeReport
      ? {
          componentNoticeReport,
          supplementaryComponents: supplementaryComponents.map((material) => ({
            id: material.componentId,
            retainedFile: {
              file: material.file,
              sha256: material.sha256,
              sizeBytes: material.sizeBytes,
            },
            source: material.source,
          })),
        }
      : {}),
    components: components.map(({ component, retained, expected }) => ({
      id: component.id,
      grantNameAsPublished: component.grantNameAsPublished,
      retainedFile: { file: retained, sha256: expected.sha256, sizeBytes: expected.sizeBytes },
      upstreamSource: component.upstreamSource,
      incorporatedHeader: component.incorporatedHeader,
      archive: report.downloads.find(
        (download) =>
          download.filename ===
          (component.id === 'frontend-sha1' ? 'sha1-c.zip' : 'jpegsrc.v4.tar.Z'),
      ),
      ...(component.authorArchiveFingerprintVerified
        ? {
            authorArchiveSha1: component.authorArchiveSha1,
            authorPublishedArchiveSha1: component.authorPublishedArchiveSha1,
          }
        : {}),
    })),
    materials: files.map(({ file, sha256, sizeBytes }) => ({ file, sha256, sizeBytes })),
  };
  files.push(
    noticeFile(
      'recovered-notice-evidence.json',
      Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
    ),
  );
  return files;
}

async function regularDirectory(directory) {
  if (!(await lstat(directory)).isDirectory())
    throw new Error('Recovered notices need a regular directory');
}
async function existingFile(path) {
  let handle;
  try {
    // O_NOFOLLOW prevents an existing notice from redirecting a read or write.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) throw new Error('Recovered notice must be a regular file');
    return await handle.readFile();
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error.code === 'ELOOP') throw new Error('Recovered notice must be a regular file');
    throw error;
  } finally {
    await handle?.close();
  }
}
async function validateExistingFiles(directory, files) {
  for (const { file, bytes } of files) {
    const existing = await existingFile(join(directory, file));
    if (existing && !existing.equals(bytes))
      throw new Error(`Conflicting recovered notice: ${file}`);
  }
}
async function writeNoticeFiles(directory, files) {
  await validateExistingFiles(directory, files);
  for (const { file, bytes } of files) {
    try {
      await writeFile(join(directory, file), bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Identical prior files make a partial run retryable without replacing operator files.
      const existing = await existingFile(join(directory, file));
      if (!existing?.equals(bytes)) throw new Error(`Conflicting recovered notice: ${file}`);
    }
  }
}

/** Add validated notice assets, committing the manifest only after all files exist. */
export async function addRecoveredPlayerNotices(directory, id) {
  const files = await recoveredNoticeFiles(id);
  await regularDirectory(directory);
  const lockPath = join(directory, 'plugin.json.recovered-notices.lock');
  const lock = await open(lockPath, 'wx');
  const manifestPath = join(directory, 'plugin.json');
  const temporaryPath = join(directory, 'plugin.json.recovered-notices.next');
  let temporaryCreated = false;
  try {
    const original = await existingFile(manifestPath);
    const manifest = JSON.parse(original);
    parseManifest(manifest);
    if (manifest.id !== `org.libretro.${id}` || !manifest.player?.web)
      throw new Error('Player identity does not match recovered notices');
    const assets = manifest.player.web.assets;
    for (const { file, sha256 } of files) {
      const existing = assets.find(
        (asset) =>
          asset.name.toLowerCase() === file.toLowerCase() ||
          asset.file.toLowerCase() === file.toLowerCase(),
      );
      if (existing) {
        if (existing.name !== file || existing.file !== file || existing.sha256 !== sha256)
          throw new Error(`Conflicting recovered notice asset: ${file}`);
      } else assets.push({ name: file, file, sha256 });
    }
    parseManifest(manifest);
    await writeNoticeFiles(directory, files);
    const updated = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (!updated.equals(original)) {
      await writeFile(temporaryPath, updated, { flag: 'wx' });
      temporaryCreated = true;
      if (!(await existingFile(manifestPath))?.equals(original))
        throw new Error('Player manifest changed while adding recovered notices');
      await rename(temporaryPath, manifestPath);
    }
    return files;
  } finally {
    if (temporaryCreated)
      await unlink(temporaryPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    await lock.close();
    await unlink(lockPath);
  }
}

const repackageScript = `import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const spec = JSON.parse(await readFile(join(root, 'NOTICE-REISSUE.json')));
const [rebuilt, output] = process.argv.slice(2);
if (process.argv.length !== 4)
  throw new Error('Usage: node REPACKAGE-NOTICES.mjs REBUILT_PLAYER_DIRECTORY NEW_PACKAGE_FILE');
const headerBytes = Buffer.from(spec.headerBase64, 'base64');
const header = JSON.parse(headerBytes);
const web = header.manifest.player.web;
const notices = new Set(spec.noticeFiles);
const hashes = new Map([web.loader, web.wasm, ...web.assets].map((file) => [file.file, file.sha256]));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = [];
for (const file of header.files) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(file.name)) throw new Error('Invalid resource filename');
  const directory = notices.has(file.name) ? join(root, 'notices') : rebuilt;
  const handle = await open(join(directory, file.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Resource must be a regular file');
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.length !== file.size || digest(bytes) !== hashes.get(file.name))
    throw new Error('Rebuild/notice bytes differ for ' + file.name);
  files.push(bytes);
}
const prefix = Buffer.alloc(4);
prefix.writeUInt32BE(headerBytes.length);
const bytes = Buffer.concat([prefix, headerBytes, ...files]);
if (bytes.length !== spec.package.sizeBytes || digest(bytes) !== spec.package.sha256)
  throw new Error('Repackaged bytes differ');
await writeFile(output, bytes, { flag: 'wx' });
console.log('Exact notice-bearing package reproduced');
`;

function reproductionFiles(packageBytes, id, files) {
  const parsed = parsePlayerPackage(packageBytes);
  if (parsed.manifest.id !== `org.libretro.${id}`)
    throw new Error('Player identity differs from source notices');
  for (const { file, bytes } of files) {
    if (!parsed.files.get(file)?.equals(bytes))
      throw new Error(`Package is missing recovered notice: ${file}`);
  }
  const bytes = Buffer.from(packageBytes);
  const header = bytes.subarray(4, 4 + bytes.readUInt32BE(0));
  const specification = {
    schemaVersion: 1,
    headerBase64: header.toString('base64'),
    noticeFiles: files.map(({ file }) => file),
    package: { sha256: digest(bytes), sizeBytes: bytes.length },
  };
  return [
    noticeFile('NOTICE-REISSUE.json', Buffer.from(`${JSON.stringify(specification, null, 2)}\n`)),
    noticeFile('REPACKAGE-NOTICES.mjs', Buffer.from(repackageScript)),
    noticeFile(
      'NOTICE-REISSUE.md',
      Buffer.from(
        '# Reproduce the notice-bearing package\n\n' +
          'Rebuild the original player resources using the included recipe and pinned SDK. Then run\n\n' +
          '```sh\nnode REPACKAGE-NOTICES.mjs REBUILT_PLAYER_DIRECTORY NEW_PACKAGE_FILE\n```\n\n' +
          'The standalone recipe reads recovered notices from this archive and all other resources from the rebuilt player directory. ' +
          'It verifies every resource hash and size, preserves the exact package header, and verifies the complete package hash before writing a new output file.\n',
      ),
    ),
  ];
}

/** Use the same full materials in corresponding-source and artifact sidecar folders. */
export async function addRecoveredSourceNotices(directory, id, { packageBytes } = {}) {
  const files = await recoveredNoticeFiles(id);
  const reproduction = packageBytes ? reproductionFiles(packageBytes, id, files) : [];
  await regularDirectory(directory);
  await validateExistingFiles(directory, reproduction);
  const notices = join(directory, 'notices');
  try {
    await mkdir(notices);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await regularDirectory(notices);
  await writeNoticeFiles(notices, files);
  await writeNoticeFiles(directory, reproduction);
  return files;
}

/** Flat release sidecars can be uploaded directly by the release artifact glob. */
export async function addRecoveredArtifactNotices(directory, id) {
  const files = await recoveredNoticeFiles(id);
  await regularDirectory(directory);
  await writeNoticeFiles(directory, files);
  return files;
}
