import { ContentClient } from '@ecs/client';
import { expect, signIn, test } from './fixture';

test('web owner creates an account, grants and removes library access, and changes its password', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  await page.getByLabel('New username', { exact: true }).fill('new-reader');
  await page.getByLabel('New account password', { exact: true }).fill('generated-password-123');
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Account created' })).toBeVisible();
  const user = (await fixture.client.users()).items.find(
    (entry) => entry.username === 'new-reader',
  );
  if (!user) throw new Error('Created account missing');
  await page.getByLabel('Account', { exact: true }).selectOption(user.id);
  await page.getByLabel('Account library', { exact: true }).selectOption(fixture.library.id);
  await page.getByLabel('Library role', { exact: true }).selectOption('reader');
  await page.getByRole('button', { name: 'Save library access', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Library access saved' })).toBeVisible();
  const reader = new ContentClient(fixture.origin);
  await reader.login('new-reader', 'generated-password-123');
  expect((await reader.libraries()).items.map((entry) => entry.id)).toEqual([fixture.library.id]);
  await page.getByLabel('Replacement password', { exact: true }).fill('replacement-password-123');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Password changed' })).toBeVisible();
  await expect(reader.login('new-reader', 'generated-password-123')).rejects.toThrow();
  reader.setToken(undefined);
  await reader.login('new-reader', 'replacement-password-123');
  await page.getByRole('button', { name: 'Remove library access', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Library access removed' }),
  ).toBeVisible();
  expect((await reader.libraries()).items).toEqual([]);
});

test('web owner can change the network access policy', async ({ page, fixture }) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  await page.getByLabel('Who needs a login', { exact: true }).selectOption('token');
  await page.getByRole('button', { name: 'Save network access', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Network access saved' })).toBeVisible();
  expect((await fixture.client.access()).mode).toBe('token');
});

test('guest token sign-in is scoped, survives reload, and clears revoked credentials', async ({
  page,
  fixture,
}) => {
  const grant = await fixture.client.createGuestGrant({
    libraryId: fixture.library.id,
    capabilities: ['read'],
    expiresInSeconds: 3600,
  });
  await page.goto(`${fixture.origin}/ui/`);
  await page.getByRole('button', { name: 'Use an access token', exact: true }).click();
  await page.getByLabel('Access token', { exact: true }).fill(grant.token);
  await page.getByRole('button', { name: 'Connect with token', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Arcade', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Empty shelf', exact: true })).toHaveCount(0);
  expect(page.url()).not.toContain(grant.token);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Arcade', exact: true })).toBeVisible();
  await fixture.client.revokeGuestGrant(grant.id);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => Object.values(localStorage).some((value) => value.includes('token'))),
  ).toBe(false);
});

test('invalid pasted token stays on login without storing credentials', async ({
  page,
  fixture,
}) => {
  await page.goto(`${fixture.origin}/ui/`);
  await page.getByRole('button', { name: 'Use an access token', exact: true }).click();
  await page.getByLabel('Access token', { exact: true }).fill('invalid-generated-token');
  await page.getByRole('button', { name: 'Connect with token', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test('signed-in readers can issue and revoke their own WebDAV credentials', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture, true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'WebDAV', exact: true }).click();
  await page.getByLabel('Credential name', { exact: true }).fill('Generated Finder');
  await page.getByRole('button', { name: 'Create app credential', exact: true }).click();
  await expect(page.getByLabel('WebDAV username', { exact: true })).toBeVisible();
  const password = await page.getByLabel('WebDAV password', { exact: true }).inputValue();
  expect(password.length).toBeGreaterThan(20);
  const reader = new ContentClient(fixture.origin, fixture.readerSession.token);
  const created = (await reader.webdavCredentials()).items.find(
    (entry) => entry.name === 'Generated Finder',
  );
  expect(created).toBeTruthy();
  expect((await fixture.client.webdavCredentials()).items).toEqual([]);
  await page.getByRole('button', { name: 'Hide credential', exact: true }).click();
  await expect(page.getByLabel('WebDAV password', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Revoke Generated Finder', exact: true }).click();
  await expect
    .poll(async () => (await reader.webdavCredentials()).items[0]?.revokedAt)
    .toBeTruthy();
});

test('access rejection clears accounts and revalidates owner authority', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  await expect(page.getByLabel('Account', { exact: true })).toBeVisible();
  await page.route('**/api/v1/users', (route) =>
    route.fulfill({ status: 401, json: { title: 'Session revoked', status: 401 } }),
  );
  await page.getByLabel('New username', { exact: true }).fill('must-not-create');
  await page.getByLabel('New account password', { exact: true }).fill('generated-password-123');
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByLabel('Account', { exact: true })).toHaveCount(0);
});

test('browser player adopts a pasted guest token before loading session setup', async ({
  page,
  fixture,
}) => {
  const rom = (await fixture.client.manifest(fixture.game.id)).files.find(
    (file) => file.kind === 'rom',
  );
  if (!rom) throw new Error('Generated ROM missing');
  const grant = await fixture.client.createGuestGrant({
    libraryId: fixture.library.id,
    capabilities: ['read'],
    expiresInSeconds: 3600,
  });
  await page.goto(`${fixture.origin}/play/?item=${fixture.game.id}&asset=${rom.id}`);
  await page.getByRole('button', { name: 'Use an access token', exact: true }).click();
  await page.getByLabel('Access token', { exact: true }).fill(grant.token);
  await page.getByRole('button', { name: 'Connect with token', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Session setup', exact: true })).toBeVisible();
  expect(page.url()).not.toContain(grant.token);
});
