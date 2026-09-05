import { expect, test } from '@playwright/test';
import { fakeCamera, mockBookSearch, openCoverFallback } from '../helpers/cover-browser';
const endpoint = 'https://book-scanner-test.netlify.app/.netlify/functions/read-cover';
const token = 'test-only-access-token-12345678901234567890';
test('AI scan sends a compressed camera frame and preserves confirmation and ISBN', async ({ page }) => {
  await fakeCamera(page); await mockBookSearch(page);
  let uploads = 0;
  await page.route(endpoint, async route => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization,content-type' } }); return;
    }
    uploads++;
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    expect(route.request().headers()['content-type']).toBe('image/jpeg');
    expect(route.request().postDataBuffer()!.length).toBeGreaterThan(100);
    await route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { title: 'Matilda', author: 'Roald Dahl' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Netlify scanner endpoint').fill(endpoint);
  await page.getByLabel('Scanner access token').fill(token);
  await page.getByRole('button', { name: 'Enable AI for this session' }).click();
  await expect(page.getByText('AI cover scanning enabled for this session.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(token);
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  await openCoverFallback(page);
  await expect(page.getByText(/AI mode: Read cover sends/)).toBeVisible();
  await page.getByRole('button', { name: 'Read cover', exact: true }).click();
  await page.getByRole('button', { name: /Use this book/ }).click();
  await expect(page.getByRole('textbox', { name: 'ISBN', exact: true })).toHaveValue('9780140328721');
  expect(uploads).toBe(1);
  await page.reload();
  await openCoverFallback(page);
  await page.getByRole('button', { name: 'Read cover', exact: true }).click();
  await expect(page.getByText(/Unlock AI scanning in Settings/)).toBeVisible();
  expect(uploads).toBe(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Use local OCR instead' }).click();
  expect(await page.evaluate(() => localStorage.getItem('cover-ai-endpoint'))).toBeNull();
});
