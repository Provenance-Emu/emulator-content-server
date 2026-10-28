import { readFile, rm } from 'node:fs/promises';
import { expect, libraryTool, openAddContent, signIn, test } from './fixture';

test('all games remain reachable in a bounded collection and detail back restores focus', async ({
  page,
  fixture,
}, testInfo) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  const results = page.getByRole('button', { name: /^Open Game / });
  await expect(results).toHaveCount(50);
  await page.screenshot({ path: testInfo.outputPath('library-desktop.png') });
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(results.first()).toHaveAccessibleName('Open Game 050');
  const opened = results.nth(49);
  await opened.scrollIntoViewIfNeeded();
  const savedScroll = await page.evaluate(() => window.scrollY);
  await opened.click();
  await expect(page.getByRole('heading', { name: 'Game 099', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to collection' }).click();
  await expect(opened).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(savedScroll);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(results).toHaveCount(20);
  await expect(results.last()).toHaveAccessibleName('Open Game 119');
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(results).toHaveCount(50);
  await page.getByRole('combobox', { name: 'Sort', exact: true }).selectOption('name_desc');
  await expect(results.first()).toHaveAccessibleName('Open Game 119');
  await page.getByRole('radio', { name: 'List', exact: true }).check();
  await expect(page.getByRole('table', { name: 'Collection results' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search collection' }).fill('Game 119');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(results).toHaveCount(1);
  await page
    .getByRole('searchbox', { name: 'Search collection' })
    .fill('No generated game matches');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('No matching files or games.')).toBeVisible();
});

test('categories and settings preserve contextual files without scanning or legacy source reads', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  for (const [tab, file] of [
    ['Saves', 'sample.sav'],
    ['Media', 'sample.png'],
    ['System files', 'sample.bin'],
  ]) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByRole('button', { name: `Open ${file}`, exact: true })).toBeVisible();
  }
  fixture.requests.length = 0;
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Libraries', exact: true })).toBeVisible();
  for (const name of ['Storage', 'Access', 'Activity', 'Server status', 'Libraries']) {
    await page.getByRole('button', { name, exact: true }).click();
    if (name === 'Storage')
      await page.getByRole('tab', { name: 'Uploaded files', exact: true }).click();
  }
  expect(
    fixture.requests.some(
      (request) => request.includes('/scan') || request === 'GET /api/v1/sources',
    ),
  ).toBe(false);
  await page.getByRole('button', { name: 'Back to library' }).click();
  await expect(page.getByRole('tab', { name: 'System files', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('restricted readers see permitted libraries and no owner or upload actions', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture, true);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unassigned folders', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Empty shelf', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add games', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Game 000', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download sample.nes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a file', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByText('Game 000', { exact: true })).toHaveCount(0);
});

test('narrow navigation supports keyboard, contained dialog focus and explicit upload system', async ({
  page,
  fixture,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Library navigation' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Arcade', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await openAddContent(page, 'Upload files');
  const dialog = page.getByRole('dialog', { name: 'Upload files' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'System', exact: true })).toHaveValue('');
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Add games', exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('library-narrow.png') });
  await page.getByRole('tab', { name: 'Games', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Saves', exact: true })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Saves', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('unassigned folders reflect external source add and removal on authenticated periodic invalidation', async ({
  page,
  fixture,
}) => {
  await page.clock.install();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await expect(page.getByText('This collection is empty.')).toBeVisible();
  let before = await fixture.client.changes({ cursor: '0', limit: 100 });
  while (before.changes.length)
    before = await fixture.client.changes({ cursor: before.nextCursor, limit: 100 });
  const root = await fixture.legacy();
  const after = await fixture.client.changes({ cursor: before.nextCursor, limit: 100 });
  expect(after.changes).toHaveLength(0);
  await page.clock.runFor(16_000);
  await expect(page.getByRole('button', { name: 'Open external.nes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'external.nes', exact: true })).toBeVisible();
  await fixture.client.removeRoot(root.id);
  await page.clock.runFor(16_000);
  await expect(page.getByRole('button', { name: 'Open external.nes', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'external.nes', exact: true })).toHaveCount(0);
});

test('managed file downloads preserve bytes and save adoption preserves both copies', async ({
  page,
  fixture,
}) => {
  const initial = await fixture.client.manifest(fixture.game.id);
  const copy = await fixture.client.upload({
    libraryId: fixture.library.id,
    itemId: fixture.game.id,
    kind: 'battery_save',
    displayName: 'conflict.sav',
    relativePath: 'sample.sav',
    baseRevision: 1,
    body: new Uint8Array([9, 8, 7]),
  });
  expect(copy.conflictOf).toBeTruthy();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await page.getByRole('button', { name: 'Open Game 000', exact: true }).click();
  const receipt = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download sample.nes', exact: true }).click();
  const download = await receipt;
  const path = await download.path();
  expect(path).toBeTruthy();
  expect([...(await readFile(path ?? ''))]).toEqual([1, 2, 3, 4]);
  await page.getByRole('button', { name: 'Back to collection' }).click();
  await page.getByRole('tab', { name: 'Saves', exact: true }).click();
  await page.getByRole('button', { name: 'Open conflict.sav (conflict)', exact: true }).click();
  await page.getByRole('button', { name: 'Use this copy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this copy', exact: true })).toHaveCount(0);
  const manifest = await fixture.client.manifest(fixture.game.id);
  expect(manifest.files.filter((file) => file.kind === 'battery_save')).toHaveLength(2);
  expect(manifest.revision).toBeGreaterThan(initial.revision);
});

test('empty libraries and offline source details explain their actual state', async ({
  page,
  fixture,
}) => {
  const root = await fixture.legacy('offline.nes');
  await rm(root.path, { recursive: true });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await expect(page.getByText('This collection is empty.')).toBeVisible();
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await page.getByRole('button', { name: 'Open offline.nes', exact: true }).click();
  await expect(
    page.getByText('This file is unavailable while its server folder is offline.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download offline.nes', exact: true }),
  ).toBeDisabled();
});

for (const status of [401, 403] as const)
  test(`preview ${status} clears private collection bodies at the application boundary`, async ({
    page,
    fixture,
  }) => {
    const artwork = await fixture.artwork();
    await signIn(page, fixture);
    await page.getByRole('button', { name: 'Arcade', exact: true }).click();
    await expect(page.locator('img[src^="blob:"]')).toHaveCount(1);
    await page.route(`**/api/v1/files/${artwork.id}/content`, (route) =>
      route.fulfill({
        status,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Access changed', status }),
      }),
    );
    let reads = 0;
    await page.route('**/api/v1/browse?**', async (route) => {
      reads++;
      if (reads > 1)
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({ type: 'about:blank', title: 'Try again', status: 503 }),
        });
      else await route.continue();
    });
    await libraryTool(page, 'Refresh');
    if (status === 401)
      await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    else await expect(page.getByRole('alert')).toContainText('Try again');
    await expect(page.getByRole('button', { name: /^Open Game / })).toHaveCount(0);
    await expect(page.locator('img[src^="blob:"]')).toHaveCount(0);
    if (status === 403)
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  });

test('upload waits for an explicit system and keeps its dialog open while sending', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await openAddContent(page, 'Upload files');
  const dialog = page.getByRole('dialog', { name: 'Upload files' });
  await dialog.getByLabel('File', { exact: true }).setInputFiles({
    name: 'Uploaded game.nes',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([1, 2, 3, 4]),
  });
  await expect(dialog.getByRole('button', { name: 'Upload', exact: true })).toBeEnabled();
  await dialog
    .getByRole('combobox', { name: 'System', exact: true })
    .selectOption('com.provenance.nes');
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => {};
  const sending = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route('**/api/v1/uploads/*/content', async (route) => {
    reached();
    await held;
    await route.continue();
  });
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await sending;
  try {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  } finally {
    release();
  }
  await expect(dialog.getByText('1 succeeded · 0 unfinished')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close Upload files', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search collection' }).fill('Uploaded game');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Uploaded game', exact: true })).toBeVisible();
});

test('a denied source download clears detail until a fresh bounded page authorizes reopening', async ({
  page,
  fixture,
}) => {
  await fixture.legacy();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
  await page.route('**/api/v1/sources/*/content', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/problem+json',
      body: JSON.stringify({ type: 'about:blank', title: 'Access changed', status: 403 }),
    }),
  );
  await page.route('**/api/v1/browse?**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: JSON.stringify({ type: 'about:blank', title: 'Try again', status: 503 }),
    }),
  );
  await page.getByRole('button', { name: 'Download external.nes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'external.nes', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Try again');
  await page.unroute('**/api/v1/browse?**');
  await libraryTool(page, 'Refresh');
  await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'external.nes', exact: true })).toBeVisible();
  expect(fixture.requests.some((request) => request === 'GET /api/v1/sources')).toBe(false);
});

test('periodic membership revocation clears an open restricted detail and selected scope', async ({
  page,
  fixture,
}) => {
  await page.clock.install();
  await signIn(page, fixture, true);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await page.getByRole('button', { name: 'Open Game 000', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download sample.nes' })).toBeVisible();
  const reader = fixture.catalog.listUsers().find((user) => user.username === 'browser-reader');
  const owner = fixture.catalog.listUsers().find((user) => user.isOwner);
  if (!reader || !owner) throw new Error('Missing fixture users');
  fixture.catalog.removeMember(fixture.library.id, reader.id, owner.id);
  await page.clock.runFor(16_000);
  await expect(page.getByRole('heading', { name: 'Game 000', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Arcade', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your libraries', exact: true })).toBeVisible();
});

test('an expired browse session signs out immediately and clears private navigation', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Game 000', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const revoked = await fetch(`${fixture.origin}/api/v1/auth/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${fixture.session.token}` },
  });
  expect(revoked.status).toBe(204);
  await libraryTool(page, 'Refresh');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Arcade', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Open Game / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
});

test('supported managed and source Play actions navigate only to the isolated player route', async ({
  page,
  fixture,
}) => {
  await fixture.legacy();
  const manifest = await fixture.client.manifest(fixture.game.id);
  const rom = manifest.files.find((file) => file.kind === 'rom');
  const sources = await fixture.client.browse({ unassigned: true, category: 'games' });
  if (!rom || !sources.items[0]) throw new Error('Missing generated playable entries');
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await page.getByRole('button', { name: 'Open Game 000', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/play/');
  let target = new URL(page.url());
  expect(target.origin).toBe(fixture.origin);
  expect(target.searchParams.get('item')).toBe(fixture.game.id);
  expect(target.searchParams.get('asset')).toBe(rom.id);
  expect(target.searchParams.has('token')).toBe(false);
  await page.goto(`${fixture.origin}/ui/`);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/play/');
  target = new URL(page.url());
  expect(target.searchParams.get('source')).toBe(sources.items[0].id);
  expect(target.searchParams.has('token')).toBe(false);
});
