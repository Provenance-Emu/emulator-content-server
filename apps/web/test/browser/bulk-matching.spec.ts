import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContentClient } from '@ecs/client';
import type { Locator, Page } from '@playwright/test';
import { expect, libraryTool, signIn, test } from './fixture';

async function openActivity(page: Page): Promise<Locator> {
  await libraryTool(page, 'Library activity');
  return page.getByRole('dialog', { name: 'Library activity', exact: true });
}
async function useLocalMatching(panel: Locator): Promise<void> {
  await panel
    .locator('summary')
    .filter({ hasText: /^Matching options$/ })
    .click();
  await panel.getByRole('checkbox', { name: 'Include online providers', exact: true }).uncheck();
}
async function openLibraryActions(panel: Locator): Promise<void> {
  const actions = panel.locator('details.matching-secondary-actions');
  if (!(await actions.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await actions.locator('summary').click();
  }
}

test('owner sessions share a server job across close/reopen and persist explicit review acknowledgement', async ({
  page,
  browser,
  fixture,
}) => {
  const root = await fixture.legacy();
  await writeFile(
    join(root.path, 'external.json'),
    JSON.stringify({ title: 'Generated shared hint' }),
  );
  await fixture.client.assignRoot(root.id, { libraryId: fixture.empty.id });
  await fixture.client.scanRoot(root.id);
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  let panel = await openActivity(page);
  await useLocalMatching(panel);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/library-jobs',
  );
  await panel
    .getByRole('button', { name: 'Find missing artwork and details', exact: true })
    .click();
  const { job } = await (await created).json();
  await expect(panel.getByRole('combobox', { name: 'Server activity', exact: true })).toHaveValue(
    job.id,
  );
  await expect(panel.getByText('external.nes', { exact: true })).toBeVisible();
  await expect(panel.getByRole('status')).toContainText('completed');
  await panel.getByRole('button', { name: 'Close Library activity', exact: true }).click();
  panel = await openActivity(page);
  await expect(panel.getByRole('combobox', { name: 'Server activity', exact: true })).toHaveValue(
    job.id,
  );
  await expect(panel.getByText('external.nes', { exact: true })).toBeVisible();

  const secondContext = await browser.newContext();
  try {
    const second = await secondContext.newPage();
    const session = await new ContentClient(fixture.origin).login(
      'browser-owner',
      fixture.password,
    );
    await signIn(second, { ...fixture, session });
    await second.getByRole('button', { name: 'Empty shelf', exact: true }).click();
    const shared = await openActivity(second);
    await expect(
      shared.getByRole('combobox', { name: 'Server activity', exact: true }),
    ).toHaveValue(job.id);
    await expect(shared.getByText('external.nes', { exact: true })).toBeVisible();
    await shared.getByRole('button', { name: 'Review', exact: true }).click();
    await shared.getByRole('button', { name: 'Done reviewing this game', exact: true }).click();
    await expect(shared.getByRole('region', { name: 'Library job progress' })).toContainText(
      '0 need review',
    );
    await openLibraryActions(panel);
    await panel.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await expect(panel.getByText('external.nes', { exact: true })).toHaveCount(0);
    await expect(panel.getByRole('region', { name: 'Library job progress' })).toContainText(
      '0 need review',
    );
    const results = await fixture.client.libraryJobItems(job.id, { status: 'reviewed' });
    expect(results.items).toHaveLength(1);
    expect(
      (await fixture.client.sourceSelections(results.items[0]?.sourceId ?? '')).matches,
    ).toHaveLength(0);
    expect(
      (await fixture.client.libraryJobs()).jobs.filter((entry) => entry.kind === 'match'),
    ).toHaveLength(1);
  } finally {
    await secondContext.close();
  }
});

test('unmatched games retry on the same durable job after a sidecar is discovered', async ({
  page,
  fixture,
}) => {
  const root = await fixture.legacy();
  await fixture.client.assignRoot(root.id, { libraryId: fixture.empty.id });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  const panel = await openActivity(page);
  await useLocalMatching(panel);
  await panel
    .getByRole('button', { name: 'Find missing artwork and details', exact: true })
    .click();
  await expect(
    panel.getByRole('button', { name: 'Retry unmatched games', exact: true }),
  ).toBeVisible();
  const id = await panel
    .getByRole('combobox', { name: 'Server activity', exact: true })
    .inputValue();
  await panel.getByRole('combobox', { name: 'Results', exact: true }).selectOption('unmatched');
  await expect(panel.getByText('external.nes', { exact: true })).toBeVisible();
  await writeFile(
    join(root.path, 'external.json'),
    JSON.stringify({ title: 'New generated suggestion' }),
  );
  await fixture.client.scanRoot(root.id);
  const resumed = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/v1/library-jobs/${id}/resume`,
  );
  await panel.getByRole('button', { name: 'Retry unmatched games', exact: true }).click();
  expect((await resumed).postDataJSON()).toEqual({ retry: 'unmatched' });
  await expect(panel.getByRole('combobox', { name: 'Server activity', exact: true })).toHaveValue(
    id,
  );
  await expect(panel.getByRole('region', { name: 'Library job progress' })).toContainText(
    '1 need review',
  );
  await panel.getByRole('combobox', { name: 'Results', exact: true }).selectOption('review');
  await expect(panel.getByText('external.nes', { exact: true })).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Retry unmatched games', exact: true }),
  ).toHaveCount(0);
  expect(
    (await fixture.client.libraryJobs()).jobs.filter((entry) => entry.kind === 'match'),
  ).toHaveLength(1);
});

test('review saves categories before acknowledging the shared result and updates the collection', async ({
  page,
  fixture,
}) => {
  const root = await fixture.legacy();
  await writeFile(join(root.path, 'external.json'), JSON.stringify({ title: 'A matched title' }));
  await writeFile(
    join(root.path, 'external.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  await fixture.client.assignRoot(root.id, { libraryId: fixture.empty.id });
  await fixture.client.scanRoot(root.id);
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  const panel = await openActivity(page);
  await useLocalMatching(panel);
  await panel
    .getByRole('button', { name: 'Find missing artwork and details', exact: true })
    .click();
  await expect(panel.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
  const id = await panel
    .getByRole('combobox', { name: 'Server activity', exact: true })
    .inputValue();
  await panel.getByRole('button', { name: 'Review', exact: true }).click();
  let failSave = true;
  await page.route(
    (url) => /^\/api\/v1\/sources\/[^/]+\/matches\/selections$/.test(url.pathname),
    async (route) => {
      if (route.request().method() === 'PUT' && failSave) {
        failSave = false;
        return route.fulfill({
          status: 503,
          json: {
            type: 'urn:ecs:problem:unavailable',
            title: 'Generated failed save',
            status: 503,
          },
        });
      }
      return route.continue();
    },
  );
  await panel.getByRole('button', { name: 'Save and next category', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Generated failed save');
  expect((await fixture.client.libraryJob(id)).job.review).toBe(1);
  await panel.getByRole('button', { name: 'Save and next category', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Artwork (1)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await panel.getByRole('button', { name: 'Save and next game', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Library job progress' })).toContainText(
    '0 need review',
  );
  const results = await fixture.client.libraryJobItems(id, { status: 'reviewed' });
  expect(results.items).toHaveLength(1);
  expect(
    (await fixture.client.sourceSelections(results.items[0]?.sourceId ?? '')).matches
      .map((match) => match.kind)
      .sort(),
  ).toEqual(['artwork', 'metadata']);
  await panel.getByRole('button', { name: 'Close Library activity', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Open A matched title', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open A matched title', exact: true }).locator('img'),
  ).toBeVisible();
});

test('older matching results remain reachable after more than one page of folder scans', async ({
  page,
  fixture,
}) => {
  const root = await fixture.legacy();
  await fixture.client.assignRoot(root.id, { libraryId: fixture.empty.id });
  const { job } = await fixture.client.createLibraryJob({
    kind: 'match',
    libraryId: fixture.empty.id,
    options: { online: false, checksum: false },
  });
  await expect
    .poll(async () => (await fixture.client.libraryJob(job.id)).job.state)
    .toBe('completed');
  for (let index = 0; index < 21; index++) await fixture.client.scanRoot(root.id);
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  const panel = await openActivity(page);
  const history = panel.getByRole('combobox', { name: 'Server activity', exact: true });
  await expect(history.locator(`option[value="${job.id}"]`)).toHaveCount(0);
  await panel.getByRole('button', { name: 'Load older activity', exact: true }).click();
  await history.selectOption(job.id);
  await expect(panel.getByRole('region', { name: 'Library job progress' })).toContainText(
    '1 unmatched',
  );
  await openLibraryActions(panel);
  await panel.getByRole('button', { name: 'Refresh activity', exact: true }).click();
  await expect(history).toHaveValue(job.id);
  await expect(panel.getByRole('region', { name: 'Library job progress' })).toContainText(
    '1 unmatched',
  );
});

test('filename fallback is an explicit per-job choice', async ({ page, fixture }) => {
  const root = await fixture.legacy();
  await fixture.client.assignRoot(root.id, { libraryId: fixture.empty.id });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  const panel = await openActivity(page);
  await useLocalMatching(panel);
  const policy = panel.getByRole('checkbox', {
    name: 'For new jobs, use exact filenames when a game ID is unavailable',
    exact: true,
  });
  await expect(policy).toBeChecked();
  await policy.uncheck();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/library-jobs',
  );
  await panel
    .getByRole('button', { name: 'Find missing artwork and details', exact: true })
    .click();
  const response = await created;
  expect(response.request().postDataJSON().options.allowExactNames).toBe(false);
  expect((await response.json()).job.options.allowExactNames).toBeUndefined();
  await expect(
    panel.getByText('This job uses verified ROM or disc IDs for automatic selections.', {
      exact: true,
    }),
  ).toBeVisible();
});

test('catalog updates use one shared matching job and stay unavailable in offline mode', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  const panel = await openActivity(page);
  const update = panel.getByRole('button', {
    name: 'Update catalogs and find matches',
    exact: true,
  });
  await openLibraryActions(panel);
  await expect(update).toBeEnabled();
  await page.route('**/api/v1/library-jobs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    expect(route.request().postDataJSON()).toMatchObject({
      kind: 'match',
      options: { online: true, refreshCatalogs: true, checksum: true },
    });
    expect(route.request().postDataJSON().options.providerIds).not.toContain(
      'org.ecs.catalog.patches',
    );
    expect(route.request().postDataJSON().options.providerIds).not.toContain(
      'org.ecs.catalog.cheats',
    );
    return route.fulfill({
      status: 503,
      json: {
        type: 'urn:ecs:problem:generated',
        title: 'Generated catalog preflight failure',
        status: 503,
      },
    });
  });
  await update.click();
  await expect(panel.getByRole('alert')).toContainText('Generated catalog preflight failure');
  await useLocalMatching(panel);
  await expect(update).toBeDisabled();
});
