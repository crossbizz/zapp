import { expect, test } from '@playwright/test';

test('fixture passes', async ({ page }) => {
  await page.setContent('<main data-testid="fixture">ready</main>');
  await expect(page.getByTestId('fixture')).toHaveText('ready');
});

test('fixture fails with screenshot evidence', async ({ page }) => {
  await page.setContent('<main data-testid="fixture">actual</main>');
  await expect(page.getByTestId('fixture')).toHaveText('expected');
});
