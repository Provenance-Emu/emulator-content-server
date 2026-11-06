/** Inventory notice evidence for captured C/C++ inputs without executing archived source. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_INPUTS = 20_000;
const sourceExtension = /\.(?:c|cc|cpp|cxx|m|mm|s)$/i;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function readRegular(path, limit = MAX_FILE_BYTES) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit)
      throw new Error('Build evidence exceeds regular-file bounds');
    const bytes = readFileSync(fd);
    if (bytes.length > limit) throw new Error('Build evidence exceeds file bounds');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function parseMakeDependencies(text) {
  const flattened =
    text
      .replace(/\\\r?\n/g, ' ')
      .split(/\r?\n/)
      .find((line) => line.trim()) ?? '';
  const separator = flattened.search(/:\s/);
  if (separator < 0) throw new Error('Malformed compiler dependency record');
  return (flattened.slice(separator + 1).match(/(?:\\.|[^\s])+/g) ?? []).map((token) =>
    token.replace(/\\([\\ #:$])/g, '$1'),
  );
}

function inlineNotices(bytes) {
  const text = bytes.subarray(0, 65536).toString('latin1');
  const result = [];
  for (const match of text.matchAll(/\/\*[\s\S]*?\*\/|(?:^[\t ]*\/\/[^\r\n]*(?:\r?\n|$))+/gm)) {
    if (
      !/copyright|licen[cs]e|SPDX|permission|public domain|GNU (?:general|lesser)/i.test(match[0])
    )
      continue;
    const start = match.index,
      end = start + match[0].length;
    result.push({
      startByte: start,
      endByte: end,
      startLine: text.slice(0, start).split('\n').length,
      endLine: text.slice(0, end - 1).split('\n').length,
      sizeBytes: end - start,
      sha256: hash(bytes.subarray(start, end)),
    });
  }
  return result;
}

export function collectBuildNotices(captureDirectory, sourceDirectory, sdkDirectory) {
  if (
    ![captureDirectory, sourceDirectory, sdkDirectory].every((path) => statSync(path).isDirectory())
  )
    throw new Error('Build notice roots must be directories');
  const capture = realpathSync(captureDirectory);
  const scopes = [
    { root: realpathSync(sourceDirectory), label: 'source' },
    { root: realpathSync(sdkDirectory), label: 'sdk' },
  ].sort((a, b) => b.root.length - a.root.length);
  const inputs = new Map(),
    noticeFiles = new Map(),
    directoryNotices = new Map();
  const unresolved = [];
  let failedCompileCount = 0,
    compileCount = 0;
  function locate(path) {
    const actual = realpathSync(path);
    for (const scope of scopes) {
      const inside = relative(scope.root, actual);
      if (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
        return { actual, scope, path: `${scope.label}/${inside.split('\\').join('/')}` };
    }
    return null;
  }
  function ancestorNotices(location) {
    const result = [];
    let directory = dirname(location.actual);
    for (;;) {
      if (!directoryNotices.has(directory)) {
        const found = [];
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !/^(?:copying|copyright|license|notice)/i.test(entry.name))
            continue;
          const candidate = locate(join(directory, entry.name));
          if (!candidate) continue;
          const bytes = readRegular(candidate.actual);
          noticeFiles.set(candidate.path, {
            path: candidate.path,
            sizeBytes: bytes.length,
            sha256: hash(bytes),
          });
          found.push(candidate.path);
        }
        directoryNotices.set(directory, found.sort());
      }
      result.push(...directoryNotices.get(directory));
      if (directory === location.scope.root) break;
      directory = dirname(directory);
    }
    return result;
  }
  const lines = readRegular(join(capture, 'commands.jsonl')).toString('utf8').trim().split('\n');
  if (lines.length > MAX_INPUTS) throw new Error('Too many compiler evidence records');
  for (const line of lines) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (!Array.isArray(record.args) || !record.args.includes('-c')) continue;
    compileCount++;
    if (record.exitCode !== 0) {
      failedCompileCount++;
      continue;
    }
    if (typeof record.cwd !== 'string' || typeof record.dependencyFile !== 'string') {
      unresolved.push({ reason: 'missing-dependency-record' });
      continue;
    }
    const dependency = realpathSync(record.dependencyFile);
    const within = relative(capture, dependency);
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw new Error('Dependency record escapes capture directory');
    for (const name of parseMakeDependencies(readRegular(dependency).toString('utf8'))) {
      let location;
      try {
        location = locate(resolve(record.cwd, name));
      } catch {
        unresolved.push({ name: name.split(/[\\/]/).at(-1), reason: 'missing-input' });
        continue;
      }
      if (!location) {
        unresolved.push({ name: name.split(/[\\/]/).at(-1), reason: 'outside-allowed-roots' });
        continue;
      }
      if (inputs.has(location.path)) continue;
      if (inputs.size >= MAX_INPUTS) throw new Error('Too many compiler inputs');
      const bytes = readRegular(location.actual);
      inputs.set(location.path, {
        path: location.path,
        kind: sourceExtension.test(location.path) ? 'source' : 'header',
        sizeBytes: bytes.length,
        sha256: hash(bytes),
        inlineNotices: inlineNotices(bytes),
        ancestorNotices: ancestorNotices(location),
      });
    }
  }
  return {
    schemaVersion: 1,
    scope:
      'Compiler-reported C/C++ sources and includes. Comment spans and ancestor notice filenames are evidence candidates; applicability requires component review.',
    compileCount,
    failedCompileCount,
    inputs: [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path)),
    noticeFiles: [...noticeFiles.values()].sort((a, b) => a.path.localeCompare(b.path)),
    unresolved,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6)
    throw new Error(
      'Usage: collect-build-notices.mjs CAPTURE_DIRECTORY SOURCE_ROOT SDK_ROOT NEW_OUTPUT',
    );
  const [capture, source, sdk, output] = process.argv.slice(2);
  writeFileSync(output, `${JSON.stringify(collectBuildNotices(capture, source, sdk), null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}
