/// <reference types="node" />
import AxeBuilder from "@axe-core/playwright";
import { Buffer } from "node:buffer";
import { test, expect, type Page } from "@playwright/test";

const isbn = "9780140328721";
const photo = { name: "cover.png", mimeType: "image/png", buffer: Buffer.from("test photo") };

async function setup(page: Page, ocr = "Matilda Roald Dahl") {
  // Keep flow tests deterministic; the real OCR worker is checked separately.
  await page.route("**/src/cover.ts", (route) => route.fulfill({ contentType: "text/javascript", body:
    `export async function readCover(file, signal) { return ${JSON.stringify(ocr)}; }`
  }));
  await page.route("**/search.json?**", (route) => {
    const query = new URL(route.request().url());
    return route.fulfill({ json: { docs: query.searchParams.has("isbn") ? [] : [{
      key: "/works/OL1W", title: "Matilda", author_name: ["Roald Dahl"], isbn: ["9780061120084"]
    }] } });
  });
  await page.goto("/");
}

async function fallback(page: Page, checker = false) {
  if (checker) await page.getByRole("button", { name: "Book Check", exact: true }).click();
  await page.getByLabel(checker ? "Book Check ISBN-10 or ISBN-13" : "ISBN-10 or ISBN-13", { exact: true }).fill(isbn);
  await page.getByRole("button", { name: checker ? "Check book" : "Find book", exact: true }).click();
  await page.getByRole("button", { name: "Scan front cover", exact: true }).click();
}

test("failed ISBN offers cover capture, searches read words, and preserves ISBN after confirmation", async ({ page }) => {
  await setup(page);
  await fallback(page);
  await expect(page.locator("#cover-camera")).toHaveAttribute("capture", "environment");
  await page.locator("#cover-upload").setInputFiles(photo);
  await expect(page.getByRole("heading", { name: "Confirm the title and author" })).toBeVisible();
  await expect(page.getByLabel("Words read from the cover")).toHaveValue("Matilda Roald Dahl");
  await expect(page.getByRole("heading", { name: "New book" })).not.toBeVisible();
  await page.getByRole("button", { name: "Matilda Roald Dahl", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Matilda");
  await expect(page.getByRole("textbox", { name: "ISBN", exact: true })).toHaveValue(isbn);
  await expect(page.getByLabel("Publisher", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Save book", exact: true }).click();
  await expect(page.getByText("Matilda", { exact: true })).toBeVisible();
});

test("Book Check cover confirmation recognises a saved other edition without adding a book", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Add a book without an ISBN" }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Matilda");
  await page.getByLabel(/Authors/).fill("Roald Dahl");
  await page.getByRole("button", { name: "Save book", exact: true }).click();
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await fallback(page, true);
  await page.locator("#cover-camera").setInputFiles(photo);
  await page.getByRole("button", { name: "Matilda Roald Dahl", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Already owned" })).toBeVisible();
  await expect(page.getByLabel("1 books saved")).toBeVisible();
});

test("unreadable photo can be replaced by corrected title and author search", async ({ page }) => {
  await setup(page, "");
  await fallback(page);
  await page.locator("#cover-upload").setInputFiles(photo);
  await expect(page.getByText(/No readable title or author found/)).toBeVisible();
  await page.getByLabel("Book title", { exact: true }).fill("Matilda");
  await page.getByLabel("Author", { exact: true }).fill("Roald Dahl");
  const request = page.waitForRequest((request) => request.url().includes("title=Matilda") && request.url().includes("author=Roald+Dahl"));
  await page.getByRole("button", { name: "Search books", exact: true }).click();
  await request;
  await expect(page.getByRole("heading", { name: "Confirm the title and author" })).toBeVisible();
});

test("no cover match leaves retry and manual entry available with original ISBN", async ({ page }) => {
  await setup(page);
  await page.route("**/search.json?**", (route) => route.fulfill({ json: { docs: [] } }));
  await fallback(page);
  await page.locator("#cover-upload").setInputFiles(photo);
  await expect(page.getByText(/No matching books found/)).toBeVisible();
  await page.getByRole("button", { name: "Enter details manually", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "ISBN", exact: true })).toHaveValue(isbn);
});

test("leaving a pending cover read cannot replace the destination", async ({ page }) => {
  await setup(page);
  await page.route("**/src/cover.ts", (route) => route.fulfill({ contentType: "text/javascript", body:
    'export async function readCover() { await new Promise(resolve => setTimeout(resolve, 800)); return "Matilda"; }'
  }));
  await page.reload();
  await fallback(page);
  await page.locator("#cover-upload").setInputFiles(photo);
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await page.waitForTimeout(1000);
  await expect(page.getByRole("heading", { name: "Your collection" })).toBeVisible();
});

test("cover form and candidate results are accessible at phone width", async ({ page }) => {
  await setup(page);
  await fallback(page);
  await page.locator("#cover-upload").setInputFiles(photo);
  await expect(page.getByRole("heading", { name: "Confirm the title and author" })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
