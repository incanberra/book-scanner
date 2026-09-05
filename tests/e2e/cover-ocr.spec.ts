import { test, expect } from '@playwright/test';
import { fakeCamera, mockBookSearch, openCoverFallback } from '../helpers/cover-browser';

test('real OCR also reads a camera frame through the development server', async ({ page }) => {
  test.setTimeout(90_000);
  await fakeCamera(page); await mockBookSearch(page);
  await page.goto('/'); await openCoverFallback(page);
  await page.getByRole('button', { name: 'Read cover', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm the title and author' })).toBeVisible({ timeout: 65_000 });
  await expect(page.getByLabel('Book title', { exact: true })).toHaveValue(/MATILDA/i);
  await expect(page.getByLabel('Author', { exact: true })).toHaveValue(/ROALD DAHL/i);
  await expect.poll(() => page.workers().length).toBe(0);
});
