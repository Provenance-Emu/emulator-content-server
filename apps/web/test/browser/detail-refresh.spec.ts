import { readFile, rename } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { expect, signIn, test } from './fixture';

test('refreshing an open source checks current availability without rescanning folders', async ({
  page,
  fixture,
}) => {
  await page.clock.install();
  const root = await fixture.legacy();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
  const download = page.getByRole('button', { name: 'Download external.nes', exact: true });
  await expect(download).toBeEnabled();
  await rename(root.path, `${root.path}-offline`);
  fixture.requests.length = 0;
  await page.getByRole('button', { name: 'Refresh details', exact: true }).click();
  await expect(download).toBeDisabled();
  await expect(
    page.getByText('This file is unavailable while its server folder is offline.'),
  ).toBeVisible();
  await rename(`${root.path}-offline`, root.path);
  await page.getByRole('button', { name: 'Refresh details', exact: true }).click();
  await expect(download).toBeEnabled();
  await expect(
    page.getByText('This file is unavailable while its server folder is offline.'),
  ).toHaveCount(0);
  expect(
    fixture.requests.some(
      (request) => request.includes('/scan') || request === 'GET /api/v1/sources',
    ),
  ).toBe(false);
});

test('game details show and verify the saved patch before downloading it', async ({
  page,
  fixture,
}) => {
  const root = await fixture.legacy();
  const source = fixture.catalog.listSources(root.id)[0];
  const owner = fixture.catalog.listUsers()[0];
  if (!source || !owner) throw new Error('Missing scanned fixture');
  const patch = Buffer.concat([
    Buffer.from('BPS1'),
    Buffer.from([0x84, 0x85, 0x80]),
    Buffer.alloc(12),
  ]);
  patch.writeUInt32LE(0x12345678, patch.length - 12);
  patch.writeUInt32LE(crc32(patch.subarray(0, -4)), patch.length - 4);
  fixture.catalog.saveSourceMatch(
    source.id,
    0,
    'patch',
    {
      id: 'generated-patch',
      providerId: 'fixture',
      kind: 'patch',
      title: 'Generated patch',
      confidence: 'local',
      metadata: {},
      originKind: null,
      contentAvailable: true,
      contentType: 'application/octet-stream',
      fileName: 'translation.bps',
      updatedAt: new Date().toISOString(),
    },
    patch,
    owner.id,
  );

  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
  const saved = page.getByRole('region', { name: 'Saved patches', exact: true });
  await expect(saved.getByText('translation.bps', { exact: true })).toBeVisible();
  await expect(saved.getByText('12345678', { exact: true })).toBeVisible();
  const button = page.getByRole('button', { name: 'Download patch', exact: true });
  await expect(button).toHaveCount(1);

  const content = '**/api/v1/sources/*/companions/*/content';
  await page.route(content, (route) => route.fulfill({ body: Buffer.alloc(patch.length) }));
  await button.click();
  await expect(saved.getByRole('alert')).toContainText('advertised SHA-256');
  await page.unroute(content);

  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(download.suggestedFilename()).toBe('translation.bps');
  const path = await download.path();
  if (!path) throw new Error('Missing downloaded patch');
  expect(await readFile(path)).toEqual(patch);
});
