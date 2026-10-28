import { expect, signIn, test } from './fixture';

for (const device of [
  { name: 'desktop', viewport: { width: 1280, height: 900 }, hasTouch: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true },
]) {
  test.describe(device.name, () => {
    test.use({ viewport: device.viewport, hasTouch: device.hasTouch });

    test('settings fields keep names, linked help, native validation, and disabled feedback', async ({
      page,
      fixture,
    }, testInfo) => {
      await signIn(page, fixture);
      if (device.hasTouch) await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Devices', exact: true }).click();
      await expect(page.getByText('No device tokens yet.', { exact: true })).toBeVisible();
      const name = page.getByRole('textbox', { name: 'Device name', exact: true });
      await expect(name).toHaveAccessibleDescription(
        'Choose a name you’ll recognize, such as Living room tablet.',
      );
      await page
        .locator('label')
        .filter({ hasText: /^Device name$/ })
        .click();
      await expect(name).toBeFocused();
      await expect(
        page.getByRole('combobox', { name: 'Device permissions', exact: true }),
      ).toHaveAccessibleDescription('Read-only apps can browse and download.');
      await expect(page.getByRole('combobox', { name: 'Token lifetime', exact: true })).toHaveValue(
        '7776000',
      );
      const create = page.getByRole('button', { name: 'Create device token', exact: true });
      fixture.requests.length = 0;
      await create.click();
      await expect(name).toBeFocused();
      expect(
        fixture.requests.filter((request) => request === 'POST /api/v1/device-tokens'),
      ).toEqual([]);
      expect((await name.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
        device.hasTouch ? 44 : 36,
      );
      expect((await create.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
        device.hasTouch ? 44 : 36,
      );

      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/v1/device-tokens', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await held;
        await route.fulfill({
          status: 503,
          json: { title: 'Generated device unavailable', status: 503 },
        });
      });
      await name.fill('Living room tablet');
      await create.click();
      try {
        await expect(name).toBeDisabled();
        await expect(create).toBeDisabled();
      } finally {
        release();
      }
      await expect(page.getByRole('alert')).toContainText('Generated device unavailable');
      await expect(name).toBeEnabled();
      await expect(name).toHaveValue('Living room tablet');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: testInfo.outputPath(`devices-${device.name}.png`),
        fullPage: true,
      });

      await page.getByRole('button', { name: 'Access', exact: true }).click();
      await expect(
        page.getByRole('combobox', { name: 'Account', exact: true }),
      ).toHaveAccessibleDescription('Choose the account you want to manage.');
      const replacement = page.getByLabel('Replacement password', { exact: true });
      await expect(replacement).toHaveAttribute('type', 'password');
      await expect(replacement).toHaveAccessibleDescription(
        'Changing this password signs out the account’s other sessions.',
      );
      await expect(
        page.getByRole('button', { name: 'Save library access', exact: true }),
      ).toBeEnabled();
      const originalPolicy = await fixture.client.access();
      await page
        .getByRole('combobox', { name: 'Who needs a login', exact: true })
        .selectOption('subnets');
      const networks = page.getByRole('textbox', {
        name: 'Trusted networks, one per line',
        exact: true,
      });
      await expect(networks).toBeVisible();
      await networks.fill('192.168.1.0/24');
      await page.keyboard.press('Tab');
      await expect(
        page.getByRole('button', { name: 'Save network access', exact: true }),
      ).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: testInfo.outputPath(`access-${device.name}.png`),
        fullPage: true,
      });
      expect(await fixture.client.access()).toEqual(originalPolicy);
      expect((await fixture.client.deviceTokens()).items).toEqual([]);
    });
  });
}
