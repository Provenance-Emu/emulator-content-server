import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, signIn, test } from './fixture';

for (const extension of ['cue', 'gdi'])
  test(`${extension} matching enables game-ID reads for a grouped disc`, async ({
    page,
    fixture,
  }) => {
    const root = await fixture.legacy();
    const descriptor =
      extension === 'cue'
        ? 'FILE "track.bin" BINARY\nTRACK 01 MODE1/2048\nINDEX 01 00:00:00\n'
        : '1\n1 0 4 2048 track.bin 0\n';
    await writeFile(join(root.path, `disc.${extension}`), descriptor);
    await writeFile(join(root.path, 'track.bin'), Buffer.alloc(2048));
    await fixture.client.scanRoot(root.id);
    await signIn(page, fixture);
    await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
    await page.getByRole('button', { name: `Open disc.${extension}`, exact: true }).click();
    const panel = page.getByRole('region', { name: 'Metadata and artwork matching' });
    await panel
      .locator('summary')
      .filter({ hasText: /^Matching options$/ })
      .click();
    const identify = panel.getByRole('checkbox', {
      name: 'Read game IDs and verify hashes',
      exact: true,
    });
    await expect(identify).toBeEnabled();
    await identify.check();
    const request = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        /\/sources\/[^/]+\/matches$/.test(new URL(request.url()).pathname),
    );
    await panel.getByRole('button', { name: 'Find matches', exact: true }).click();
    expect((await request).postDataJSON().checksum).toBe(true);
  });
