import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectBuildNotices,
  parseMakeDependencies,
} from './browser-core/collect-build-notices.mjs';

test('compiler dependency records preserve escaped filenames and line continuations', () => {
  assert.deepEqual(
    parseMakeDependencies('out.o: source.c dir\\ name/header\\ name.h \\\n  sdk/header.h\n'),
    ['source.c', 'dir name/header name.h', 'sdk/header.h'],
  );
});

test('notice collection binds actual compiled sources and headers to exact inline spans and ancestor files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ecs-notices-'));
  try {
    const source = join(root, 'source'),
      sdk = join(root, 'sdk'),
      capture = join(root, 'capture');
    for (const p of [source, sdk, capture, join(source, 'vendor')])
      mkdirSync(p, { recursive: true });
    const notice =
      '/* Copyright Generated Author. Permission is granted for generated fixtures. */';
    writeFileSync(
      join(source, 'vendor/generated.c'),
      `${notice}\n#include "generated.h"\nint generated;\n`,
    );
    writeFileSync(
      join(source, 'vendor/generated.h'),
      '// SPDX-License-Identifier: MIT\n#define GENERATED 1\n',
    );
    writeFileSync(join(source, 'vendor/LICENSE.txt'), 'Generated license fixture\n');
    writeFileSync(join(sdk, 'sdk.h'), '/* Copyright Generated SDK */\n');
    writeFileSync(
      join(capture, 'deps.d'),
      `generated.o: vendor/generated.c vendor/generated.h ${sdk}/sdk.h\n`,
    );
    const command = {
      cwd: source,
      args: ['clang', '-c', 'vendor/generated.c'],
      exitCode: 0,
      dependencyFile: join(capture, 'deps.d'),
    };
    writeFileSync(
      join(capture, 'commands.jsonl'),
      `${JSON.stringify(command)}\n${JSON.stringify(command)}\n`,
    );
    const report = collectBuildNotices(capture, source, sdk);
    assert.equal(report.inputs.length, 3);
    const c = report.inputs.find((p) => p.path === 'source/vendor/generated.c');
    assert.ok(c);
    assert.equal(c.kind, 'source');
    assert.equal(c.inlineNotices[0].sha256, createHash('sha256').update(notice).digest('hex'));
    assert.equal(c.inlineNotices[0].startLine, 1);
    assert.deepEqual(c.ancestorNotices, ['source/vendor/LICENSE.txt']);
    assert.equal(
      report.inputs.find((p) => p.path.endsWith('generated.h')).inlineNotices[0].startLine,
      1,
    );
    const headerNotice = report.inputs.find((p) => p.path.endsWith('generated.h')).inlineNotices[0];
    assert.equal(headerNotice.endLine, 1);
    assert.equal(headerNotice.startByte, 0);
    assert.equal(headerNotice.endByte, Buffer.byteLength('// SPDX-License-Identifier: MIT\n'));
    assert.equal(report.noticeFiles[0].path, 'source/vendor/LICENSE.txt');
    assert.equal(report.unresolved.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed and outside-root compiler inputs remain explicit coverage gaps', () => {
  const root = mkdtempSync(join(tmpdir(), 'ecs-notice-scope-'));
  try {
    for (const p of ['source', 'sdk', 'capture']) mkdirSync(join(root, p));
    writeFileSync(join(root, 'outside.h'), 'Generated outside scope');
    writeFileSync(join(root, 'capture/deps.d'), 'out.o: ../outside.h\n');
    writeFileSync(
      join(root, 'capture/commands.jsonl'),
      `${JSON.stringify({ cwd: join(root, 'source'), args: ['clang', '-c', 'unused.c'], exitCode: 1, dependencyFile: null })}\n${JSON.stringify({ cwd: join(root, 'source'), args: ['clang', '-c', 'unused.c'], exitCode: 0, dependencyFile: join(root, 'capture/deps.d') })}\n`,
    );
    const report = collectBuildNotices(
      join(root, 'capture'),
      join(root, 'source'),
      join(root, 'sdk'),
    );
    assert.equal(report.failedCompileCount, 1);
    assert.equal(report.inputs.length, 0);
    assert.equal(report.unresolved[0].reason, 'outside-allowed-roots');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dependency collection ignores phony header targets and rejects file roots', () => {
  assert.deepEqual(parseMakeDependencies('out.o: source.c header.h\n\nheader.h:\n'), [
    'source.c',
    'header.h',
  ]);
  const root = mkdtempSync(join(tmpdir(), 'ecs-notice-roots-'));
  try {
    mkdirSync(join(root, 'capture'));
    mkdirSync(join(root, 'sdk'));
    writeFileSync(join(root, 'capture/commands.jsonl'), '');
    writeFileSync(join(root, 'source-file'), 'generated');
    assert.throws(
      () =>
        collectBuildNotices(join(root, 'capture'), join(root, 'source-file'), join(root, 'sdk')),
      /directories/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nonregular compiler inputs fail without blocking on named pipes', {
  skip: process.platform === 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'ecs-notice-pipe-'));
  try {
    for (const directory of ['source', 'sdk', 'capture']) mkdirSync(join(root, directory));
    const fifo = join(root, 'source', 'generated.c');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    writeFileSync(join(root, 'capture/deps.d'), 'out.o: generated.c\n');
    writeFileSync(
      join(root, 'capture/commands.jsonl'),
      `${JSON.stringify({ cwd: join(root, 'source'), args: ['clang', '-c', 'generated.c'], exitCode: 0, dependencyFile: join(root, 'capture/deps.d') })}\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./browser-core/collect-build-notices.mjs', import.meta.url)),
        join(root, 'capture'),
        join(root, 'source'),
        join(root, 'sdk'),
        join(root, 'output.json'),
      ],
      { timeout: 3000, encoding: 'utf8' },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /regular-file bounds/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('full bounded inputs retain late inline notices and contained notice symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'ecs-notice-full-'));
  try {
    for (const directory of ['source', 'sdk', 'capture']) mkdirSync(join(root, directory));
    const prefix = `${'int generated;\n'.repeat(6000)}`;
    const late =
      '/* Copyright generated late author. SPDX-License-Identifier: MIT */\n/* Retain these generated distribution terms with every copy. */';
    writeFileSync(join(root, 'source', 'generated.c'), prefix + late);
    writeFileSync(join(root, 'source', 'terms.txt'), 'Generated terms');
    symlinkSync('terms.txt', join(root, 'source', 'LICENSE'));
    writeFileSync(join(root, 'outside.txt'), 'Generated outside terms');
    symlinkSync('../outside.txt', join(root, 'source', 'NOTICE-outside'));
    writeFileSync(join(root, 'capture', 'deps.d'), 'out.o: generated.c\n');
    writeFileSync(
      join(root, 'capture', 'commands.jsonl'),
      `${JSON.stringify({ cwd: join(root, 'source'), args: ['clang', '-c', 'generated.c'], exitCode: 0, dependencyFile: join(root, 'capture/deps.d') })}\n`,
    );
    const result = collectBuildNotices(
      join(root, 'capture'),
      join(root, 'source'),
      join(root, 'sdk'),
    );
    assert.equal(result.inputs[0].inlineNotices[0]?.startByte, Buffer.byteLength(prefix));
    assert.equal(
      result.inputs[0].inlineNotices[0]?.sha256,
      createHash('sha256').update(late).digest('hex'),
    );
    assert.deepEqual(result.inputs[0].ancestorNotices, ['source/terms.txt']);
    assert.deepEqual(result.unresolved, [
      { name: 'NOTICE-outside', reason: 'notice-outside-allowed-roots' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collector CLI follows a symlinked entry point and writes its output', () => {
  const root = mkdtempSync(join(tmpdir(), 'ecs-notice-cli-'));
  try {
    for (const directory of ['source', 'sdk', 'capture']) mkdirSync(join(root, directory));
    writeFileSync(join(root, 'capture', 'commands.jsonl'), '');
    const entry = join(root, 'collector.mjs');
    symlinkSync(
      fileURLToPath(new URL('./browser-core/collect-build-notices.mjs', import.meta.url)),
      entry,
    );
    const output = join(root, 'output.json');
    const result = spawnSync(
      process.execPath,
      [entry, join(root, 'capture'), join(root, 'source'), join(root, 'sdk'), output],
      { timeout: 3000, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).inputs, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
