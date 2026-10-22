import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, signIn, test } from './fixture';

for (const bulk of [false, true])
  test(`${bulk ? 'library' : 'game'} matching cannot start with only disabled online providers selected`, async ({
    page,
    fixture,
  }) => {
    await fixture.legacy();
    await signIn(page, fixture);
    await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
    if (bulk) await page.getByRole('button', { name: 'Match library', exact: true }).click();
    else await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
    const panel = bulk
      ? page.getByRole('dialog', { name: 'Match library', exact: true })
      : page.getByRole('region', { name: 'Metadata and artwork matching' });
    const action = panel.getByRole('button', {
      name: bulk ? 'Start library matching' : 'Find matches',
      exact: true,
    });
    await expect(action).toBeEnabled();
    await panel.getByText('Providers and manager', { exact: true }).click();
    await panel.getByRole('checkbox', { name: 'Include online providers', exact: true }).uncheck();
    const local = panel.getByRole('checkbox', { name: /\(local\)$/ });
    expect(await local.count()).toBeGreaterThan(0);
    for (const checkbox of await local.all()) await checkbox.uncheck();
    await expect(action).toBeDisabled();
    await panel.getByRole('checkbox', { name: 'Include online providers', exact: true }).check();
    await expect(action).toBeEnabled();
  });

test('committed match saves and removals survive a lost response without duplicate writes', async ({
  page,
  fixture,
}) => {
  const root = await fixture.legacy();
  await writeFile(
    join(root.path, 'external.json'),
    JSON.stringify({ title: 'Generated match title' }),
  );
  await fixture.client.scanRoot(root.id);
  let writes = 0;
  await page.route('**/api/v1/sources/*/matches/selections{,/*}', async (route) => {
    if (!['PUT', 'DELETE'].includes(route.request().method())) return route.continue();
    const response = await route.fetch();
    if (!response.ok()) {
      await route.fulfill({ response });
      expect(response.status()).toBe(200);
      return;
    }
    writes++;
    await route.abort('failed');
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
  const matching = page.getByRole('region', { name: 'Metadata and artwork matching' });
  await matching.getByRole('button', { name: 'Find matches', exact: true }).click();
  await matching.getByRole('button', { name: 'Save metadata', exact: true }).click();
  await expect(
    matching.getByRole('button', { name: 'Remove saved metadata', exact: true }),
  ).toBeVisible();
  await expect(matching.getByRole('alert')).toHaveCount(0);
  expect(writes).toBe(1);
  await matching.getByRole('button', { name: 'Remove saved metadata', exact: true }).click();
  await expect(matching.getByText('No matches have been saved for this game.')).toBeVisible();
  await expect(matching.getByRole('alert')).toHaveCount(0);
  expect(writes).toBe(2);
});

for (const bulk of [false, true])
  test(`a temporary provider-list failure retries in the ${bulk ? 'library' : 'game'} matching panel`, async ({
    page,
    fixture,
  }) => {
    await fixture.legacy();
    let reads = 0;
    await page.route('**/api/v1/matching/plugins', async (route) => {
      if (++reads === 1)
        await route.fulfill({
          status: 503,
          json: {
            type: 'urn:ecs:problem:unavailable',
            title: 'Provider list temporarily unavailable',
            status: 503,
          },
        });
      else await route.continue();
    });
    await signIn(page, fixture);
    await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
    if (bulk) await page.getByRole('button', { name: 'Match library', exact: true }).click();
    else await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
    const panel = bulk
      ? page.getByRole('dialog', { name: 'Match library', exact: true })
      : page.getByRole('region', { name: 'Metadata and artwork matching' });
    const action = panel.getByRole('button', {
      name: bulk ? 'Start library matching' : 'Find matches',
      exact: true,
    });
    await expect(panel.getByRole('alert')).toContainText('Provider list temporarily unavailable');
    await expect(action).toBeDisabled();
    await panel.getByRole('button', { name: 'Retry matching providers', exact: true }).click();
    await expect(action).toBeEnabled();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    expect(reads).toBe(2);
  });

test('lookups open a populated category and retain the selected category while it has suggestions', async ({
  page,
  fixture,
}) => {
  await fixture.legacy();
  let lookups = 0;
  await page.route('**/api/v1/sources/*/matches', async (route) => {
    lookups++;
    const kinds =
      lookups === 1 ? ['artwork'] : lookups === 2 ? ['metadata', 'artwork'] : ['metadata'];
    await route.fulfill({
      json: {
        sourceId: new URL(route.request().url()).pathname.split('/')[4],
        requestId: `lookup-${lookups}`,
        plugins: [],
        problems: [],
        candidates: kinds.map((kind) => ({
          id: `${lookups}-${kind}`,
          providerId: 'org.ecs.local',
          kind,
          title: `Suggestion ${lookups}`,
          confidence: 'local',
          metadata: {},
        })),
      },
    });
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
  const matching = page.getByRole('region', { name: 'Metadata and artwork matching' });
  await matching.getByRole('button', { name: 'Find matches', exact: true }).click();
  await expect(matching.getByRole('button', { name: 'Artwork (1)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(matching.getByRole('heading', { name: 'Suggestion 1' })).toBeVisible();
  await matching.getByRole('button', { name: 'Find matches', exact: true }).click();
  await expect(matching.getByRole('heading', { name: 'Suggestion 2' })).toBeVisible();
  await expect(matching.getByRole('button', { name: 'Artwork (1)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await matching.getByRole('button', { name: 'Find matches', exact: true }).click();
  await expect(matching.getByRole('button', { name: 'Metadata (1)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(matching.getByRole('heading', { name: 'Suggestion 3' })).toBeVisible();
});

test('a transient saved-match load can retry inside the open game', async ({ page, fixture }) => {
  await fixture.legacy();
  let reads = 0;
  await page.route('**/api/v1/sources/*/matches/selections', async (route) => {
    if (++reads === 1)
      await route.fulfill({
        status: 503,
        json: {
          type: 'urn:ecs:problem:unavailable',
          title: 'Temporarily unavailable',
          status: 503,
        },
      });
    else await route.continue();
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
  const matching = page.getByRole('region', { name: 'Metadata and artwork matching' });
  await expect(matching.getByRole('alert')).toBeVisible();
  await expect(matching.getByText('No matches have been saved for this game.')).toHaveCount(0);
  await matching.getByRole('button', { name: 'Retry saved matches', exact: true }).click();
  await expect(matching.getByText('No matches have been saved for this game.')).toBeVisible();
  await expect(matching.getByRole('alert')).toHaveCount(0);
  await expect(matching.getByRole('button', { name: 'Retry saved matches' })).toHaveCount(0);
  expect(reads).toBe(2);
});

test('organization is opt-in, previews before copy or move, and retains moved records', async ({
  page,
  fixture,
}) => {
  const { mkdir, readFile } = await import('node:fs/promises');
  const root = await fixture.legacy();
  await writeFile(
    join(root.path, 'external.json'),
    JSON.stringify({ title: 'Organized generated game' }),
  );
  const targetPath = join(fixture.directory, 'Organized files');
  await mkdir(targetPath);
  const target = await fixture.client.addRoot({
    path: targetPath,
    label: 'Organization destination',
  });
  await fixture.client.scanRoot(root.id);
  const sources = await fixture.client.sources();
  const original = sources.items.find((source) => source.name === 'external.nes');
  expect(original).toBeTruthy();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
  const matching = page.getByRole('region', { name: 'Metadata and artwork matching' });
  await matching.getByRole('button', { name: 'Find matches', exact: true }).click();
  await matching.getByRole('button', { name: 'Save metadata', exact: true }).click();
  await expect(
    matching.getByRole('button', { name: 'Remove saved metadata', exact: true }),
  ).toBeVisible();
  const organization = page.getByRole('region', { name: 'Organize original file', exact: true });
  await expect(organization.getByRole('button', { name: 'Confirm copy' })).toHaveCount(0);
  await organization.getByRole('button', { name: 'Organize files', exact: true }).click();
  await organization.getByRole('combobox', { name: /^Destination folder/ }).selectOption(target.id);
  await organization.getByRole('button', { name: 'Preview organization', exact: true }).click();
  await expect(
    organization.getByRole('button', { name: 'Confirm copy', exact: true }),
  ).toBeVisible();
  await expect(
    organization.getByText(/Organized generated game\/external.nes/, { exact: false }),
  ).toBeVisible();
  expect(await readFile(join(root.path, 'external.nes'))).toEqual(
    Buffer.from([78, 69, 83, 26, 0, 0, 0, 0]),
  );
  await organization.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(
    (await fixture.client.sources()).items.filter((source) => source.rootId === target.id),
  ).toHaveLength(0);
  await organization.getByRole('button', { name: 'Organize files', exact: true }).click();
  await organization.getByRole('combobox', { name: /^Destination folder/ }).selectOption(target.id);
  await organization.getByRole('combobox', { name: /^Action/ }).selectOption('move');
  await organization.getByRole('button', { name: 'Preview organization', exact: true }).click();
  await organization.getByRole('button', { name: 'Confirm move', exact: true }).click();
  await expect(organization.getByRole('status')).toContainText('File moved');
  await fixture.client.scanRoot(target.id);
  const moved = (await fixture.client.sources()).items.find((source) => source.id === original?.id);
  expect(moved?.title).toBe('Organized generated game');
  expect((await fixture.client.sourceSelections(original?.id ?? '')).matches).toHaveLength(1);
  await organization.getByRole('button', { name: 'Organize files', exact: true }).click();
  await organization.getByRole('combobox', { name: /^Destination folder/ }).selectOption(root.id);
  await organization.getByRole('combobox', { name: /^Action/ }).selectOption('copy');
  await organization.getByRole('button', { name: 'Preview organization', exact: true }).click();
  await organization.getByRole('button', { name: 'Confirm copy', exact: true }).click();
  await expect(organization.getByRole('status')).toContainText('File copied');
  const copies = (await fixture.client.sources()).items.filter((source) => source.kind === 'rom');
  expect(copies).toHaveLength(2);
  const copy = copies.find((source) => source.id !== original?.id);
  expect(copy?.rootId).toBe(root.id);
  expect(copy?.title).toBe('Organized generated game');
  expect((await fixture.client.sourceSelections(copy?.id ?? '')).matches).toHaveLength(1);

  await expect(
    page.getByRole('heading', { name: 'Organized generated game', exact: true, level: 1 }),
  ).toBeVisible();
});
