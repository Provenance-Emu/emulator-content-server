/** Compile the actual upstream patch body against controlled memory/write boundaries. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const compiler = process.env.CC ?? 'cc';
const available = spawnSync(compiler, ['--version'], { stdio: 'ignore' }).status === 0;

test('patched RetroArch dispatch saves SRAM without RTC and preserves all-absent and real write errors', {
  skip: !available,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-browser-save-dispatch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const patch = await readFile(
    new URL('./browser-core/retroarch-save-files.patch', import.meta.url),
    'utf8',
  );
  const lines = patch.slice(patch.indexOf('@@')).split('\n').slice(1);
  const body = lines
    .filter((line) => line.startsWith(' ') || (line.startsWith('+') && !line.startsWith('+++')))
    .map((line) => line.slice(1))
    .join('\n')
    .split('\nbool event_load_save_files')[0];
  const source = `#include <stdbool.h>
#include <stdio.h>
struct list { unsigned size; }; static struct list list = {2}; static struct list *task_save_files=&list;
struct ram_type {int unused;}; typedef struct {void *data; unsigned size;} retro_ctx_memory_info_t;
static bool present[2], writes[2]; static unsigned calls;
static bool content_get_memory(retro_ctx_memory_info_t *m,struct ram_type *r,unsigned slot){return present[slot];}
static bool content_save_ram_file(unsigned slot,bool compress){calls++; return present[slot] && writes[slot];}
bool event_save_files(bool is_sram_used, bool compress_files, const char *path_cheat_database)
${body}
int main(void){
 struct {bool a,b,wa,wb,want;unsigned count;} cases[]={
 {1,0,1,1,1,1}, {0,0,1,1,0,0}, {1,0,0,1,0,1}, {1,1,1,0,0,2}, {1,1,1,1,1,2}};
 for(unsigned i=0;i<5;i++){present[0]=cases[i].a;present[1]=cases[i].b;writes[0]=cases[i].wa;writes[1]=cases[i].wb;calls=0;bool got=event_save_files(true,false,"");if(got!=cases[i].want || calls!=cases[i].count){fprintf(stderr,"case %u: result=%d calls=%u\\n",i,got,calls);return 1;}}
 calls=0;if(event_save_files(false,false,"") || calls)return 2;
 task_save_files=0;if(event_save_files(true,false,"") || calls)return 3;
 return 0;
}`;
  const input = join(dir, 'dispatch.c');
  const binary = join(dir, process.platform === 'win32' ? 'dispatch.exe' : 'dispatch');
  await writeFile(input, source);
  const built = spawnSync(compiler, ['-std=c99', input, '-o', binary], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const result = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('core builder refuses occupied operator directories without changing their files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-browser-build-output-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = join(dir, 'existing-core');
  await writeFile(marker, 'original trusted bytes');
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./browser-core/build.mjs', import.meta.url)),
      join(tmpdir(), 'frontend-checkout'),
      join(tmpdir(), 'core-checkout'),
      dir,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Operator output directory must be new or empty/);
  assert.equal(await readFile(marker, 'utf8'), 'original trusted bytes');
});

test('core builder refuses repository directories even when their names begin with dots', () => {
  const directory = fileURLToPath(new URL('../..misleading-checkout', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./browser-core/build.mjs', import.meta.url)),
      directory,
      join(tmpdir(), 'core-checkout'),
      join(tmpdir(), 'new-operator'),
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside this repository/);
});

test('source snapshots exclude foreign ignored objects and untracked build inputs without changing the operator checkout', async (t) => {
  const { snapshotSource } = await import('./browser-core/source.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'ecs-browser-source-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'operator');
  const destination = join(dir, 'clean-build');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(source);
  function git(args) {
    const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(['init', '--quiet']);
  await writeFile(join(source, '.gitignore'), '*.o\n');
  await writeFile(join(source, 'core.c'), 'int original_core = 1;\n');
  git(['add', '.']);
  git([
    '-c',
    'user.name=ECS fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'Generated source fixture',
  ]);
  const commit = git(['rev-parse', 'HEAD']);
  await writeFile(join(source, 'old-sdk.o'), 'foreign SDK object');
  await writeFile(join(source, 'untracked-config.h'), '#define FOREIGN_BUILD 1\n');
  await writeFile(join(source, 'core.c'), 'uncommitted source change\n');
  snapshotSource(source, destination, commit);
  assert.equal(await readFile(join(destination, 'core.c'), 'utf8'), 'int original_core = 1;\n');
  await assert.rejects(readFile(join(destination, 'old-sdk.o')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(destination, 'untracked-config.h')), { code: 'ENOENT' });
  assert.equal(await readFile(join(source, 'old-sdk.o'), 'utf8'), 'foreign SDK object');
  assert.equal(await readFile(join(source, 'core.c'), 'utf8'), 'uncommitted source change\n');
  assert.throws(
    () => snapshotSource(source, join(dir, 'wrong-build'), '0'.repeat(40)),
    /pinned commit/,
  );
});
