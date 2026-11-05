/** Convert our original two-session audio-sector program with upstream chdman. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jaguarSmokeCue } from './generate-smoke-program.mjs';

/** Requires the session-preserving chdman from Virtual Jaguar's jagcd-tools release.
 * All intermediate media stays in an external temporary directory and is removed.
 * Four-frame hunks exercise CD Deflate with both tracks in separate hunks.
 */
export function jaguarSmokeChd(chdman = process.env.ECS_ACCEPTANCE_CHDMAN ?? 'chdman') {
  const directory = mkdtempSync(join(tmpdir(), 'ecs-original-jaguar-chd-'));
  try {
    const { cue, tracks } = jaguarSmokeCue();
    for (const track of tracks) writeFileSync(join(directory, track.name), track.bytes);
    writeFileSync(join(directory, 'original.cue'), cue);
    const image = join(directory, 'original.chd');
    execFileSync(
      chdman,
      ['createcd', '-i', join(directory, 'original.cue'), '-o', image, '-c', 'cdzl', '-hs', '9792'],
      {
        stdio: 'pipe',
        timeout: 30_000,
      },
    );
    for (const index of [0, 1]) {
      let metadata;
      try {
        metadata = execFileSync(
          chdman,
          ['dumpmeta', '-i', image, '-t', 'CHSE', '-ix', String(index)],
          {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 10_000,
          },
        );
      } catch (cause) {
        throw new Error(
          'Jaguar CHD smoke requires session-preserving chdman: set ECS_ACCEPTANCE_CHDMAN to the Virtual Jaguar jagcd-tools binary.',
          { cause },
        );
      }
      if (!metadata.includes(`SESSION:${index + 1}`))
        throw new Error('Generated Jaguar CHD lost its two-session metadata');
    }
    return readFileSync(image);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
