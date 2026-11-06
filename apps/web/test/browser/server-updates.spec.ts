import type { ServerUpdateStatus } from '@ecs/client';
import { expect, signIn, test } from './fixture';

test('owner selects a channel and decides what to do with each offered build', async ({
  page,
  fixture,
}) => {
  const build = { id: 'a'.repeat(64), channel: 'nightly', version: 'nightly-aaaaaaaaaaaa' };
  const status: ServerUpdateStatus = {
    supported: true,
    settings: { channel: 'release', mode: 'off' },
    phase: 'idle',
    prompt: false,
  };
  const decisions: { action: string; buildId?: string }[] = [];
  await page.route('**/api/v1/server/updates', async (route) => {
    const request = route.request();
    if (request.method() === 'PUT') {
      status.settings = request.postDataJSON();
      status.prompt = status.settings.mode === 'manual';
      status.available = status.prompt ? build : undefined;
    } else if (request.method() === 'POST') {
      const decision = request.postDataJSON();
      decisions.push(decision);
      status.prompt = decision.action === 'check';
      if (decision.action === 'install') status.phase = 'restarting';
    }
    await route.fulfill({ json: status });
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Updates', exact: true }).click();
  await page.getByRole('combobox', { name: 'Channel', exact: true }).selectOption('nightly');
  await expect(page.getByRole('combobox', { name: 'Channel', exact: true })).toHaveValue('nightly');
  await page.getByRole('combobox', { name: 'Updates', exact: true }).selectOption('manual');
  const prompt = page.getByRole('region', { name: 'Server update available' });
  await expect(prompt).toContainText(build.version);
  await prompt.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await prompt.getByRole('button', { name: 'Skip this version', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await prompt.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Restarting the server' }).first(),
  ).toBeVisible();
  expect(decisions).toEqual([
    { action: 'later', buildId: build.id },
    { action: 'check' },
    { action: 'skip', buildId: build.id },
    { action: 'check' },
    { action: 'install', buildId: build.id },
  ]);
});
