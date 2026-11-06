import type { Page } from '@playwright/test';

/** Runtime bridge tests own a visible canvas independently of the player's launch screen. */
export async function mountRuntimeCanvas(page: Page) {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    document.body.prepend(canvas);
  });
}
