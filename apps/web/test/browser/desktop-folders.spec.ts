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
    // Close browser API keep-alive sockets before the server fixture tears down.
    await page.context().close();
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
  const quickFolder = join(fixture.directory, 'Desktop quick folder');
  await mkdir(folder);
  await mkdir(quickFolder);
  await page.addInitScript(
    ({ origin }) => {
      const state = {
        choice: null as string | null,
        valid: true,
        commands: [] as string[],
        pending: false,
      };
      let finishChoice: ((choice: string | null) => void) | undefined;
      Object.assign(window, {
        __nativeFolders: state,
        __finishChoice: (choice: string | null) => finishChoice?.(choice),
        __TAURI_INTERNALS__: {
          async invoke(command: string) {
            state.commands.push(command);
            if (command === 'managed_endpoint')
              return { available: true, origin, verificationId: 'generated-test-id' };
            if (command === 'validate_managed_selection') return state.valid;
            if (command === 'choose_managed_directory') {
              if (state.pending)
                return new Promise<string | null>((resolve) => {
                  finishChoice = resolve;
                });
              return state.choice;
            }
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
    await page.getByRole('button', { name: 'Sign in', exact: true }).click({ noWaitAfter: true });
    await page.getByRole('button', { name: 'Arcade', exact: true }).click();
    const quickAdd = page.getByRole('button', { name: 'Add games', exact: true });
    async function addServerFolder() {
      await quickAdd.click();
      await page
        .getByRole('dialog', { name: 'Add games', exact: true })
        .getByRole('button', { name: 'Add server folder', exact: true })
        .click();
    }
    fixture.requests.length = 0;
    await addServerFolder();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __nativeFolders: { commands: string[] };
              }
            ).__nativeFolders.commands.filter((c) => c === 'choose_managed_directory').length,
        ),
      )
      .toBe(1);
    await expect(quickAdd).toBeEnabled();
    await expect(page.getByRole('dialog', { name: 'Add server folder', exact: true })).toHaveCount(
      0,
    );
    expect(fixture.requests.filter((r) => r.startsWith('POST '))).toEqual([]);
    await page.evaluate((choice) => {
      (window as unknown as { __nativeFolders: { choice: string } }).__nativeFolders.choice =
        choice;
    }, quickFolder);
    await addServerFolder();
    await expect(
      page
        .getByRole('combobox', { name: /^Library folder/ })
        .locator('option')
        .filter({ hasText: 'Desktop quick folder' }),
    ).toHaveCount(1);
    expect(fixture.requests.filter((r) => r === 'POST /api/v1/roots')).toHaveLength(1);
    expect(
      fixture.requests.filter((r) => /^POST \/api\/v1\/roots\/[^/]+\/scan$/.test(r)),
    ).toHaveLength(1);
    await page.evaluate(() => {
      (window as unknown as { __nativeFolders: { valid: boolean } }).__nativeFolders.valid = false;
    });
    await addServerFolder();
    await expect(page.getByRole('alert')).toContainText('Use local managed service');
    expect(fixture.requests.filter((r) => r === 'POST /api/v1/roots')).toHaveLength(1);
    await page.evaluate(() => {
      const state = (
        window as unknown as {
          __nativeFolders: { commands: string[]; valid: boolean; choice: string | null };
        }
      ).__nativeFolders;
      state.commands = [];
      state.valid = true;
      state.choice = null;
    });
    await page.evaluate(() => {
      (window as unknown as { __nativeFolders: { pending: boolean } }).__nativeFolders.pending =
        true;
    });
    await addServerFolder();
    await expect(quickAdd).toBeDisabled();
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('button', { name: 'Arcade', exact: true }).click();
    await expect(quickAdd).toBeEnabled();
    await page.evaluate(async (choice) => {
      const native = window as unknown as {
        __finishChoice: (choice: string) => void;
        __nativeFolders: { pending: boolean; commands: string[] };
      };
      native.__nativeFolders.pending = false;
      native.__finishChoice(choice);
      // Drain the resolved chooser and validation continuations before checking writes.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      native.__nativeFolders.commands = [];
    }, folder);
    await expect(quickAdd).toBeEnabled();
    expect(fixture.requests.filter((r) => r === 'POST /api/v1/roots')).toHaveLength(1);
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
    await page.getByText('Change connection', { exact: true }).click();
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
    await page.getByText('Change connection', { exact: true }).click();
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
    await expect(page.locator('.connection-summary')).toContainText(fixture.origin);
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
          await page.getByRole('button', { name: 'Storage', exact: true }).click();
          await page.getByRole('tab', { name: 'Uploaded files', exact: true }).click();
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
      const connection = page.getByText('Change connection', { exact: true });
      if (action === 'library-editor') {
        await connection.evaluate((summary: HTMLElement) => summary.click());
        await reverify.evaluate((button: HTMLButtonElement) => button.click());
      } else {
        await connection.click();
        await reverify.click();
      }
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
        if (action === 'upload-storage') {
          await page.getByRole('button', { name: 'Storage', exact: true }).click();
          await page.getByRole('tab', { name: 'Uploaded files', exact: true }).click();
        }
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

test('restored managed profile verifies on reload and opens the native folder picker without another click', async ({
  page,
  fixture,
}) => {
  await page.addInitScript(
    ({ origin }) => {
      const commands: string[] = [];
      Object.assign(window, {
        __startupCommands: commands,
        __TAURI_INTERNALS__: {
          async invoke(command: string) {
            commands.push(command);
            if (command === 'managed_endpoint')
              return { available: true, origin, verificationId: 'generated-startup-verification' };
            if (command === 'validate_managed_selection') return true;
            if (command === 'choose_managed_directory') return null;
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
    await expect(page.getByRole('heading', { name: 'Your libraries', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your libraries', exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __startupCommands: string[] }).__startupCommands.filter(
            (command) => command === 'managed_endpoint',
          ).length,
      ),
    ).toBe(1);
    await page.getByRole('button', { name: 'Arcade', exact: true }).click();
    await page.getByRole('button', { name: 'Add games', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Add games', exact: true })
      .getByRole('button', { name: 'Add server folder', exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __startupCommands: string[] }).__startupCommands.filter(
              (command) => command === 'choose_managed_directory',
            ).length,
        ),
      )
      .toBe(1);
    await expect(page.getByRole('dialog', { name: 'Add server folder', exact: true })).toHaveCount(
      0,
    );
  });
});

test('restored manual loopback profile remains a server-folder fallback even when native verification is available', async ({
  page,
  fixture,
}) => {
  await page.addInitScript(
    ({ origin }) => {
      const commands: string[] = [];
      Object.assign(window, {
        __startupCommands: commands,
        __TAURI_INTERNALS__: {
          async invoke(command: string) {
            commands.push(command);
            if (command === 'managed_endpoint')
              return { available: true, origin, verificationId: 'generated-manual-verification' };
            if (command === 'validate_managed_selection') return true;
            if (command === 'choose_managed_directory') return null;
            throw new Error('Unexpected privileged command');
          },
        },
      });
    },
    { origin: fixture.origin },
  );
  await page.route('**/api/v1/folders**', (route) =>
    route.fulfill({
      json: {
        path: fixture.directory,
        parent: null,
        places: [],
        entries: [],
      },
    }),
  );
  await withDesktop(page, async (desktop) => {
    await page.goto(`${desktop}/library.html`);
    await page.getByLabel('Server address', { exact: true }).fill(fixture.origin);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill('browser-owner');
    await page.getByLabel('Password', { exact: true }).fill(fixture.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your libraries', exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Arcade', exact: true }).click();
    await page.getByRole('button', { name: 'Add games', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Add games', exact: true })
      .getByRole('button', { name: 'Add server folder', exact: true })
      .click();
    await expect(
      page.getByRole('dialog', { name: 'Add server folder', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { __startupCommands: string[] }).__startupCommands,
      ),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem('ecs.tray.profile') ?? '{}').profileKey,
      ),
    ).toBe('manual');
  });
});

test('late startup verification cannot replace a manually selected profile', async ({
  page,
  fixture,
}) => {
  await page.addInitScript(
    ({ origin, session }) => {
      localStorage.setItem(
        'ecs.tray.profile',
        JSON.stringify({ origin, label: 'Local managed service', profileKey: 'managed-service' }),
      );
      localStorage.setItem(
        `ecs.desktop.session:${encodeURIComponent(origin)}`,
        JSON.stringify(session),
      );
      let finish: ((result: unknown) => void) | undefined;
      Object.assign(window, {
        __finishStartup: () =>
          finish?.({ available: true, origin, verificationId: 'generated-late-verification' }),
        __TAURI_INTERNALS__: {
          invoke(command: string) {
            if (command === 'managed_endpoint')
              return new Promise((resolve) => {
                finish = resolve;
              });
            throw new Error('Unexpected privileged command');
          },
        },
      });
    },
    { origin: fixture.origin, session: fixture.session },
  );
  await page.route('**/api/v1/folders**', (route) =>
    route.fulfill({
      json: {
        path: fixture.directory,
        parent: null,
        places: [],
        entries: [],
      },
    }),
  );
  await withDesktop(page, async (desktop) => {
    await page.goto(`${desktop}/library.html`);
    await expect(
      page.getByRole('status').filter({ hasText: 'Checking local service' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your libraries', exact: true })).toHaveCount(0);
    await page.getByText('Change connection', { exact: true }).click();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your libraries', exact: true })).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { __finishStartup: () => void }).__finishStartup(),
    );
    await page.getByRole('button', { name: 'Arcade', exact: true }).click();
    await page.getByRole('button', { name: 'Add games', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Add games', exact: true })
      .getByRole('button', { name: 'Add server folder', exact: true })
      .click();
    await expect(
      page.getByRole('dialog', { name: 'Add server folder', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem('ecs.tray.profile') ?? '{}').profileKey,
      ),
    ).toBe('manual');
  });
});
