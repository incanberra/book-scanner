import { test, expect } from '@playwright/test';
import { fakeCamera, mockBookSearch, openCoverFallback, tracksEnded } from '../helpers/cover-browser';

for (const layout of ['portrait', 'landscape', 'tilted'] as const) {
test(`real OCR reads a ${layout} live frame using only production subpath assets`, async ({ page, context }) => {
  test.setTimeout(90_000);
  await fakeCamera(page, layout); await mockBookSearch(page);
  const assets: string[] = [];
  const errors: string[] = [];
  context.on('response', response => { if (response.url().includes('/ocr/')) { assets.push(response.url()); if (!response.ok()) errors.push(response.url()); } });
  // An external OCR CDN request is a test failure; catalogue requests stay mocked.
  const unexpected: string[] = [];
  await context.route(/https:\/\/(?!openlibrary\.org|covers\.openlibrary\.org)/, route => { unexpected.push(route.request().url()); return route.abort(); });
  await page.goto('./');
  await openCoverFallback(page);
  if (layout === 'portrait') await page.screenshot({ path: test.info().outputPath('live-camera.png'), fullPage: true });
  await page.getByRole('button', { name: 'Read cover', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm the title and author' })).toBeVisible({ timeout: 65_000 });
  await expect(page.getByLabel('Book title', { exact: true })).toHaveValue(/MATILDA/i);
  await expect(page.getByLabel('Author', { exact: true })).toHaveValue(/ROALD DAHL/i);
  if (layout === 'portrait') await page.screenshot({ path: test.info().outputPath('identified-book.png'), fullPage: true });
  expect(await tracksEnded(page)).toBe(true);
  expect(assets.some(url => url.endsWith('/worker.min.js'))).toBe(true);
  expect(assets.some(url => url.endsWith('/eng.traineddata.gz'))).toBe(true);
  expect(assets.every(url => url.includes('/book-scanner/ocr/v1/'))).toBe(true);
  expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  await expect.poll(() => page.workers().length).toBe(0);
  await page.getByRole('button', { name: /Use this book/ }).click();
  await expect(page.getByRole('textbox', { name: 'ISBN', exact: true })).toHaveValue('9780140328721');
});
}

for (const asset of ['eng.traineddata.gz', 'worker.min.js']) {
  test(`failed ${asset} load reports failure promptly and allows retry`, async ({ page, context }) => {
    await fakeCamera(page); await mockBookSearch(page);
    await context.route(`**/ocr/v1/${asset}`, route => route.abort());
    await page.goto('./'); await openCoverFallback(page);
    await page.getByRole('button', { name: 'Read cover', exact: true }).click();
    await expect(page.getByText(/cover reader could not/)).toBeVisible({ timeout: 12_000 });
    expect(await tracksEnded(page)).toBe(true);
    await expect.poll(() => page.workers().length).toBe(0);
    await expect(page.getByRole('button', { name: 'Choose image instead' })).toBeEnabled();
    await expect(page.getByLabel('Book title', { exact: true })).toBeEditable();
  });
}
