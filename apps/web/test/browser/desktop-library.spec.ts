import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { expect, test } from './fixture';

// Serve only built first-party tray assets at an already-allowed development origin.
// API/catalog fixtures remain ephemeral and independent of any operator service.
test('bundled desktop library shares sign-out across windows and downloads via the API', async ({
  page,
  context,
  fixture,
}) => {
  const root = resolve('../tray/dist');
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(`${root}/`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const type = file.endsWith('.html')
        ? 'text/html'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/javascript';
      response.writeHead(200, { 'content-type': type }).end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(5174, '127.0.0.1', done);
  });
  const desktop = 'http://127.0.0.1:5174';
  try {
    await page.goto(`${desktop}/library.html`);
    await page.evaluate((session) => {
      localStorage.setItem('ecs.tray.session', JSON.stringify(session));
      localStorage.setItem('ecs.session', JSON.stringify(session));
    }, fixture.session);
    await page.getByLabel('Server address', { exact: true }).fill(fixture.origin);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await page.getByLabel('Username', { exact: true }).fill('browser-owner');
    await page.getByLabel('Password', { exact: true }).fill(fixture.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Arcade', exact: true }).click();
    await page.getByRole('button', { name: 'Open Game 000', exact: true }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download sample.nes', exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe('sample.nes');
    const downloadedPath = await download.path();
    expect(downloadedPath).toBeTruthy();
    expect([...(await readFile(downloadedPath ?? ''))]).toEqual([1, 2, 3, 4]);
    const status = await context.newPage();
    await status.goto(`${desktop}/index.html`);
    await expect(status.getByText('Signed in to this server in the desktop app.')).toBeVisible();
    await status.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Game 000', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('ecs.tray.session'))).toBe(null);
    expect(await page.evaluate(() => !!localStorage.getItem('ecs.session'))).toBe(true);
  } finally {
    // The API fixture tears down before Playwright's context fixture. Navigating
    // away leaves Chromium's cross-origin keep-alive sockets open, so close this
    // context first rather than letting those sockets hold API shutdown open.
    await context.close();
    await new Promise<void>((done, reject) => {
      server.close((error) => (error ? reject(error) : done()));
    });
  }
});
