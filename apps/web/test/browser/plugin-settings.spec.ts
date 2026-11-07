import type { PluginManagement } from '@ecs/client';
import { expect, signIn, test } from './fixture';

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`owner manages plugins without Terminal at ${viewport.width}px`, async ({
    page,
    fixture,
  }) => {
    await page.setViewportSize(viewport);
    const listing: PluginManagement = {
      available: true,
      hostId: null,
      running: false,
      error: null,
      items: [],
      defaults: [
        {
          id: 'org.ecs.library-cleanup',
          name: 'Library cleanup',
          version: '1.0.0',
          description: 'Review proposed library fixes.',
        },
      ],
    };
    const writes: string[] = [];
    await page.route('**/api/v1/plugins**', async (route) => {
      const request = route.request();
      if (request.method() !== 'GET') {
        const path = new URL(request.url()).pathname;
        writes.push(path);
        if (path.endsWith('/defaults')) {
          listing.items = [
            {
              id: 'org.ecs.library-cleanup',
              name: 'Library cleanup',
              version: '1.0.0',
              kind: 'workflow',
              digest: 'a'.repeat(64),
              enabled: true,
            },
          ];
          listing.hostId = 'local-host';
          listing.running = true;
        } else if (request.method() === 'PATCH') {
          const plugin = listing.items[0];
          if (!plugin) throw new Error('Fixture plugin is missing');
          plugin.enabled = request.postDataJSON().enabled;
          listing.running = plugin.enabled;
        }
      }
      await route.fulfill({ json: listing });
    });
    await signIn(page, fixture);
    await page.goto(`${fixture.origin}/ui/?settings=plugins`);
    await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible();
    await expect(page.getByText('No workflow plugins installed yet.')).toBeVisible();
    expect(writes).toEqual([]);
    await page.getByRole('button', { name: 'Install bundled plugins', exact: true }).click();
    const installed = page.getByRole('article', { name: 'Library cleanup', exact: true }).last();
    await expect(installed).toContainText('Enabled');
    await expect(page.getByText('Running on this server', { exact: true })).toBeVisible();
    await installed
      .getByRole('button', { name: 'Disable Library cleanup 1.0.0', exact: true })
      .click();
    await expect(installed).toContainText('Disabled');
    await installed
      .getByRole('button', { name: 'Enable Library cleanup 1.0.0', exact: true })
      .click();
    await page.getByRole('button', { name: 'Check and repair connection', exact: true }).click();
    await expect(
      page.getByText('Package validation and host connection checks passed.', { exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([
      '/api/v1/plugins/defaults',
      '/api/v1/plugins',
      '/api/v1/plugins',
      '/api/v1/plugins/doctor',
    ]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Manage emulators', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Emulators', exact: true })).toBeVisible();
  });
}
