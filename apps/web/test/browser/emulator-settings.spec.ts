import {
  playerManagementFixture,
  playerPackageFixture,
  playerProfile,
} from '../player-management-fixture';
import { expect, signIn, test } from './fixture';

for (const device of [
  { name: 'desktop', viewport: { width: 1280, height: 900 }, hasTouch: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true },
]) {
  test.describe(device.name, () => {
    test.use({ viewport: device.viewport, hasTouch: device.hasTouch });

    test('owner manages only supported emulators and explicit native package selections', async ({
      page,
      fixture,
    }, testInfo) => {
      test.setTimeout(45_000);
      const listing = playerManagementFixture();
      const writes: string[] = [];
      let uploaded: Buffer | null = null;
      let contentType = '';
      await page.route('**/api/v1/player/management**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() === 'GET') return route.fulfill({ json: listing });
        writes.push(`${request.method()} ${path}`);
        if (request.method() === 'POST') {
          const packageUpload = path.endsWith('/install');
          const id = packageUpload ? 'package-player' : 'supported';
          if (packageUpload) {
            uploaded = request.postDataBuffer();
            contentType = request.headers()['content-type'] ?? '';
          }
          listing.items.push({
            profile: playerProfile(id, packageUpload ? 'Package emulator' : 'Handheld emulator'),
            enabled: true,
            source: 'managed',
            removable: true,
          });
        } else {
          const id = path.split('/').at(-1);
          const item = listing.items.find((item) => item.profile.id === id);
          if (!item) throw new Error('Generated emulator missing');
          if (request.method() === 'PATCH') {
            const patch = request.postDataJSON();
            if (patch.enabled !== undefined) item.enabled = patch.enabled;
            if (patch.default) listing.defaultProfileId = item.profile.id;
          } else if (request.method() === 'DELETE') {
            listing.items = listing.items.filter((item) => item.profile.id !== id);
            if (listing.defaultProfileId === id) listing.defaultProfileId = null;
          }
        }
        await route.fulfill({ json: listing });
      });
      await signIn(page, fixture);
      if (device.hasTouch) await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Emulators', exact: true }).click();
      const tabs = page.getByRole('tablist', { name: 'Emulator options' });
      await expect(
        page.getByRole('heading', { name: 'Installed emulators', exact: true }),
      ).toBeVisible();
      const operator = page.getByRole('article', { name: 'Server emulator', exact: true });
      await expect(operator).toContainText('Installed by the server administrator');
      await expect(operator.getByRole('button')).toHaveCount(0);
      const extra = page.getByRole('article', { name: 'Extra emulator', exact: true });
      await expect(
        extra.getByRole('button', { name: 'Make Extra emulator default', exact: true }),
      ).toBeDisabled();
      const enable = extra.getByRole('button', { name: 'Enable Extra emulator', exact: true });
      expect((await enable.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
        device.hasTouch ? 44 : 36,
      );
      await tabs.getByRole('tab', { name: 'Installed', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.getByRole('tab', { name: 'Available', exact: true })).toBeFocused();
      const unsupported = page.getByRole('article', { name: 'Disc emulator', exact: true });
      await expect(unsupported).toContainText(
        'This emulator does not support the browser runtime.',
      );
      await expect(unsupported.getByRole('button')).toHaveCount(0);
      expect(writes).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: testInfo.outputPath(`emulators-available-${device.name}.png`),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Install Handheld emulator', exact: true }).click();
      await expect(tabs.getByRole('tab', { name: 'Installed', exact: true })).toBeFocused();
      await expect(
        page.getByRole('article', { name: 'Handheld emulator', exact: true }),
      ).toBeVisible();
      expect(writes).toEqual(['POST /api/v1/player/management/install/supported']);
      await extra.getByRole('button', { name: 'Enable Extra emulator', exact: true }).click();
      await expect(
        extra.getByRole('button', { name: 'Make Extra emulator default', exact: true }),
      ).toBeEnabled();
      await extra.getByRole('button', { name: 'Make Extra emulator default', exact: true }).click();
      await expect(extra).toContainText('Enabled · Default');
      const remove = extra.getByRole('button', { name: 'Remove Extra emulator', exact: true });
      await remove.click();
      await expect(
        extra.getByRole('button', { name: 'Confirm remove Extra emulator', exact: true }),
      ).toBeFocused();
      await extra.getByRole('button', { name: 'Cancel removal', exact: true }).click();
      await expect(remove).toBeFocused();
      expect(writes.filter((value) => value.startsWith('DELETE'))).toEqual([]);
      await remove.click();
      await extra
        .getByRole('button', { name: 'Confirm remove Extra emulator', exact: true })
        .click();
      await expect(extra).toHaveCount(0);
      expect(writes.filter((value) => value.startsWith('DELETE'))).toHaveLength(1);

      const input = page.getByLabel('Emulator package', { exact: true });
      await expect(input).toHaveAttribute('type', 'file');
      await expect(input).toHaveAttribute('accept', '.ecsplayer');
      await expect(input).not.toHaveAttribute('multiple');
      await expect(
        page.getByRole('button', { name: 'Install package', exact: true }),
      ).toBeDisabled();
      const before = writes.length;
      const chooserEvent = page.waitForEvent('filechooser');
      await input.click();
      const chooser = await chooserEvent;
      await chooser.setFiles({
        name: 'generated.ecsplayer',
        mimeType: 'application/vnd.ecs.player-package',
        buffer: Buffer.from([1, 2, 3, 4]),
      });
      expect(writes.length).toBe(before);
      await page.getByRole('button', { name: 'Install package', exact: true }).click();
      await expect(
        page.getByRole('article', { name: 'Package emulator', exact: true }),
      ).toBeVisible();
      expect(writes.at(-1)).toBe('POST /api/v1/player/management/install');
      expect(uploaded).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(contentType).toBe('application/vnd.ecs.player-package');
      await expect(input).toHaveValue('');
      await expect(
        page.getByRole('button', { name: 'Install package', exact: true }),
      ).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: testInfo.outputPath(`emulators-installed-${device.name}.png`),
        fullPage: true,
      });
    });
  });
}

for (const status of [403, 404] as const) {
  test(`${status} explains unavailable management without creating a fake empty catalog`, async ({
    page,
    fixture,
  }) => {
    await page.route('**/api/v1/player/management', (route) =>
      route.fulfill({ status, json: { title: 'Generated management rejection', status } }),
    );
    await signIn(page, fixture);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Emulators', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      status === 403 ? 'Sign in with the server owner account' : 'not available on this server',
    );
    await expect(page.getByRole('button', { name: 'Retry emulators', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Install package', exact: true })).toHaveCount(0);
    await expect(page.getByText('No emulators are installed.', { exact: false })).toHaveCount(0);
  });
}

test('reader settings do not expose emulator management navigation', async ({ page, fixture }) => {
  await signIn(page, fixture, true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Server status', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Emulators', exact: true })).toHaveCount(0);
});

test('native package selection installs through the real owner API and refreshes browser-play choices', async ({
  page,
  fixture,
}) => {
  test.setTimeout(45_000);
  const bundle = playerPackageFixture();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Emulators', exact: true }).click();
  const input = page.getByLabel('Emulator package', { exact: true });
  await expect(input).toBeVisible();
  fixture.requests.length = 0;
  const chooserEvent = page.waitForEvent('filechooser');
  await input.click();
  await (await chooserEvent).setFiles({
    name: 'generated.ecsplayer',
    mimeType: 'application/vnd.ecs.player-package',
    buffer: bundle.bytes,
  });
  expect(fixture.requests.filter((value) => /^(POST|PATCH|DELETE) /.test(value))).toEqual([]);
  await page.getByRole('button', { name: 'Install package', exact: true }).click();
  const installed = page.getByRole('article', { name: 'Imported emulator', exact: true });
  await expect(installed).toBeVisible();
  expect(
    (await fixture.client.playerManagement()).items.find((item) => item.profile.id === bundle.id)
      ?.source,
  ).toBe('managed');
  expect((await fixture.client.playerProfiles()).items.some((item) => item.id === bundle.id)).toBe(
    true,
  );
  await installed.getByRole('button', { name: 'Disable Imported emulator', exact: true }).click();
  await expect(
    installed.getByRole('button', { name: 'Enable Imported emulator', exact: true }),
  ).toBeEnabled();
  expect((await fixture.client.playerProfiles()).items.some((item) => item.id === bundle.id)).toBe(
    false,
  );
  await installed.getByRole('button', { name: 'Enable Imported emulator', exact: true }).click();
  await expect(
    installed.getByRole('button', { name: 'Make Imported emulator default', exact: true }),
  ).toBeEnabled();
  await installed
    .getByRole('button', { name: 'Make Imported emulator default', exact: true })
    .click();
  await expect(installed).toContainText('Enabled · Default');
  expect((await fixture.client.playerProfiles()).defaultProfileId).toBe(bundle.id);
  await installed.getByRole('button', { name: 'Remove Imported emulator', exact: true }).click();
  await installed
    .getByRole('button', { name: 'Confirm remove Imported emulator', exact: true })
    .click();
  await expect(installed).toHaveCount(0);
  expect((await fixture.client.playerProfiles()).items.some((item) => item.id === bundle.id)).toBe(
    false,
  );
  expect(
    fixture.requests.filter((value) => value === 'POST /api/v1/player/management/install'),
  ).toHaveLength(1);
  expect(
    fixture.requests.filter((value) => value === `DELETE /api/v1/player/management/${bundle.id}`),
  ).toHaveLength(1);
});

test('Atomiswave native system-file selection stages bytes until explicit install and preserves other assets', async ({
  page,
  fixture,
}, testInfo) => {
  test.setTimeout(60_000);
  const listing = playerManagementFixture();
  const managed = listing.items[0];
  const operator = listing.items[1];
  if (!managed || !operator) throw new Error('Missing generated emulator fixture');
  managed.profile.id = 'org.libretro.parallel-dc';
  listing.defaultProfileId = managed.profile.id;
  managed.profile.name = 'Arcade emulator';
  managed.profile.systems = ['com.provenance.atomiswave'];
  const asset = (name: string, sizeBytes: number) => ({
    name,
    sizeBytes,
    sha256: '0'.repeat(64),
    url: `/play/plugins/${managed.profile.id}/assets/${name}`,
  });
  managed.profile.assets = [asset('support.data', 7), asset('awbios.zip', 5)];
  operator.profile.id = 'org.example.operator-parallel-dc';
  let uploads = 0;
  let uploaded: Buffer | null = null;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/player/management**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: listing });
    expect(request.method()).toBe('PUT');
    expect(new URL(request.url()).pathname).toBe(
      '/api/v1/player/management/org.libretro.parallel-dc/system/awbios.zip',
    );
    uploads++;
    uploaded = request.postDataBuffer();
    await held;
    managed.profile.assets = [
      ...managed.profile.assets.filter((file) => file.name !== 'awbios.zip'),
      asset('awbios.zip', uploaded?.length ?? 0),
    ];
    await route.fulfill({ json: listing });
  });
  await signIn(page, fixture);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Emulators', exact: true }).click();
  const card = page.getByRole('article', { name: 'Arcade emulator', exact: true });
  const fileList = card.getByRole('list', { name: 'Installed system and support files' });
  await expect(fileList).toContainText('support.data');
  await expect(fileList).toContainText('awbios.zip');
  await expect(card).toContainText('System files are shared with players on this server.');
  await expect(card).toContainText('For Atomiswave, add your awbios.zip containing bios0.ic23.');
  await expect(
    page
      .getByRole('article', { name: 'Server emulator', exact: true })
      .getByLabel('Add system file', { exact: true }),
  ).toHaveCount(0);
  const input = card.getByLabel('Add system file', { exact: true });
  await expect(input).toHaveAttribute('type', 'file');
  await expect(input).toHaveAttribute('accept', '.zip');
  const install = card.getByRole('button', { name: 'Install system file', exact: true });
  await expect(install).toBeDisabled();
  const chooserEvent = page.waitForEvent('filechooser');
  await input.click();
  await (await chooserEvent).setFiles({
    name: 'AWBIOS.ZIP',
    mimeType: 'application/zip',
    buffer: Buffer.alloc(32, 4),
  });
  expect(uploads).toBe(0);
  await expect(card.getByRole('status')).toContainText('replaces the existing AWBIOS.ZIP');
  await install.click();
  try {
    await expect(input).toBeDisabled();
    await expect(install).toBeDisabled();
  } finally {
    release();
  }
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('');
  await expect(install).toBeDisabled();
  expect(uploads).toBe(1);
  expect(uploaded).toEqual(Buffer.alloc(32, 4));
  await expect(fileList.getByRole('listitem').filter({ hasText: 'awbios.zip' })).toContainText(
    '32 B',
  );
  await expect(fileList.getByRole('listitem').filter({ hasText: 'support.data' })).toContainText(
    '7 B',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('emulator-system-file-desktop.png'),
    fullPage: true,
  });
});
