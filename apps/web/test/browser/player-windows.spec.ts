import { createHash } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, signIn, test } from './fixture';

test.use({ headless: true });
// This fixture has no audio API or emulator; its changing canvas proves a live session.
async function setup(page: Page, context: BrowserContext, fixture: Parameters<typeof signIn>[1]) {
  const loader = `export default async o=>{const files=new Map();let reply;const m={FS:{mkdirTree(){},writeFile(p,b){files.set(p,new Uint8Array(b));},readFile(p){return files.get(p)??new Uint8Array([1,2,3]);}},EmscriptenSendCommand(c){if(c.startsWith('GET_CORE_OPTION'))reply='';else{if(c==='SAVE_STATE_SLOT 0')files.set('/ecs/states/game.state',new Uint8Array([4,5,6]));reply=c==='SAVE_FILES'?'OK':c;}},EmscriptenReceiveCommandReply(){const r=reply;reply=undefined;return r;},callMain(){o.print('Window fixture started');const ctx=o.canvas.getContext('2d');let frame=0;function draw(){ctx.fillStyle=++frame%2?'#3399cc':'#3366cc';ctx.fillRect(0,0,o.canvas.width,o.canvas.height);m.postMainLoop?.();requestAnimationFrame(draw);}draw();}};return m;}`;
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
