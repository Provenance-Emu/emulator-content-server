import { expect, signIn, test } from './fixture';

test('membership reads can retry and stale library responses cannot overwrite current access', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  await page.getByLabel('Account', { exact: true }).selectOption(fixture.readerSession.userId);
  const arcade = `${fixture.origin}/api/v1/libraries/${fixture.library.id}/members`;
  await page.route(
    arcade,
    (route) =>
      route.fulfill({ status: 503, json: { title: 'Temporary membership failure', status: 503 } }),
    { times: 1 },
  );
  await page.getByLabel('Account library', { exact: true }).selectOption(fixture.library.id);
  await expect(
    page.getByRole('button', { name: 'Retry library access', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save library access', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Retry library access', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Current access: Reader' }),
  ).toBeVisible();
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let held = false;
  const empty = `${fixture.origin}/api/v1/libraries/${fixture.empty.id}/members`;
  await page.route(
    empty,
    async (route) => {
      const response = await route.fetch();
      held = true;
      await gate;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  try {
    await page.getByLabel('Account library', { exact: true }).selectOption(fixture.empty.id);
    await expect.poll(() => held).toBe(true);
    await page.getByLabel('Account library', { exact: true }).selectOption(fixture.library.id);
    await expect(
      page.getByRole('status').filter({ hasText: 'Current access: Reader' }),
    ).toBeVisible();
    const completed = page.waitForResponse(empty);
    release();
    await completed;
    await expect(
      page.getByRole('status').filter({ hasText: 'Current access: Reader' }),
    ).toBeVisible();
    await expect(page.getByLabel('Library role', { exact: true })).toHaveValue('reader');
  } finally {
    release();
  }
});

test('membership rejection clears private accounts before a delayed authority recheck', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  await expect(page.getByLabel('Account', { exact: true })).toBeVisible();
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let rechecking = false;
  await page.route(`${fixture.origin}/api/v1/roots`, async (route) => {
    rechecking = true;
    await gate;
    await route.continue();
  });
  await page.route(`${fixture.origin}/api/v1/libraries/${fixture.library.id}/members`, (route) =>
    route.fulfill({ status: 403, json: { title: 'Membership authority changed', status: 403 } }),
  );
  try {
    await page.getByLabel('Account library', { exact: true }).selectOption(fixture.library.id);
    await expect.poll(() => rechecking).toBe(true);
    await expect(page.getByLabel('Account', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Replacement password', { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Retry access settings', exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
});
