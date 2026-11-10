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
  await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible();
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

test('a scanned TV pairing link survives sign-in and requires explicit approval', async ({
  page,
  fixture,
}) => {
  async function pairingRequest(path: string, body: object) {
    return fetch(`${fixture.origin}/api/v1/device-pairing${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  const response = await pairingRequest('', { name: 'Generated Apple TV' });
  expect(response.status).toBe(201);
  const { id, pin, secret } = (await response.json()) as {
    id: string;
    pin: string;
    secret: string;
  };
  await page.goto(`${fixture.origin}/ui/?settings=devices#pair=${pin}`);
  await page.getByLabel('Username', { exact: true }).fill('browser-owner');
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByLabel('Pairing PIN')).toHaveValue(pin);
  await page.getByRole('button', { name: 'Review device' }).click();
  await expect(page.getByText('Generated Apple TV', { exact: true })).toBeVisible();
  expect((await pairingRequest('/redeem', { id, secret })).status).toBe(202);
  await page.getByRole('button', { name: 'Approve read access' }).click();
  await expect(page.getByText('Approved. The device can now connect.')).toBeVisible();
  const redeemed = await pairingRequest('/redeem', { id, secret });
  expect(redeemed.status).toBe(200);
  const { token, scopes } = (await redeemed.json()) as { token: string; scopes: string[] };
  expect(scopes).toEqual(['read']);
  expect((await new ContentClient(fixture.origin, token).libraries()).items.length).toBeGreaterThan(
    0,
  );
  expect(page.url()).not.toContain(secret);
  expect(page.url()).not.toContain('#pair=');
});
