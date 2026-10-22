import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Seed only this test browser's IndexedDB; no network or real catalogue is used.
async function seedShelf(page: Page, count = 125) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Scan a book" })).toBeVisible();
  await page.evaluate(async count => {
    const modulePath = "/src/catalog.ts";
    const { booksTable } = await import(modulePath) as typeof import("../../src/catalog");
    await booksTable.bulkPut(Array.from({ length: count }, (_, i) => ({
      id: `test-${i}`, title: `Shelf book ${String(i).padStart(3, "0")}`,
      authors: ["Doe, Jane"], authorKeys: ["doe jane"], favourite: i % 2 === 0,
      readingStatus: i % 3 === 0 ? "read" : "unread", metadataSource: "manual",
      createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString()
    })));
  }, count);
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(page.locator("[data-book]")).toHaveCount(Math.min(count, 60));
}

test("search preserves its DOM node and caret, and delegated rows still open", async ({ page }) => {
  await seedShelf(page);
  const search = page.getByLabel("Search collection");
  await search.fill("Shelf book 012");
  const preserved = await search.evaluate((node: HTMLInputElement) => {
    node.focus();
    node.setSelectionRange(5, 5);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    return { connected: node.isConnected, caret: node.selectionStart, focused: document.activeElement === node };
  });
  expect(preserved).toEqual({ connected: true, caret: 5, focused: true });
  await expect(page.locator("[data-book]")).toHaveCount(1);
  await page.getByText("Shelf book 012", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Book details" })).toBeVisible();
});

test("filters, reset, recent order and pagination work together", async ({ page }) => {
  await seedShelf(page);
  await page.getByLabel("Reading filter").selectOption("read");
  await page.getByLabel("Favourites only").check();
  await expect(page.locator("[data-book]")).toHaveCount(21);
  await page.getByLabel("Search collection").fill("no such book");
  await expect(page.getByRole("heading", { name: "No books match" })).toBeVisible();
  await page.getByRole("button", { name: "Clear search and filters" }).click();
  await expect(page.getByLabel("Favourites only")).not.toBeChecked();
  await expect(page.locator("[data-book]")).toHaveCount(60);
  await page.getByLabel("Browse by").selectOption("recent");
  await expect(page.locator("[data-book]").first()).toContainText("Shelf book 124");
  await page.getByRole("button", { name: "Show more books" }).click();
  await expect(page.locator("[data-book]")).toHaveCount(120);
  await page.getByRole("button", { name: "Show more books" }).click();
  await expect(page.locator("[data-book]")).toHaveCount(125);
  await expect(page.getByRole("button", { name: "Show more books" })).toHaveCount(0);
});

test("opening and closing a book keeps your shelf position and loaded rows", async ({ page }) => {
  await seedShelf(page);
  await page.getByRole("button", { name: "Show more books" }).click();
  const row = page.getByRole("button", { name: /Shelf book 090/ });
  await row.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  await row.click();
  await expect(page.getByLabel("Authors")).toHaveValue("Doe, Jane");
  await page.getByRole("button", { name: "Close editor" }).click();
  await expect(page.locator("[data-book]")).toHaveCount(120);
  await expect(row).toBeFocused();
  expect(Math.abs(await page.evaluate(() => window.scrollY) - scroll)).toBeLessThan(5);
});

test("saving an author with a comma keeps the name intact", async ({ page }) => {
  await seedShelf(page, 1);
  await page.getByRole("button", { name: /Shelf book 000/ }).click();
  await page.getByRole("button", { name: "Save book", exact: true }).click();
  await page.getByRole("button", { name: /Shelf book 000/ }).click();
  await expect(page.getByLabel("Authors")).toHaveValue("Doe, Jane");
});

test("a manual book can be added directly from the collection", async ({ page }) => {
  await seedShelf(page, 1);
  await page.getByRole("button", { name: "Add book", exact: true }).click();
  await page.getByRole("button", { name: "Close editor" }).click();
  await expect(page.getByRole("heading", { name: "Your collection" })).toBeVisible();
  await page.getByLabel("Search collection").fill("Shelf");
  await page.getByLabel("Reading filter").selectOption("read");
  await page.getByRole("button", { name: "Add book", exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("A new book outside the filter");
  await page.getByLabel("Authors").fill("An Author");
  await page.getByRole("button", { name: "Save book", exact: true }).click();
  await expect(page.getByRole("button", { name: /A new book outside the filter/ })).toBeVisible();
  await expect(page.getByLabel("Browse by")).toHaveValue("recent");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("collection controls remain accessible on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await seedShelf(page, 4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const scan = await new AxeBuilder({ page }).analyze();
  expect(scan.violations).toEqual([]);
});
