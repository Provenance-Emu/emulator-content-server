/** Pin and probe upstream Dolphin assets outside the repository; never installs a profile. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DOLPHIN_ABI_EXPORTS, dolphinSmokeDol } from './dolphin-abi.mjs';

export const dolphinPins = Object.freeze({
  repository: 'https://github.com/dougchansan/wasm-dolphin',
  commit: '7e38409ace3dda709c178312ff63fd92a3653cc7',
  upstreamCommit: 'e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1',
  loader: Object.freeze({
    bytes: 266970,
    sha256: '7c78f3fc2207daab059af3b15c230c23d11205584cf1dfe89c65f66996e18b99',
  }),
  wasm: Object.freeze({
    bytes: 15175335,
    sha256: 'd7395b3a94080f5b7d08a0522f59096007419d117b7b0eb868246429adee6f5c',
  }),
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const repository = fileURLToPath(new URL('../..', import.meta.url));
function external(path) {
  const actual = existsSync(path)
    ? realpathSync(path)
    : join(realpathSync(dirname(path)), path.split(/[\\/]/).at(-1));
  const within = relative(repository, actual);
  if (within !== '..' && !within.startsWith('../') && !isAbsolute(within))
    throw new Error('Dolphin probe inputs and outputs must be outside this repository');
}
export function prepareDolphinProbe(checkout, output) {
  checkout = resolve(checkout);
  output = resolve(output);
  external(checkout);
  external(output);
  if (existsSync(output)) throw new Error('Dolphin probe output must be new');
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' });
  if (revision.status !== 0 || revision.stdout.trim() !== dolphinPins.commit)
    throw new Error('Unexpected Dolphin source revision');
  const bytes = {};
  for (const [name, filename] of [
    ['loader', 'dolphin-core-upstream.js'],
    ['wasm', 'dolphin-core-upstream.wasm'],
  ]) {
    const path = join(checkout, 'cores/dolphin', filename);
    if (statSync(path).size !== dolphinPins[name].bytes)
      throw new Error(`Unexpected Dolphin ${name} size`);
    const value = readFileSync(path);
    if (value.length !== dolphinPins[name].bytes || hash(value) !== dolphinPins[name].sha256)
      throw new Error(`Unexpected Dolphin ${name} digest or size`);
    bytes[name] = value;
  }
  const source = bytes.loader.toString('utf8');
  const pool = 'var pthreadPoolSize=16;';
  if (source.split(pool).length !== 2) throw new Error('Unexpected Dolphin pthread initialization');
  // Diagnostic resource bound only: retain identical WASM, emulation, JIT and shared memory.
  const loader = source.replace(pool, 'var pthreadPoolSize=2;');
  mkdirSync(output);
  writeFileSync(join(output, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
  writeFileSync(join(output, 'dolphin-core-upstream.js'), loader, { flag: 'wx' });
  writeFileSync(join(output, 'dolphin-core-upstream.wasm'), bytes.wasm, { flag: 'wx' });
  const dol = dolphinSmokeDol();
  writeFileSync(join(output, 'original.dol'), dol, { flag: 'wx' });
  const receipt = {
    schema: 'ecs.dolphin-prototype/v1',
    diagnosticOnly: true,
    pins: dolphinPins,
    requiredJsExports: DOLPHIN_ABI_EXPORTS,
    changedLoaderSha256: hash(loader),
    originalDolSha256: hash(dol),
    transform:
      'Exactly one eager pthread pool initialization: 16 to 2. Identical upstream WASM; not a non-threaded build.',
    requirements: {
      sharedMemory: true,
      initialMemoryBytes: 1610612736,
      opaquePlayerSupported: false,
    },
    distribution:
      'Operator-local diagnostic. No ECS profile, publication, firmware, game images or corresponding-source reproduction claim.',
  };
  writeFileSync(join(output, 'dolphin-probe.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });
  return receipt;
}

export function runDolphinProbe(output) {
  const factoryUrl = pathToFileURL(join(resolve(output), 'dolphin-core-upstream.js')).href;
  const wasmPath = join(resolve(output), 'dolphin-core-upstream.wasm');
  const abiUrl = new URL('./dolphin-abi.mjs', import.meta.url).href;
  const script = `
import factory from ${JSON.stringify(factoryUrl)};
import { readFileSync } from 'node:fs';
import { bindDolphinPrototype } from ${JSON.stringify(abiUrl)};
const logs = [];
const module = await factory({ wasmBinary: readFileSync(${JSON.stringify(wasmPath)}), noInitialRun: true, print: x => logs.push(String(x)), printErr: x => logs.push(String(x)) });
bindDolphinPrototype(module);
const result = { memoryBytes: module.HEAPU8.byteLength, shared: module.HEAPU8.buffer instanceof SharedArrayBuffer,
  jitSmoke: module._RunWasmJitSmoke(100), addi: module._RunPpcWasmAddiSmoke(100, 23), integerBlock: module._RunPpcWasmIntegerBlockSmoke() };
if (result.jitSmoke !== 142 || result.addi !== 123 || result.integerBlock !== 1) throw new Error('Dolphin generated WASM smoke failed');

console.log(JSON.stringify({ ...result, logs }));
process.exit(0);
`;
  const runner = join(output, 'dolphin-smoke-runner.mjs');
  writeFileSync(runner, script, { flag: 'wx' });
  const child = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (child.error || child.status !== 0)
    throw new Error(`Dolphin probe failed: ${child.error?.message ?? child.stderr.slice(-2000)}`);
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
  writeFileSync(
    join(output, 'dolphin-probe-results.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    { flag: 'wx' },
  );
  return result;
}
/** A fresh factory is required because the preceding integer-block smoke initializes Core. */
export function runDolphinDolProbe(output) {
  const root = resolve(output);
  const script = `
import factory from ${JSON.stringify(pathToFileURL(join(root, 'dolphin-core-upstream.js')).href)};
import { readFileSync } from 'node:fs';
import { bindDolphinPrototype } from ${JSON.stringify(new URL('./dolphin-abi.mjs', import.meta.url).href)};
const logs = [];
const module = await factory({ wasmBinary: readFileSync(${JSON.stringify(join(root, 'dolphin-core-upstream.wasm'))}), noInitialRun: true, print: x => logs.push(String(x)), printErr: x => logs.push(String(x)) });
const host = bindDolphinPrototype(module);
const dol = readFileSync(${JSON.stringify(join(root, 'original.dol'))});
host.bootDol(dol);
const samples = [];
for (let index = 0; index < 24; index++) {
  await new Promise(resolve => setTimeout(resolve, 250));
  const current = host.poll();
  samples.push({ ...current, ticks: current.ticks.toString() });
}
const running = samples.filter(sample => sample.state === 'Running' && sample.jitCompiled > 0 && sample.jitRuns > 0);
if (running.length < 2 || running.at(-1).jitRuns <= running[0].jitRuns || !running.some(sample => sample.pc === 0x8000310c || sample.pc === 0x80003110)) throw new Error('Original DOL did not demonstrate advancing PPC JIT execution');
const heap = Buffer.from(module.HEAPU8.buffer, 0, Math.min(module.HEAPU8.byteLength, 512 * 1024 * 1024));
const needle = dol.subarray(0x100, 0x118);
const counters = () => {
  const matches = [];
  for (let offset = heap.indexOf(needle); offset >= 0 && matches.length < 16; offset = heap.indexOf(needle, offset + 1)) {
    if (offset + 0xf04 < heap.length) matches.push({ offset, value: heap.readUInt32BE(offset + 0xf00) });
  }
  return matches;
};
const before = counters();
await new Promise(resolve => setTimeout(resolve, 250));
const after = counters();
const advancingGuestRam = after.some(next => before.some(previous => next.offset === previous.offset && next.value !== previous.value));
console.log(JSON.stringify({ samples, before, after, advancingGuestRam, frameVerified: false, logs }));
// Worker teardown bounds this diagnostic. Do not block on StopCore inside a probe process.
process.exit(0);
`;
  const runner = join(root, 'dolphin-dol-runner.mjs');
  writeFileSync(runner, script, { flag: 'wx' });
  const child = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (child.error || child.status !== 0)
    throw new Error(
      `Dolphin DOL probe failed: ${child.error?.message ?? child.stderr.slice(-2000)}`,
    );
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
  writeFileSync(join(root, 'dolphin-dol-results.json'), `${JSON.stringify(result, null, 2)}\n`, {
    flag: 'wx',
  });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4)
    throw new Error('Usage: node dolphin-probe.mjs PINNED_EXTERNAL_FORK NEW_EXTERNAL_OUTPUT');
  const [, , checkout, output] = process.argv;
  prepareDolphinProbe(checkout, output);
  console.log(
    JSON.stringify({ abi: runDolphinProbe(output), dol: runDolphinDolProbe(output) }, null, 2),
  );
}
