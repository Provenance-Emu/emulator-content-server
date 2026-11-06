import { createHash } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, signIn, test } from './fixture';

test.use({ headless: true });
// This fixture has no audio API or emulator; its changing canvas proves a live session.
async function setup(page: Page, context: BrowserContext, fixture: Parameters<typeof signIn>[1]) {
  const loader = `export default async options => {
    const files = new Map();
    const coreOptions = {
      region: { value: 'Auto', description: 'Console region', values: ['Auto', 'NTSC', 'PAL'] },
      interpolation: { value: 'Gaussian', description: 'Audio interpolation', values: ['Gaussian', 'Cubic', 'Sinc'] },
      overclock: { value: 'Disabled', description: 'CPU overclock', values: ['Disabled', 'Compatible'] },
    };
    const summary = key => key + '\\t' + coreOptions[key].value + '\\t' + coreOptions[key].description;
    let reply;
    const runtime = {
      FS: {
        mkdirTree() {},
        writeFile(path, bytes) { files.set(path, new Uint8Array(bytes)); },
        readFile(path) { return files.get(path) ?? new Uint8Array([1, 2, 3]); },
      },
      EmscriptenSendCommand(command) {
        const [operation, key, value] = command.split(' ');
        if (operation === 'GET_CORE_OPTION') {
          reply = key ? summary(key) + '\\t' + coreOptions[key].values.join('|') : Object.keys(coreOptions).map(summary).join('\\n');
        } else if (operation === 'SET_CORE_OPTION') {
          coreOptions[key].value = value;
          reply = summary(key);
        } else {
          if (command === 'SAVE_STATE_SLOT 0') files.set('/ecs/states/game.state', new Uint8Array([4, 5, 6]));
          reply = command === 'SAVE_FILES' ? 'OK' : command;
        }
      },
      EmscriptenReceiveCommandReply() { const result = reply; reply = undefined; return result; },
      callMain() {
        options.print('Window fixture started');
        const context = options.canvas.getContext('2d');
        let frame = 0;
        function draw() {
          context.fillStyle = ++frame % 2 ? '#3399cc' : '#3366cc';
          context.fillRect(0, 0, options.canvas.width, options.canvas.height);
          runtime.postMainLoop?.();
          requestAnimationFrame(draw);
        }
        draw();
      },
    };
    return runtime;
  }`;
  const profile = await fixture.client.playerProfile('org.example.generated-gba');
  profile.loader.sha256 = createHash('sha256').update(loader).digest('hex');
  profile.loader.sizeBytes = Buffer.byteLength(loader);
  profile.saveCompletion = 'command-reply-v1';
  await context.route('**/api/v1/player/profiles**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith('/profiles')
        ? { items: [profile], defaultProfileId: profile.id }
        : profile,
    }),
  );
  let starts = 0;
  context.on('request', (r) => {
    if (r.url().endsWith('/loader.js')) starts++;
  });
  await context.route('**/play/plugins/org.example.generated-gba/loader.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: loader }),
  );
  const item = await fixture.client.createItem({
    libraryId: fixture.library.id,
    title: 'Silent window test',
    systemIdentifier: 'com.provenance.gba',
    md5: null,
    crc: null,
  });
  const assets: Record<string, string> = {};
  for (const [kind, name] of [
    ['rom', 'window.gba'],
    ['battery_save', 'window.srm'],
    ['save_state', 'imported.state'],
  ] as const) {
    const file = await fixture.client.upload({
      libraryId: fixture.library.id,
      itemId: item.id,
      kind,
      displayName: name,
      relativePath: name,
      baseRevision: (await fixture.client.manifest(item.id)).revision,
      body: new Uint8Array([1, 2, 3]),
    });
    assets[kind] = file.id;
  }
  await signIn(page, fixture);
  const url = `${fixture.origin}/play/?item=${item.id}&asset=${assets.rom}&profile=${profile.id}`;
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
  return { url, assets, starts: () => starts };
}

test('window launch copies setup, requires fresh save confirmation and unlocks only after closure', async ({
  page,
  context,
  fixture,
}) => {
  const f = await setup(page, context, fixture);
  await page.locator('.player-starting-saves > summary').click();
  await page
    .getByRole('combobox', { name: 'Compatible battery save', exact: true })
    .selectOption(f.assets.battery_save!);
  await page
    .getByRole('combobox', { name: 'Compatible slot-0 state', exact: true })
    .selectOption(f.assets.save_state!);
  const open = page.getByRole('button', { name: 'Open game window', exact: true });
  await expect(open).toBeDisabled();
  await page.getByRole('checkbox', { name: /I verified these selected saves/ }).check();
  const popup = context.waitForEvent('page');
  await open.click();
  const child = await popup;
  await child.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(
    child.getByRole('combobox', { name: 'Compatible battery save', exact: true }),
  ).toHaveValue(f.assets.battery_save!);
  await expect(
    child.getByRole('combobox', { name: 'Compatible slot-0 state', exact: true }),
  ).toHaveValue(f.assets.save_state!);
  await expect(
    child.getByRole('checkbox', { name: /I verified these selected saves/ }),
  ).not.toBeChecked();
  await expect(child.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  expect(new URL(child.url()).searchParams.has('compatible')).toBe(false);
  expect(f.starts()).toBe(0);
  await child.close();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
});

test('blocked popup preserves setup and invalid copied saves never start', async ({
  page,
  context,
  fixture,
}) => {
  const f = await setup(page, context, fixture);
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page.getByRole('button', { name: 'Open game window', exact: true }).click();
  await expect(page.getByText(/Popup blocked/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
  await page.goto(f.url + '&gameWindow=1&battery=' + f.assets.rom);
  await expect(page.getByRole('alert')).toContainText('battery save');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
  expect(f.starts()).toBe(0);
});

test('separate game survives the setup page and view changes preserve the running iframe and capture', async ({
  page,
  context,
  fixture,
}) => {
  const f = await setup(page, context, fixture);
  const popup = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open game window', exact: true }).click();
  const child = await popup;
  await child.waitForLoadState('domcontentloaded');
  await child.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(child.getByRole('button', { name: 'Show controls', exact: true }))
    .toBeVisible()
    .catch(async () => {
      throw Error('Child ' + child.url() + ' ' + (await child.locator('main').innerText()));
    });
  await child.locator('iframe').evaluate((el) => {
    (window as Window & { originalFrame?: Element }).originalFrame = el;
  });
  await page.close();
  await child.getByRole('button', { name: 'Show controls', exact: true }).click();
  await expect(
    child.getByRole('button', { name: 'Capture screenshot', exact: true }),
  ).toBeEnabled();
  await child.getByRole('button', { name: 'Capture screenshot', exact: true }).click();
  await expect(
    child.getByRole('button', { name: 'Download screenshot', exact: true }),
  ).toBeVisible();
  await child.getByRole('button', { name: 'Game view', exact: true }).click();
  await child.getByRole('button', { name: 'AirPlay / Screen Mirroring', exact: true }).click();
  const help = child.getByRole('dialog', { name: 'AirPlay / Screen Mirroring', exact: true });
  await expect(help).toContainText('This page cannot start the connection for you');
  await help.getByRole('button', { name: 'Close guidance', exact: true }).click();
  await child.getByRole('button', { name: 'Show controls', exact: true }).click();
  await expect(
    child.getByRole('button', { name: 'Download screenshot', exact: true }),
  ).toBeVisible();
  expect(
    await child
      .locator('iframe')
      .evaluate((el) => el === (window as Window & { originalFrame?: Element }).originalFrame),
  ).toBe(true);
  expect(f.starts()).toBe(1);
  await child.close();
});

test('pending uploads remain recoverable when leaving game view or cancelling Stop', async ({
  page,
  context,
  fixture,
}) => {
  await setup(page, context, fixture);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Capture screenshot', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Capture screenshot', exact: true }).click();
  await context.route('**/api/v1/uploads', (route) =>
    route.fulfill({ status: 503, json: { title: 'Offline', status: 503 } }),
  );
  await page.getByRole('button', { name: 'Save screenshot to library', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry upload', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Core options', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry upload', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download pending image', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Game view', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'Stop and return to library', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Leave this game?', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Keep playing', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Download pending image', exact: true }),
  ).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(1);
  const warns = () =>
    page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await warns()).toBe(true);
  await page.getByRole('button', { name: 'Dismiss pending screenshot', exact: true }).click();
  await expect.poll(warns).toBe(false);
});

test('player tools preserve the running session and captures across keyboard panel changes', async ({
  page,
  context,
  fixture,
}, testInfo) => {
  try {
    const f = await setup(page, context, fixture);
    await expect(
      page.getByRole('heading', { name: 'Silent window test', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const capture = page.getByRole('button', { name: 'Capture screenshot', exact: true });
    await expect(capture).toBeEnabled();
    await capture.click();
    await expect(
      page.getByRole('button', { name: 'Download screenshot', exact: true }),
    ).toBeVisible();
    await page.locator('iframe').evaluate((element) => {
      element.setAttribute('data-original-session', 'true');
    });
    const tools = page.getByRole('tablist', { name: 'Player tools', exact: true });
    for (const name of ['Controls', 'Video', 'Core options']) {
      await tools.getByRole('tab', { name, exact: true }).click();
      await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible();
      await expect(capture).toBeEnabled();
      await expect(page.locator('iframe[data-original-session=true]')).toHaveCount(1);
      await expect(
        page.getByRole('region', { name: 'Input mappings', includeHidden: true }),
      ).toHaveCount(1);
    }
    await tools.getByRole('tab', { name: 'Controls', exact: true }).click();
    await page.getByRole('button', { name: 'Import or browse skins', exact: true }).click();
    const skins = page.getByRole('dialog', { name: 'Skin library', exact: true });
    await expect(skins).toBeVisible();
    await expect(capture).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save state', exact: true })).toBeDisabled();
    await skins.getByRole('button', { name: 'Close skins', exact: true }).click();
    await expect(capture).toBeEnabled();
    await tools.getByRole('tab', { name: 'Core options', exact: true }).focus();
    await page.keyboard.press('Home');
    await expect(tools.getByRole('tab', { name: 'Saves', exact: true })).toBeFocused();
    await expect(
      page.getByRole('button', { name: 'Download screenshot', exact: true }),
    ).toBeVisible();
    expect(f.starts()).toBe(1);
    await tools.getByRole('tab', { name: 'Core options', exact: true }).click();
    const region = page.getByRole('combobox', { name: 'Console region', exact: true });
    await expect(region).toBeEnabled();
    await region.selectOption('PAL');
    await expect(region).toBeEnabled();
    await expect(region).toHaveValue('PAL');
    await page.screenshot({
      path: testInfo.outputPath('player-workspace-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await tools.getByRole('tab', { name: 'Core options', exact: true }).click();
    await page.screenshot({
      path: testInfo.outputPath('player-workspace-phone.png'),
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    // Close the isolated player origin and its browser keep-alive sockets before the server fixture.
    await context.close();
  }
});

test('player and copied game setup retain a validated collection return destination', async ({
  page,
  context,
  fixture,
}) => {
  const f = await setup(page, context, fixture);
  const returnTo = '/ui/?library=arcade&search=quiet&settings=emulators';
  await page.goto(`${f.url}&returnTo=${encodeURIComponent(returnTo)}`);
  await expect(page.getByRole('link', { name: 'Back to library', exact: true })).toHaveAttribute(
    'href',
    returnTo,
  );
  const popup = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open game window', exact: true }).click();
  const child = await popup;
  await child.waitForLoadState('domcontentloaded');
  await expect(child.getByRole('link', { name: 'Back to library', exact: true })).toHaveAttribute(
    'href',
    returnTo,
  );
  await child.close();
  await page.goto(`${f.url}&returnTo=${encodeURIComponent('//other.example/ui/')}`);
  await expect(page.getByRole('link', { name: 'Back to library', exact: true })).toHaveAttribute(
    'href',
    '/ui/',
  );
});
