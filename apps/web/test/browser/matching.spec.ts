import { expect, signIn, test } from './fixture';

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
