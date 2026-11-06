import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdtemp, readdir, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const archive = resolve(process.argv[2]);
const temporary = await mkdtemp(join(tmpdir(), 'ecs-nightly-smoke-'));
let child;

async function assertContainedLinks(directory, root) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if ((await lstat(path)).isSymbolicLink()) {
      assert.ok(
        !isAbsolute(await readlink(path)),
        'Archive must not contain absolute build-machine links',
      );
      const target = relative(root, await realpath(path));
      assert.ok(
        target !== '..' && !target.startsWith(`..${sep}`) && !isAbsolute(target),
        'Extracted dependency must remain inside the archive',
      );
    } else if (entry.isDirectory()) {
      await assertContainedLinks(path, root);
    }
  }
}
try {
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $env:ECS_NIGHTLY_ARCHIVE -DestinationPath $env:ECS_NIGHTLY_EXTRACT',
      ],
      {
        stdio: 'inherit',
        env: { ...process.env, ECS_NIGHTLY_ARCHIVE: archive, ECS_NIGHTLY_EXTRACT: temporary },
      },
    );
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', temporary]);
  }
  const root = join(temporary, basename(archive).replace(/\.(?:tar\.gz|zip)$/, ''));
  await assertContainedLinks(root, await realpath(root));
  const metadata = JSON.parse(await readFile(join(root, 'BUILD.json'), 'utf8'));
  assert.equal(metadata.arch, process.arch);
  assert.match(metadata.id, /^[a-f0-9]{64}$/);
  const updateManifest = JSON.parse(
    await readFile(
      join(dirname(archive), `ecs-update-${metadata.platform}-${metadata.arch}.json`),
      'utf8',
    ),
  );
  assert.deepEqual(updateManifest.build, metadata);
  assert.equal(updateManifest.archive, basename(archive));
  assert.equal(
    updateManifest.sha256,
    createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
  );
  const node = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  assert.equal(execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(), `v${metadata.node}`);
  const cli = join(root, 'server/dist/src/main.js');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ECS_') || key === 'NODE_PATH' || key === 'NODE_OPTIONS') delete env[key];
  }
  // Exercise the actual launcher with help; Windows needs cmd.exe for a .cmd entrypoint.
  const help =
    process.platform === 'win32'
      ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'ecs.cmd --help'], {
          cwd: root,
          env,
          encoding: 'utf8',
        })
      : execFileSync(join(root, 'ecs'), ['--help'], { cwd: temporary, env, encoding: 'utf8' });
  assert.match(help, /ecs serve/);
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((done) => reserve.close(done));
  child = spawn(
    node,
    [
      join(root, 'server', 'dist', 'src', 'supervise.js'),
      'serve',
      '--data',
      join(temporary, 'generated-data'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    { cwd: temporary, env, stdio: 'ignore' },
  );
  let healthy = false;
  const origin = `http://127.0.0.1:${port}`;
  for (let retry = 0; retry < 150; retry++) {
    assert.equal(child.exitCode, null, 'Extracted server exited before startup');
    try {
      healthy = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {}
    if (healthy) break;
    await delay(100);
  }
  assert.ok(healthy, 'Extracted server must answer /health');
  const response = await fetch(`${origin}/ui/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]);
  assert.ok(assets.some((asset) => asset.endsWith('.js')));
  assert.ok(assets.some((asset) => asset.endsWith('.css')));
  for (const asset of assets) {
    const url = new URL(asset, `${origin}/ui/`);
    assert.equal(url.origin, origin);
    const loaded = await fetch(url);
    assert.equal(loaded.status, 200);
    assert.ok((await loaded.arrayBuffer()).byteLength > 0);
  }
  execFileSync(node, [cli, 'doctor', '--data', join(temporary, 'generated-data')], {
    cwd: temporary,
    env,
    stdio: 'ignore',
  });
  console.log(
    `Extracted ${metadata.platform}/${metadata.arch}: runtime, launcher, SQLite, health, UI/assets and doctor passed`,
  );
} finally {
  if (child && child.exitCode === null) {
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    await stopped;
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 10 });
}
