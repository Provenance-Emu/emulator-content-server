import { expect, signIn, test } from './fixture';

test('state browser shows imported states before startup and requires a compatibility confirmation', async ({
  page,
  fixture,
}) => {
  const state = await fixture.client.upload({
    libraryId: fixture.library.id,
    itemId: fixture.game.id,
    kind: 'save_state',
    displayName: 'Imported state',
    relativePath: 'imported.state',
    baseRevision: (await fixture.client.manifest(fixture.game.id)).revision,
    body: new Uint8Array([1, 2, 3]),
  });
  await signIn(page, fixture);
  const rom = (await fixture.client.manifest(fixture.game.id)).files.find((f) => f.kind === 'rom')!;
  await page.goto(`${fixture.origin}/play/?item=${fixture.game.id}&asset=${rom.id}`);
  const gallery = page.getByRole('region', { name: 'Save state browser' });
  await expect(gallery.getByText('imported.state', { exact: true })).toBeVisible();
  const choose = gallery.getByRole('button', { name: 'Select state', exact: true });
  await expect(choose).toBeDisabled();
  await gallery.getByRole('checkbox', { name: /verified.*imported/i }).check();
  await choose.click();
  await expect(
    page.getByRole('combobox', { name: 'Compatible slot-0 state', exact: true }),
  ).toHaveValue(state.id);
});

async function captureFixture(
  page: import('@playwright/test').Page,
  fixture: Parameters<typeof signIn>[1],
  failSecond: boolean,
) {
  const { createHash } = await import('node:crypto');
  const loader = `export default async options=>{let shots=0;const original=options.canvas.toBlob.bind(options.canvas);options.canvas.toBlob=(callback,...args)=>original(blob=>{callback(blob);if(${failSecond}&&++shots===1)options.canvas.width=8193;},...args);const m={canvas:options.canvas,FS:{mkdirTree(){},writeFile(){},readFile(){return new Uint8Array();}},callMain(){const ctx=options.canvas.getContext('2d');function draw(){ctx.fillStyle='#3399cc';ctx.fillRect(0,0,options.canvas.width,options.canvas.height);m.postMainLoop?.();requestAnimationFrame(draw);}draw();}};return m;};`;
  const profile = await fixture.client.playerProfile('org.example.generated-gba');
  profile.loader.sha256 = createHash('sha256').update(loader).digest('hex');
  profile.loader.sizeBytes = new TextEncoder().encode(loader).length;
  await page.route('**/api/v1/player/profiles**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith('/profiles')
        ? { items: [profile], defaultProfileId: profile.id }
        : profile,
    }),
  );
  await page.route('**/play/plugins/org.example.generated-gba/loader.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: loader }),
  );
  const item = await fixture.client.createItem({
    libraryId: fixture.library.id,
    title: 'Generated screenshot game',
    systemIdentifier: 'com.provenance.gba',
    md5: null,
    crc: null,
  });
  const asset = await fixture.client.upload({
    libraryId: fixture.library.id,
    itemId: item.id,
    kind: 'rom',
    displayName: 'Generated game',
    relativePath: 'generated.gba',
    baseRevision: item.revision,
    body: new Uint8Array([1, 2, 3]),
  });
  await signIn(page, fixture);
  await page.goto(
    `${fixture.origin}/play/?item=${item.id}&asset=${asset.id}&profile=${profile.id}`,
  );
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Capture screenshot', exact: true })).toBeEnabled({
    timeout: 15000,
  });
}
test('capture without synchronized saves focuses the game before requesting a new frame', async ({
  page,
  fixture,
}) => {
  await captureFixture(page, fixture, false);
  await page.getByRole('button', { name: 'Capture screenshot', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Download screenshot', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
});
test('failed recapture removes the previous screenshot instead of offering stale bytes', async ({
  page,
  fixture,
}) => {
  await captureFixture(page, fixture, true);
  const capture = page.getByRole('button', { name: 'Capture screenshot', exact: true });
  await capture.click();
  await expect(
    page.getByRole('button', { name: 'Download screenshot', exact: true }),
  ).toBeVisible();
  await expect(capture).toBeEnabled();
  await capture.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download screenshot', exact: true })).toHaveCount(
    0,
  );
});
