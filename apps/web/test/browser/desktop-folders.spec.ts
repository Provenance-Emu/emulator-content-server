import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixture';

async function withDesktop(page: Page, run: (origin: string) => Promise<void>) {
  const root = resolve('../tray/dist');
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const file = resolve(root, `.${path}`);
    if (!file.startsWith(`${root}/`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      response
        .writeHead(200, {
          'content-type': file.endsWith('.html')
            ? 'text/html'
            : file.endsWith('.css')
              ? 'text/css'
              : 'text/javascript',
        })
        .end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(5174, '127.0.0.1', done);
  });
  try {
    await run('http://127.0.0.1:5174');
  } finally {
    await page.goto('about:blank');
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
}

// Native IPC is replaced at the transport boundary only. HTTP writes use a real ephemeral server.
// This verifies desktop composition, not an actual OS dialog or WebView runtime.
test('desktop native adapter cancels without fallback, registers once, and recovers from expired verification', async ({
  page,
  fixture,
}) => {
  const folder = join(fixture.directory, 'Desktop folder');
  await mkdir(folder);
  await page.addInitScript(
    ({ origin }) => {
      const state = { choice: null as string | null, valid: true, commands: [] as string[] };
      Object.assign(window, {
        __nativeFolders: state,
        __TAURI_INTERNALS__: {
          async invoke(command: string) {
            state.commands.push(command);
            if (command === 'managed_endpoint')
              return { available: true, origin, verificationId: 'generated-test-id' };
            if (command === 'validate_managed_selection') return state.valid;
            if (command === 'choose_managed_directory') return state.choice;
            throw new Error('Unexpected privileged command');
          },
        },
      });
    },
    { origin: fixture.origin },
  );
  await withDesktop(page, async (desktop) => {
    await page.goto(`${desktop}/library.html`);
    await page.getByRole('button', { name: 'Use local managed service', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill('browser-owner');
    await page.getByLabel('Password', { exact: true }).fill(fixture.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const add = page.getByRole('button', { name: 'Add folder to Arcade', exact: true });
    fixture.requests.length = 0;
    await add.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as { __nativeFolders: { commands: string[] } }
            ).__nativeFolders.commands.filter((c) => c === 'choose_managed_directory').length,
        ),
      )
      .toBe(1);
    await expect(add).toBeEnabled();
    await expect(page.getByRole('dialog', { name: 'Add library folder', exact: true })).toHaveCount(
      0,
    );
    expect(fixture.requests.filter((r) => r.startsWith('POST '))).toEqual([]);
    await page.evaluate((folder) => {
      (window as unknown as { __nativeFolders: { choice: string } }).__nativeFolders.choice =
        folder;
    }, folder);
    await add.click();
    await expect(
      page.getByRole('button', { name: 'View files in Desktop folder', exact: true }),
    ).toBeVisible();
    expect(fixture.requests.filter((r) => r === 'POST /api/v1/roots')).toHaveLength(1);
    expect(
      fixture.requests.filter((r) => /^POST \/api\/v1\/roots\/[^/]+\/scan$/.test(r)),
    ).toHaveLength(1);
    await page.evaluate(() => {
      (window as unknown as { __nativeFolders: { valid: boolean } }).__nativeFolders.valid = false;
    });
    await add.click();
    await expect(page.getByRole('alert')).toContainText('Use local managed service');
    expect(fixture.requests.filter((r) => r === 'POST /api/v1/roots')).toHaveLength(1);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Add folder to Arcade', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Add library folder', exact: true }),
    ).toBeVisible();
  });
});

test('desktop unavailable native verification uses the actual server chooser for typed loopback', async ({
  page,
  fixture,
}) => {
  const folder = join(fixture.directory, 'Server chooser folder');
  await mkdir(folder);
  await page.route('**/api/v1/folders', async (route) =>
    route.fulfill({
      response: await route.fetch({
        url: `${fixture.origin}/api/v1/folders?path=${encodeURIComponent(fixture.directory)}`,
      }),
    }),
  );
  await withDesktop(page, async (desktop) => {
    await page.goto(`${desktop}/library.html`);
    await page.getByLabel('Server address', { exact: true }).fill(fixture.origin);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'Use local managed service', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'verification is unavailable' }),
    ).toBeVisible();
    await page.getByLabel('Username', { exact: true }).fill('browser-owner');
    await page.getByLabel('Password', { exact: true }).fill(fixture.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    fixture.requests.length = 0;
    await page.getByRole('button', { name: 'Add folder to Arcade', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: 'Add library folder', exact: true });
    await expect(
      page.getByText(
        `Browsing ${fixture.origin}. Browser playback may ask you to sign in separately.`,
        { exact: true },
      ),
    ).toBeVisible();
    await chooser.getByRole('textbox', { name: 'Server folder path', exact: true }).fill(folder);
    await chooser.getByRole('button', { name: 'Add folder', exact: true }).click();
    await expect(chooser).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'View files in Server chooser folder', exact: true }),
    ).toBeVisible();
    expect(fixture.requests.filter((r) => r === 'POST /api/v1/roots')).toHaveLength(1);
  });
});

for (const action of ['library-folder', 'library-editor', 'upload-storage'] as const) {
  test(`failed managed reverify retires ${action} actions and uses server chooser without Connect`, async ({
    page,
    fixture,
  }) => {
    const folder = join(fixture.directory, 'Recovered folder');
    await mkdir(folder);
    const existingUpload = join(fixture.directory, 'Existing upload target');
    await mkdir(existingUpload);
    const target = await fixture.client.addStorageLocation({
      path: existingUpload,
      label: 'Existing target',
    });
    await fixture.client.setStorageWriteTarget(target.id);
    await page.addInitScript(
      ({ origin, folder }) => {
        const state = { available: true, commands: [] as string[] };
        Object.assign(window, {
          __nativeRecovery: state,
          __TAURI_INTERNALS__: {
            async invoke(command: string) {
              state.commands.push(command);
              if (command === 'managed_endpoint')
                return state.available
                  ? { available: true, origin, verificationId: 'generated-recovery-id' }
                  : {
                      available: false,
                      reason:
                        'Local service verification is unavailable. Use the server folder chooser.',
                    };
              if (command === 'validate_managed_selection') return true;
              if (command === 'choose_managed_directory') return folder;
              throw new Error('Unexpected privileged command');
            },
          },
        });
      },
      { origin: fixture.origin, folder },
    );
    await page.route('**/api/v1/folders', async (route) =>
      route.fulfill({
        response: await route.fetch({
          url: `${fixture.origin}/api/v1/folders?path=${encodeURIComponent(fixture.directory)}`,
        }),
      }),
    );
    await withDesktop(page, async (desktop) => {
      await page.goto(`${desktop}/library.html`);
      await page.getByRole('button', { name: 'Use local managed service', exact: true }).click();
      await page.getByLabel('Username', { exact: true }).fill('browser-owner');
      await page.getByLabel('Password', { exact: true }).fill(fixture.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      if (action === 'library-editor') {
        await page.getByRole('button', { name: 'Add library', exact: true }).click();
        const editor = page.getByRole('dialog', { name: 'Create library', exact: true });
        await editor.getByRole('button', { name: 'Select server folder', exact: true }).click();
        await expect(editor.getByText(folder, { exact: true })).toBeVisible();
      } else {
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        if (action === 'upload-storage') {
          await page.getByRole('button', { name: 'Upload storage', exact: true }).click();
          await expect(
            page.getByRole('button', { name: 'Add destination', exact: true }),
          ).toBeVisible();
        } else
          await expect(
            page.getByRole('button', { name: 'Add folder to Arcade', exact: true }),
          ).toBeVisible();
      }
      fixture.requests.length = 0;
      const nativeBefore = await page.evaluate(
        () =>
          (
            window as unknown as { __nativeRecovery: { commands: string[] } }
          ).__nativeRecovery.commands.filter((c) => c === 'choose_managed_directory').length,
      );
      await page.evaluate(() => {
        (
          window as unknown as { __nativeRecovery: { available: boolean } }
        ).__nativeRecovery.available = false;
      });
      const reverify = page.getByRole('button', { name: 'Use local managed service', exact: true });
      // Exercise the same transition with a staged modal too; modal focus normally blocks its header.
      if (action === 'library-editor')
        await reverify.evaluate((button: HTMLButtonElement) => button.click());
      else await reverify.click();
      await expect(
        page.getByRole('status').filter({ hasText: 'verification is unavailable' }),
      ).toBeVisible();
      if (action === 'library-editor') {
        // The old native-staged selection and editor lifetime must be retired.
        await expect(page.getByRole('dialog', { name: 'Create library', exact: true })).toHaveCount(
          0,
        );
        expect(fixture.requests.filter((r) => r.startsWith('POST '))).toEqual([]);
        await page.getByRole('button', { name: 'Add library', exact: true }).click();
        const editor = page.getByRole('dialog', { name: 'Create library', exact: true });
        await expect(editor.getByText(folder, { exact: true })).toHaveCount(0);
        await editor.getByRole('button', { name: 'Select server folder', exact: true }).click();
        await editor.getByRole('textbox', { name: 'Server folder path', exact: true }).fill(folder);
        await editor.getByRole('button', { name: 'Select folder', exact: true }).click();
        await expect(editor.getByText(folder, { exact: true })).toBeVisible();
        expect(fixture.requests.filter((r) => r.startsWith('POST '))).toEqual([]);
        await editor.getByRole('button', { name: 'Create library', exact: true }).click();
        await expect(editor).toHaveCount(0);
      } else {
        // If context retirement remounts the app, reopen its fresh Settings view.
        // On the buggy code this is idempotent and leaves the captured stale controller mounted.
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        if (action === 'upload-storage')
          await page.getByRole('button', { name: 'Upload storage', exact: true }).click();
        await page
          .getByRole('button', {
            name: action === 'upload-storage' ? 'Add destination' : 'Add folder to Arcade',
            exact: true,
          })
          .click();
        const chooser = page.getByRole('dialog', {
          name: action === 'upload-storage' ? 'Add upload destination' : 'Add library folder',
          exact: true,
        });
        await chooser
          .getByRole('textbox', { name: 'Server folder path', exact: true })
          .fill(folder);
        await chooser
          .getByRole('button', {
            name: action === 'upload-storage' ? 'Add destination' : 'Add folder',
            exact: true,
          })
          .click();
        await expect(chooser).toHaveCount(0);
      }
      expect(fixture.requests.filter((r) => r === 'POST /api/v1/roots')).toHaveLength(
        action === 'upload-storage' ? 0 : 1,
      );
      expect(
        fixture.requests.filter((r) => /^POST \/api\/v1\/roots\/[^/]+\/scan$/.test(r)),
      ).toHaveLength(action === 'upload-storage' ? 0 : 1);
      expect(fixture.requests.filter((r) => r === 'POST /api/v1/storage-locations')).toHaveLength(
        action === 'upload-storage' ? 1 : 0,
      );
      expect((await fixture.client.storageLocations()).writeLocationId).toBe(target.id);
      const nativeAfter = await page.evaluate(
        () =>
          (
            window as unknown as { __nativeRecovery: { commands: string[] } }
          ).__nativeRecovery.commands.filter((c) => c === 'choose_managed_directory').length,
      );
      expect(nativeAfter).toBe(nativeBefore);
    });
  });
}
