import { expect, signIn, test } from './fixture';

for (const device of [
  { name: 'desktop', viewport: { width: 1280, height: 900 }, hasTouch: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true },
]) {
  test.describe(device.name, () => {
    test.use({ viewport: device.viewport, hasTouch: device.hasTouch });

    test('storage shares keyboard tabs and theme values while its folder picker stays usable', async ({
      page,
      fixture,
    }, testInfo) => {
      await page.route('**/api/v1/folders**', (route) =>
        route.fulfill({
          json: {
            path: '/Generated games',
            parent: '/',
            places: [{ label: 'Games drive', path: '/Generated games' }],
            entries: [
              { name: 'Handheld games', path: '/Generated games/Handheld games' },
              {
                name: 'A long folder name that remains readable without widening the dialog',
                path: '/Generated games/Long folder',
              },
            ],
          },
        }),
      );
      await signIn(page, fixture);
      if (device.hasTouch) await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Storage', exact: true }).click();
      const tabs = page.getByRole('tablist', { name: 'Storage options' });
      const folders = tabs.getByRole('tab', { name: 'Folders on server' });
      const uploads = tabs.getByRole('tab', { name: 'Uploaded files' });
      await folders.focus();
      await page.keyboard.press('End');
      await expect(tabs.getByRole('tab', { name: 'Remote storage' })).toBeFocused();
      await expect(page.getByRole('tabpanel')).toHaveAccessibleName('Remote storage');
      await page.keyboard.press('ArrowRight');
      await expect(folders).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(uploads).toBeFocused();
      await expect(uploads).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Home');
      await expect(folders).toBeFocused();
      await uploads.click();
      const add = page.getByRole('button', { name: 'Add destination', exact: true });
      await expect(add).toBeVisible();
      const height = (await add.boundingBox())?.height ?? 0;
      expect(height).toBeGreaterThanOrEqual(device.hasTouch ? 44 : 36);
      if (!device.hasTouch) expect(height).toBeLessThan(44);
      fixture.requests.length = 0;
      await add.click();
      const picker = page.getByRole('dialog', { name: 'Add upload destination' });
      const place = picker.getByRole('button', { name: 'Games drive', exact: true });
      await expect(place).toHaveAttribute('aria-current', 'location');
      const entry = picker.getByRole('button', { name: 'Handheld games', exact: true });
      await expect(entry).toBeVisible();
      expect((await entry.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
        device.hasTouch ? 44 : 36,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(await picker.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const bounds = await picker.boundingBox();
      expect(bounds?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(device.viewport.height);
      await page.screenshot({ path: testInfo.outputPath(`storage-picker-${device.name}.png`) });

      // A single semantic token changes settings navigation, tabs, and folder places together.
      await page.evaluate(() =>
        document.documentElement.style.setProperty('--color-selected', 'rgb(40, 65, 70)'),
      );
      for (const element of [
        page.locator('.settings-navigation button[aria-current]'),
        uploads,
        place,
      ]) {
        await expect(element).toHaveCSS('background-color', 'rgb(40, 65, 70)');
      }
      await page.keyboard.press('Escape');
      await expect(picker).toHaveCount(0);
      await expect(add).toBeFocused();
      expect(fixture.requests.filter((request) => /^(POST|PUT|DELETE) /.test(request))).toEqual([]);
    });
  });
}
