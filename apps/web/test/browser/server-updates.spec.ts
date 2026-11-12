import type { ServerUpdateStatus } from '@ecs/client';
import { expect, signIn, test } from './fixture';

test('owner selects a channel and decides what to do with each offered build', async ({
  page,
  fixture,
}) => {
  const builtAt = '2026-11-11T12:00:00Z';
  const checkedAt = '2026-11-12T14:00:00Z';
  const build = {
    id: 'a'.repeat(64),
    channel: 'nightly' as const,
    version: 'nightly-aaaaaaaaaaaa',
    builtAt,
  };
  const installed = { ...build, id: 'b'.repeat(64), version: 'nightly-bbbbbbbbbbbb' };
  const status: ServerUpdateStatus = {
    supported: true,
    settings: { channel: 'release', mode: 'off' },
    phase: 'idle',
    prompt: false,
    current: installed,
    lastCheckedAt: checkedAt,
    history: [{ build: installed, outcome: 'installed', at: '2026-11-12T13:00:00Z' }],
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
  await expect(page.getByRole('heading', { name: 'Update history' })).toBeVisible();
  await expect(page.locator(`time[datetime="${checkedAt}"]`)).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: installed.version })).toContainText(
    'Installed',
  );
  await page.getByRole('combobox', { name: 'Channel', exact: true }).selectOption('nightly');
  await expect(page.getByRole('combobox', { name: 'Channel', exact: true })).toHaveValue('nightly');
  await page.getByRole('combobox', { name: 'Updates', exact: true }).selectOption('manual');
  const prompt = page.getByRole('region', { name: 'Server update available' });
  await expect(prompt).toContainText(build.version);
  await expect(page.getByText('Update available', { exact: true }).last()).toBeVisible();
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
