import { ContentClient } from '@ecs/client';
import { expect, libraryTool, signIn, test } from './fixture.js';

test('Scans & details exposes folder policies, scan history and cleanup review', async ({
  page,
  fixture,
}) => {
  await fixture.cleanup();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Scans & details', exact: true }).click();
  const watch = page.getByRole('button', { name: 'Watch settings for Cleanup games' });
  await watch.click();
  const watchDialog = page.getByRole('dialog', { name: 'Folder watching', exact: true });
  await expect(watchDialog.getByRole('status')).toHaveText('Folder watching is off.');
  await page.keyboard.press('Escape');
  await expect(watch).toBeFocused();

  await page.getByRole('button', { name: 'Organization settings for Cleanup games' }).click();
  const organization = page.getByRole('dialog', { name: 'Automatic organization', exact: true });
  await expect(organization.getByRole('status')).toContainText('Automatic organization is off');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Scan Cleanup games', exact: true }).click();
  const scanHistory = page.getByRole('combobox', { name: 'Server activity' });
  await expect(scanHistory).toContainText('Cleanup games · Folder scan · Finished');

  await page.getByRole('combobox', { name: 'Cleanup library' }).selectOption(fixture.library.id);
  await page.getByRole('button', { name: 'Start cleanup inspection', exact: true }).click();
  await expect(page.getByTestId('cleanup-progress')).toContainText('completed', { timeout: 15000 });
  await expect(page.getByRole('combobox', { name: 'Cleanup activity' })).toBeVisible();
  await expect(scanHistory).toBeVisible();
  await expect(page.getByTestId('cleanup-proposal')).toHaveCount(2);
});

test('native no-key cleanup reviews a subset, applies once and can undo after reopening', async ({
  page,
  fixture,
  browser,
}) => {
  await fixture.cleanup();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Open library Arcade', exact: true }).click();
  await libraryTool(page, 'Library activity');
  await page.getByRole('button', { name: 'Review library cleanup', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Start cleanup inspection', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Start cleanup inspection', exact: true }).click();
  await page.getByRole('button', { name: 'Close cleanup review', exact: true }).click();
  await page.getByRole('button', { name: 'Review library cleanup', exact: true }).click();
  await expect(page.getByTestId('cleanup-progress')).toContainText('completed', { timeout: 15000 });
  const cards = page.getByTestId('cleanup-proposal');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('Current');
  await expect(cards.first()).toContainText('Proposed');
  await expect(cards.first()).toContainText('missing');
  await cards.first().getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Approve 1 selected fix', exact: true }).click();
  await page.getByRole('button', { name: 'Apply approved fixes', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '1 source updated' })).toBeVisible();
  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await signIn(secondPage, fixture);
  await secondPage.getByRole('button', { name: 'Open library Arcade', exact: true }).click();
  await libraryTool(secondPage, 'Library activity');
  await secondPage.getByRole('button', { name: 'Review library cleanup', exact: true }).click();
  await expect(
    secondPage.getByRole('button', { name: 'Undo saved fixes', exact: true }),
  ).toHaveCount(1);
  await second.close();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Arcade', exact: true })).toBeVisible();
  await libraryTool(page, 'Library activity');
  await page.getByRole('button', { name: 'Review library cleanup', exact: true }).click();
  await page.getByRole('button', { name: 'Undo saved fixes', exact: true }).click();
  await expect(page.getByText('Restored the previous selections.', { exact: true })).toBeVisible();
  await page
    .getByRole('heading', { name: 'Library cleanup', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/ecs-library-cleanup-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Library cleanup', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page
    .getByRole('heading', { name: 'Library cleanup', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/ecs-library-cleanup-mobile.png' });
});

test('the owner reviews and applies a proposal submitted by an investigator', async ({
  page,
  fixture,
}) => {
  const folder = await fixture.cleanup();
  const issued = await fixture.client.createInvestigator({
    libraryIds: [fixture.library.id],
    operations: ['inspect', 'cleanup', 'suggest'],
    ttlSeconds: 120,
  });
  const investigator = new ContentClient(fixture.origin, issued.token);
  const { items } = await investigator.investigatorSources(fixture.library.id);
  const source = items.find((item) => item.name === 'First.j64');
  if (!source) throw new Error('Missing generated source');
  const { run } = await investigator.startInvestigatorRun({
    libraryId: fixture.library.id,
    sourceIds: [source.id],
  });
  const inspection = await investigator.inspectInvestigatorSource(run.id, source.id);
  const cover = inspection.candidates.find((item) => item.kind === 'artwork');
  if (!cover) throw new Error('Missing generated artwork candidate');
  const result = await investigator.submitInvestigatorSuggestion(run.id, {
    sourceId: source.id,
    kind: 'missing-front-artwork',
    reason: 'The investigator found a local front cover.',
    candidateIds: [cover.id],
    evidenceIds: cover.evidenceIds,
  });
  await investigator.finishInvestigatorRun(run.id);
  await folder.stop();
  const proposal = result.proposals[0];
  if (!proposal) throw new Error('Missing investigator proposal');
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Open library Arcade', exact: true }).click();
  await libraryTool(page, 'Library activity');
  await page.getByRole('button', { name: 'Review library cleanup', exact: true }).click();
  await expect(page.getByTestId('cleanup-progress')).toContainText('completed');
  const card = page.getByTestId('cleanup-proposal');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('The investigator found a local front cover.');
  await card.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Approve 1 selected fix', exact: true }).click();
  await page.getByRole('button', { name: 'Apply approved fixes', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '1 source updated' })).toBeVisible();
  const receipt = (await fixture.client.workflowApplications(run.id)).items[0];
  expect(receipt?.status).toBe('applied');
  expect(JSON.parse(receipt?.resultJson ?? '{}').proposals).toContainEqual({
    id: proposal.id,
    version: proposal.version,
    digest: proposal.digest,
  });
});
