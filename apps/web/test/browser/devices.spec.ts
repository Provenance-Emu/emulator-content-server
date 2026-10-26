import { ContentClient } from '@ecs/client';
import { expect, signIn, test } from './fixture';

test('owner creates scoped device tokens, lists without secrets, and revokes access', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Devices', exact: true }).click();
  for (const [name, permission, scopes] of [
    ['Generated reader', 'read', ['read']],
    ['Generated editor', 'write', ['read', 'write']],
  ] as const) {
    await page.getByLabel('Device name', { exact: true }).fill(name);
    await page
      .getByRole('combobox', { name: 'Device permissions', exact: true })
      .selectOption({ label: permission === 'read' ? 'Read only' : 'Read and write' });
    await page.getByRole('button', { name: 'Create device token', exact: true }).click();
    await expect(page.getByLabel('Device access token', { exact: true })).toBeVisible();
    const secret = await page.getByLabel('Device access token', { exact: true }).inputValue();
    const device = new ContentClient(fixture.origin, secret);
    expect((await device.libraries()).items.length).toBeGreaterThan(0);
    const listing = await fixture.client.deviceTokens();
    const metadata = listing.items.find((entry) => entry.name === name);
    expect(metadata?.scopes).toEqual(scopes);
    expect(JSON.stringify(listing)).not.toContain(secret);
    expect(
      await page.evaluate(
        (value) => Object.values(localStorage).some((stored) => stored.includes(value)),
        secret,
      ),
    ).toBe(false);
    await page.getByRole('button', { name: 'Hide token', exact: true }).click();
    await expect(page.getByLabel('Device access token', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: `Revoke ${name}`, exact: true }).click();
    await expect
      .poll(
        async () =>
          (await fixture.client.deviceTokens()).items.find((entry) => entry.id === metadata?.id)
            ?.revokedAt,
      )
      .toBeTruthy();
    await expect(device.libraries()).rejects.toThrow();
  }
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Devices', exact: true }).click();
  await expect(page.getByLabel('Device access token', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Revoked', exact: true })).toHaveCount(2);
});

test('a created token survives list refresh failure and retry never creates a duplicate', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Devices', exact: true }).click();
  await expect(page.getByLabel('Device name', { exact: true })).toBeVisible();
  let posts = 0;
  let failRefresh = true;
  await page.route(`${fixture.origin}/api/v1/device-tokens`, async (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      await route.continue();
    } else if (posts && failRefresh) {
      failRefresh = false;
      await route.fulfill({ status: 503, json: { title: 'Generated list failure', status: 503 } });
    } else await route.continue();
  });
  await page.getByLabel('Device name', { exact: true }).fill('Generated recoverable device');
  await page.getByRole('button', { name: 'Create device token', exact: true }).click();
  const secret = page.getByLabel('Device access token', { exact: true });
  await expect(secret).toBeVisible();
  const original = await secret.inputValue();
  await expect(page.getByRole('button', { name: 'Retry device list', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Create device token', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Retry device list', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Revoke Generated recoverable device', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Create device token', exact: true }),
  ).toBeEnabled();
  expect(await secret.inputValue()).toBe(original);
  expect(posts).toBe(1);
  expect((await fixture.client.deviceTokens()).items).toHaveLength(1);
});
