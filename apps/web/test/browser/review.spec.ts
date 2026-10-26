import { expect, libraryTool, signIn, test } from './fixture';

const problem = (status: number) => ({
  status,
  contentType: 'application/problem+json',
  body: JSON.stringify({ type: 'about:blank', title: 'Access denied', status }),
});

test('the production interface starts on a real insecure HTTP nonloopback origin', async ({
  page,
  fixture,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://ecs-fix.invalid/**', async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      response: await route.fetch({ url: fixture.origin + url.pathname + url.search }),
    });
  });
  await page.goto('http://ecs-fix.invalid/ui/');
  expect(
    await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID })),
  ).toEqual({ secure: false, uuid: 'undefined' });
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const status of [401, 403] as const)
  test(`settings summary ${status} clears private paths and propagates current authority`, async ({
    page,
    fixture,
  }) => {
    const root = await fixture.legacy();
    await signIn(page, fixture);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByText(root.path, { exact: true })).toBeVisible();
    await page.route('**/api/v1/root-summaries', (route) => route.fulfill(problem(status)));
    if (status === 403) await page.route('**/api/v1/roots', (route) => route.fulfill(problem(403)));
    await page.getByRole('button', { name: 'Refresh summaries' }).click();
    await expect(page.getByText(root.path, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'View files in External folder' })).toHaveCount(
      0,
    );
    if (status === 401)
      await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    else {
      await expect(
        page.getByRole('button', { name: 'Unassigned folders', exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    }
  });

test('summary transient failure retains rows and an obsolete pending summary cannot restore denied paths', async ({
  page,
  fixture,
}) => {
  await page.clock.install();
  const root = await fixture.legacy();
  const authorized = await fixture.client.rootSummaries();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText(root.path, { exact: true })).toBeVisible();
  await page.route('**/api/v1/root-summaries', (route) => route.fulfill(problem(503)));
  await page.getByRole('button', { name: 'Refresh summaries' }).click();
  await expect(page.getByRole('alert')).toContainText('Access denied');
  await expect(page.getByText(root.path, { exact: true })).toBeVisible();
  await page.unroute('**/api/v1/root-summaries');
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let reads = 0;
  await page.route('**/api/v1/root-summaries', async (route) => {
    if (++reads === 1) {
      reached();
      await held;
      await route.fulfill({ json: authorized });
    } else await route.fulfill(problem(403));
  });
  await page.getByRole('button', { name: 'Refresh summaries' }).click();
  await started;
  const resumed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/root-summaries' && response.status() === 200,
  );
  try {
    await page.clock.runFor(16_000);
    await expect(page.getByText(root.path, { exact: true })).toHaveCount(0);
  } finally {
    release();
  }
  await (await resumed).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByText(root.path, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
});

test('an obsolete summary denial cannot sign out a newer authorized settings generation', async ({
  page,
  fixture,
}) => {
  await page.clock.install();
  const root = await fixture.legacy();
  const authorized = await fixture.client.rootSummaries();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText(root.path, { exact: true })).toBeVisible();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let reads = 0;
  await page.route('**/api/v1/root-summaries', async (route) => {
    if (++reads === 1) {
      reached();
      await held;
      await route.fulfill(problem(401));
    } else await route.fulfill({ json: authorized });
  });
  await page.getByRole('button', { name: 'Refresh summaries' }).click();
  await started;
  const resumed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/root-summaries' && response.status() === 401,
  );
  try {
    await page.clock.runFor(16_000);
    await expect.poll(() => reads).toBe(2);
  } finally {
    release();
  }
  await (await resumed).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByText(root.path, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
});

for (const assigned of [false, true])
  test(`same-scope navigation clears explicit folder intent while settings return preserves it (${assigned ? 'library' : 'unassigned'})`, async ({
    page,
    fixture,
  }) => {
    const root = await fixture.legacy();
    if (assigned) await fixture.client.assignRoot(root.id, { libraryId: fixture.library.id });
    await signIn(page, fixture);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'View files in External folder' }).click();
    await expect(page.getByRole('combobox', { name: 'Library folder', exact: true })).toHaveValue(
      root.id,
    );
    await page.getByRole('searchbox', { name: 'Search collection' }).fill('external');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Back to library', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Library folder', exact: true })).toHaveValue(
      root.id,
    );
    const requests: URL[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/v1/browse') requests.push(url);
    });
    await page
      .getByRole('button', { name: assigned ? 'Arcade' : 'Unassigned folders', exact: true })
      .click();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(requests.at(-1)?.searchParams.get('rootId')).toBeNull();
    expect(requests.at(-1)?.searchParams.get('search')).toBe('external');
    await expect(page.getByRole('combobox', { name: 'Library folder', exact: true })).toHaveValue(
      '',
    );
    await expect(page.getByRole('searchbox', { name: 'Search collection' })).toHaveValue(
      'external',
    );
  });

test('authenticated invalidation refreshes folder options and clears a removed root without losing other filters', async ({
  page,
  fixture,
}) => {
  await page.clock.install();
  const first = await fixture.legacy();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Library folder', exact: true })).toBeVisible();
  const added = await fixture.legacy('remaining.nes');
  await page.clock.runFor(16_000);
  await expect(page.locator(`option[value="${added.id}"]`)).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Library folder', exact: true }).selectOption(first.id);
  await page.getByRole('searchbox', { name: 'Search collection' }).fill('external');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  fixture.requests.length = 0;
  await fixture.client.removeRoot(first.id);
  await page.clock.runFor(16_000);
  await expect(page.locator(`option[value="${first.id}"]`)).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Library folder', exact: true })).toHaveValue('');
  await expect(page.getByRole('searchbox', { name: 'Search collection' })).toHaveValue('external');
  expect(
    fixture.requests.some(
      (request) => request.includes('/scan') || request === 'GET /api/v1/sources',
    ),
  ).toBe(false);
});

for (const status of [401, 403] as const)
  test(`folder option ${status} clears cached owner choices and revalidates authority`, async ({
    page,
    fixture,
  }) => {
    const root = await fixture.legacy();
    await signIn(page, fixture);
    await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
    await expect(page.locator(`option[value="${root.id}"]`)).toHaveCount(1);
    await page.route('**/api/v1/root-summaries?**', (route) => route.fulfill(problem(status)));
    if (status === 403) await page.route('**/api/v1/roots', (route) => route.fulfill(problem(403)));
    await libraryTool(page, 'Refresh');
    await expect(page.locator(`option[value="${root.id}"]`)).toHaveCount(0);
    if (status === 401)
      await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    else {
      await expect(
        page.getByRole('button', { name: 'Unassigned folders', exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    }
  });

test('folder option transient errors retain the selected folder and other filters', async ({
  page,
  fixture,
}) => {
  const root = await fixture.legacy();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await page.getByRole('combobox', { name: 'Library folder', exact: true }).selectOption(root.id);
  await page.getByRole('searchbox', { name: 'Search collection' }).fill('external');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.route('**/api/v1/root-summaries?**', (route) => route.fulfill(problem(503)));
  await libraryTool(page, 'Refresh');
  await expect(page.getByRole('alert')).toContainText('Access denied');
  await expect(page.getByRole('combobox', { name: 'Library folder', exact: true })).toHaveValue(
    root.id,
  );
  await expect(page.getByRole('searchbox', { name: 'Search collection' })).toHaveValue('external');
});

test('a completed page refresh preserves an unsubmitted search draft and submits it to browse', async ({
  page,
  fixture,
}) => {
  await fixture.legacy();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open external.nes', exact: true })).toBeVisible();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let first = true;
  await page.route('**/api/v1/browse?**', async (route) => {
    if (first) {
      first = false;
      const response = await route.fetch();
      reached();
      await held;
      await route.fulfill({ response });
    } else await route.continue();
  });
  const returned = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/v1/browse',
  );
  await libraryTool(page, 'Refresh');
  await started;
  try {
    await page.getByRole('searchbox', { name: 'Search collection' }).fill('external');
  } finally {
    release();
  }
  await (await returned).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByRole('searchbox', { name: 'Search collection' })).toHaveValue('external');
  const submitted = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/v1/browse' && url.searchParams.get('search') === 'external';
  });
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  expect(new URL((await submitted).url()).searchParams.get('search')).toBe('external');
});
