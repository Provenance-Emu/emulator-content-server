import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const tag = process.argv[2];
if (!tag || !/^v[0-9][a-zA-Z0-9.-]*$/.test(tag))
  throw new Error('A version release tag is required');
const version = tag.slice(1);
const platform = process.platform;
const suffixes =
  platform === 'win32' ? ['.msi'] : platform === 'linux' ? ['.deb', '.AppImage'] : ['.dmg'];
const source = resolve('apps/tray/src-tauri/target/release/bundle');
const output = resolve('dist-release/desktop');
await mkdir(output, { recursive: true });

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !entry.name.endsWith('.app')) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
const candidates = await walk(source);
const assets = [];
const checksums = [];
for (const extension of suffixes) {
  const matches = candidates.filter((file) => extname(file) === extension);
  if (matches.length !== 1)
    throw new Error(`Expected one ${extension} installer, found ${matches.length}`);
  const name = `emulator-content-server-desktop-${version}-${platform}-${process.arch}${extension}`;
  const target = join(output, name);
  await copyFile(matches[0], target);
  checksums.push(
    `${createHash('sha256')
      .update(await readFile(target))
      .digest('hex')}  ${name}`,
  );
  assets.push(target);
}
const sums = join(output, `SHA256SUMS-desktop-${platform}-${process.arch}.txt`);
await writeFile(sums, `${checksums.join('\n')}\n`);
execFileSync('gh', ['release', 'upload', tag, ...assets, sums], { stdio: 'inherit' });
