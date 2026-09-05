import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { fakeCamera, fakeOcr, mockBookSearch, openCoverFallback, tracksEnded } from '../helpers/cover-browser';

test.beforeEach(async ({ page }) => { await fakeCamera(page); await fakeOcr(page); await mockBookSearch(page); await page.goto('/'); });

test('live rear camera captures a frame, identifies title/author and preserves ISBN only after confirmation', async ({ page }) => {
  await openCoverFallback(page);
  await expect(page.getByLabel('Live rear-camera cover preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read cover', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).cameraState.requests[0].video.facingMode)).toEqual({ ideal: 'environment' });
  await page.getByRole('button', { name: 'Read cover', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm the title and author' })).toBeVisible();
  expect(await tracksEnded(page)).toBe(true);
  expect(await page.evaluate(() => (window as any).ocrState.imageBytes)).toBeGreaterThan(100);
  await expect(page.getByLabel('Book title', { exact: true })).toHaveValue('MATILDA');
  await expect(page.getByLabel('Author', { exact: true })).toHaveValue('ROALD DAHL');
  await expect(page.getByRole('heading', { name: 'New book' })).not.toBeVisible();
  await page.getByRole('button', { name: /Matilda Roald Dahl Use this book/ }).click();
  await expect(page.getByRole('textbox', { name: 'ISBN', exact: true })).toHaveValue('9780140328721');
  await expect(page.getByLabel('Publisher', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Save book', exact: true }).click();
  await expect(page.getByText('Matilda', { exact: true })).toBeVisible();
});

test('Book Check uses confirmed cover identity against a saved other edition without adding anything', async ({ page }) => {
  await page.getByRole('button', { name: 'Add a book without an ISBN' }).click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Matilda');
  await page.getByLabel(/Authors/).fill('Roald Dahl');
  await page.getByRole('button', { name: 'Save book', exact: true }).click();
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  await openCoverFallback(page, true);
  await page.getByRole('button', { name: 'Read cover', exact: true }).click();
  await page.getByRole('button', { name: /Use this book/ }).click();
  await expect(page.getByRole('heading', { name: 'Already owned' })).toBeVisible();
  await expect(page.getByLabel('1 books saved')).toBeVisible();
});

for (const exit of ['cancel', 'navigate', 'background', 'replace', 'stop']) {
  test(`camera tracks stop on ${exit}`, async ({ page }) => {
    await openCoverFallback(page);
    await expect(page.getByRole('button', { name: 'Read cover', exact: true })).toBeEnabled();
    if (exit === 'cancel') await page.getByRole('button', { name: 'Cancel cover search' }).click();
    if (exit === 'navigate') await page.getByRole('button', { name: 'Collection', exact: true }).click();
    if (exit === 'stop') await page.getByRole('button', { name: 'Stop camera' }).click();
    if (exit === 'background') await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    if (exit === 'replace') await page.evaluate(() => window.dispatchEvent(new Event('bookscanner:database-blocked')));
    expect(await tracksEnded(page)).toBe(true);
  });
}

test('late permission response after cancellation releases its tracks and cannot replace the destination', async ({ page }) => {
  await page.evaluate(() => { (window as any).cameraState.mode = 'pending'; });
  await openCoverFallback(page);
  await page.getByRole('button', { name: 'Cancel cover search' }).click();
  await page.evaluate(() => (window as any).cameraState.pending.forEach((resolve: () => void) => resolve()));
  await expect.poll(() => tracksEnded(page)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Scan a book' })).toBeVisible();
});

test('connectivity updates keep the live video attached', async ({ page }) => {
  await openCoverFallback(page);
  await expect(page.getByRole('button', { name: 'Read cover', exact: true })).toBeEnabled();
  expect(await page.locator('#cover-preview').evaluate(video => { window.dispatchEvent(new Event('online')); return video.isConnected; })).toBe(true);
  expect(await tracksEnded(page)).toBe(false);
});

test('permission denial keeps image selection, retry and manual fields available', async ({ page }) => {
  await page.evaluate(() => { (window as any).cameraState.mode = 'denied'; });
  await openCoverFallback(page);
  await expect(page.getByText(/Camera permission was denied/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose image instead' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Enter details manually', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'ISBN', exact: true })).toHaveValue('9780140328721');
});

test('OCR progress and cancellation terminate the reader and cannot change the destination', async ({ page }) => {
  await page.evaluate(() => { (window as any).ocrState.delay = 1000; });
  await openCoverFallback(page);
  await page.getByRole('button', { name: 'Read cover', exact: true }).click();
  await expect(page.getByText('Reading cover… 35%')).toBeVisible();
  await page.getByRole('button', { name: 'Collection', exact: true }).click();
  expect(await page.evaluate(() => (window as any).ocrState.workers.every((worker: any) => worker.terminated))).toBe(true);
  await page.waitForTimeout(1100);
  await expect(page.getByRole('heading', { name: 'Your collection' })).toBeVisible();
});

test('unreadable cover can be corrected with a title and author search', async ({ page }) => {
  await page.evaluate(() => { (window as any).ocrState.empty = true; });
  await openCoverFallback(page);
  await page.getByRole('button', { name: 'Read cover', exact: true }).click();
  await expect(page.getByText(/No readable title or author found/)).toBeVisible();
  await page.getByLabel('Book title', { exact: true }).fill('Matilda');
  await page.getByLabel('Author', { exact: true }).fill('Roald Dahl');
  const request = page.waitForRequest(request => request.url().includes('title=Matilda') && request.url().includes('author=Roald+Dahl'));
  await page.getByRole('button', { name: 'Search books', exact: true }).click();
  await request;
  await expect(page.getByRole('heading', { name: 'Confirm the title and author' })).toBeVisible();
});

for (const failure of ['reader', 'network', 'no-match']) {
  test(`${failure} failure releases resources and leaves retries and manual entry`, async ({ page }) => {
    if (failure === 'reader') await page.evaluate(() => { (window as any).ocrState.fail = true; });
    await openCoverFallback(page);
    if (failure === 'network') await page.route('**/search.json?**', route => route.abort());
    if (failure === 'no-match') await page.route('**/search.json?**', route => route.fulfill({ json: { docs: [] } }));
    await page.getByRole('button', { name: 'Read cover', exact: true }).click();
    await expect(page.getByText(failure === 'reader' ? /reader could not load/ : failure === 'network' ? /Cover search could not finish/ : /No matching books found/)).toBeVisible();
    expect(await tracksEnded(page)).toBe(true);
    await expect(page.getByRole('button', { name: 'Choose image instead' })).toBeEnabled();
    await page.getByRole('button', { name: 'Enter details manually', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'ISBN', exact: true })).toHaveValue('9780140328721');
  });
}

test('live camera and results are accessible at phone width', async ({ page }) => {
  await openCoverFallback(page);
  await expect(page.getByRole('button', { name: 'Read cover', exact: true })).toBeEnabled();
  for (const state of ['camera', 'results']) {
    if (state === 'results') {
      await page.getByRole('button', { name: 'Read cover', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Confirm the title and author' })).toBeVisible();
    }
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.filter(v => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('a second camera session stays live when an earlier permission request finally resolves', async ({ page }) => {
  await page.evaluate(() => { (window as any).cameraState.mode = 'pending'; });
  await openCoverFallback(page);
  await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
  await page.evaluate(() => { (window as any).cameraState.mode = 'ready'; });
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Read cover', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).cameraState.pending.forEach((resolve: () => void) => resolve()));
  await expect.poll(() => page.evaluate(() => (window as any).cameraState.tracks.map((track: MediaStreamTrack) => track.readyState))).toEqual(['live', 'ended']);
  await page.getByRole('button', { name: 'Read cover', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm the title and author' })).toBeVisible();
});

test('offline cover search explains the limitation and retains manual entry', async ({ page }) => {
  await openCoverFallback(page);
  await expect(page.getByRole('button', { name: 'Read cover', exact: true })).toBeEnabled();
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Read cover', exact: true }).click();
  await expect(page.getByText(/You’re offline. Reconnect to search/)).toBeVisible();
  await page.getByRole('button', { name: 'Enter details manually', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'ISBN', exact: true })).toHaveValue('9780140328721');
});

for (const checker of [false, true]) {
  test(`background screen refresh preserves typed ISBN in ${checker ? 'Book Check' : 'Scan'}`, async ({ page }) => {
    if (checker) await page.getByRole('button', { name: 'Book Check', exact: true }).click();
    const input = page.getByLabel(checker ? 'Book Check ISBN-10 or ISBN-13' : 'ISBN-10 or ISBN-13', { exact: true });
    await input.fill('9780140328721');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(input).toHaveValue('9780140328721');
    await page.getByRole('button', { name: checker ? 'Check book' : 'Find book', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Scan front cover', exact: true })).toBeVisible();
  });
}
