import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const isbn = "9780140328721";

async function mockEditionSeries(page: Page, series: string[] = []): Promise<void> {
  await page.route(`**/isbn/${isbn}.json`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ series })
    });
  });
}

async function mockOpenLibrary(page: Page, title = "Matilda", series: string[] = []): Promise<void> {
  await mockEditionSeries(page, series);
  await page.route("**/search.json?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        docs: [{
          edition_key: ["OL7353617M"],
          title,
          author_name: ["Roald Dahl"],
          publisher: ["Puffin"],
          publish_date: ["1988"],
          isbn: [isbn],
          cover_i: 8739161
        }]
      })
    });
  });
}

async function addBook(page: Page): Promise<void> {
  await mockOpenLibrary(page);
  await page.goto("/");
  await page.getByLabel("ISBN-10 or ISBN-13").fill(isbn);
  await page.getByRole("button", { name: "Find book" }).click();
  await expect(page.getByRole("heading", { name: "New book" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Matilda");
  await expect(page.getByLabel(/Authors/)).toHaveValue("Roald Dahl");
  await page.getByRole("button", { name: "Save book" }).click();
  await expect(page.getByRole("heading", { name: "Your collection" })).toBeVisible();
  await expect(page.getByText("Matilda", { exact: true })).toBeVisible();
}

async function makeDraftCleanupFail(page: Page): Promise<void> {
  await page.evaluate(() => {
    const removeItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key: string): void {
      if (key === "active-book-draft-v1") throw new Error("Simulated draft cleanup failure");
      removeItem.call(this, key);
    };
  });
}

test("lookup, edit, save, search, and reopen a book", async ({ page }) => {
  await addBook(page);
  await page.getByLabel("Search collection").fill("Roald");
  await expect(page.getByText("Matilda", { exact: true })).toBeVisible();
  await page.getByText("Matilda", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Book details" })).toBeVisible();
  await page.getByLabel("Reading status").selectOption("read");
  await page.getByText("Favourite").click();
  await page.getByRole("button", { name: "Save book" }).click();
  await expect(page.getByText("read", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Favourite")).toBeVisible();
});

test("new ISBN lookup fills normalized series details", async ({ page }) => {
  await mockOpenLibrary(page, "A series book", ["Example Saga, #3"]);
  await page.goto("/");
  await page.getByLabel("ISBN-10 or ISBN-13").fill(isbn);
  await page.getByRole("button", { name: "Find book" }).click();

  await expect(page.getByRole("textbox", { name: "Series", exact: true })).toHaveValue("Example Saga");
  await expect(page.getByRole("textbox", { name: "Series number" })).toHaveValue("3");
});

test("background status changes do not replace the editor during a mobile tap", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add a book without an ISBN" }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Stable editor");
  await page.getByLabel(/Authors/).fill("Test Author");

  const saveButtonStayedConnected = await page.getByRole("button", { name: "Save book" }).evaluate((button) => {
    window.dispatchEvent(new Event("online"));
    return button.isConnected;
  });

  expect(saveButtonStayedConnected).toBe(true);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Stable editor");
});

test("repeated save-and-scan-another taps create only one ISBN-less book", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add a book without an ISBN" }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("One tap, one book");
  await page.getByLabel(/Authors/).fill("Test Author");

  await page.getByRole("button", { name: "Save and scan another" }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });

  await expect(page.getByRole("heading", { name: "Scan a book" })).toBeVisible();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(page.getByText("One tap, one book", { exact: true })).toHaveCount(1);
});

test("a draft cleanup error cannot report a committed save as failed", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add a book without an ISBN" }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Safely committed");
  await page.getByLabel(/Authors/).fill("Test Author");
  await makeDraftCleanupFail(page);

  await page.getByRole("button", { name: "Save book" }).click();

  await expect(page.getByRole("heading", { name: "Your collection" })).toBeVisible();
  await expect(page.getByText("Safely committed", { exact: true })).toBeVisible();
  await expect(page.getByText(/Saved .*temporary recovery data could not be cleared/)).toBeVisible();
});

test("a draft cleanup error cannot report a committed deletion as failed", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add a book without an ISBN" }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Delete me safely");
  await page.getByLabel(/Authors/).fill("Test Author");
  await page.getByRole("button", { name: "Save book" }).click();
  await page.getByText("Delete me safely", { exact: true }).click();
  await makeDraftCleanupFail(page);
  page.once("dialog", (dialog) => dialog.accept());

  await page.getByRole("button", { name: "Delete book" }).click();

  await expect(page.getByRole("heading", { name: "Your collection" })).toBeVisible();
  await expect(page.getByText("Book deleted, but temporary recovery data could not be cleared.")).toBeVisible();
  await expect(page.locator(".book-card", { hasText: "Delete me safely" })).toHaveCount(0);
});

test("a superseded slow lookup cannot overwrite the active book", async ({ page }) => {
  await mockEditionSeries(page);
  let requestCount = 0;
  await page.route("**/search.json?**", async (route) => {
    requestCount += 1;
    if (requestCount === 1) await new Promise((resolve) => setTimeout(resolve, 1_200));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ docs: [{
        edition_key: [`OL${requestCount}M`],
        title: requestCount === 1 ? "Stale book" : "Current book",
        author_name: ["Test Author"],
        isbn: [isbn]
      }] })
    });
  });
  await page.goto("/");
  await page.getByLabel("ISBN-10 or ISBN-13").fill(isbn);
  await page.getByRole("button", { name: "Find book" }).click();
  await page.getByRole("button", { name: "Collection" }).click();
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await page.getByLabel("ISBN-10 or ISBN-13").fill(isbn);
  await page.getByRole("button", { name: "Find book" }).click();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Current book", { timeout: 5_000 });
  await page.waitForTimeout(1_500);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Current book");
});

test("settings backfill adds missing series to an existing ISBN book", async ({ page }) => {
  await mockEditionSeries(page, ["Recovered Saga -- bk. 2"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Add a book without an ISBN" }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Existing book");
  await page.getByLabel(/Authors/).fill("Test Author");
  await page.getByRole("textbox", { name: "ISBN" }).fill(isbn);
  await page.getByRole("button", { name: "Save book" }).click();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Check 1 book" }).click();
  await expect(page.getByText("Series lookup finished. 1 book was updated.")).toBeVisible();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await page.getByRole("button", { name: "Series" }).click();
  await expect(page.getByRole("heading", { name: /Recovered Saga/ })).toBeVisible();
  await expect(page.getByText("Recovered Saga · 2", { exact: true })).toBeVisible();
});

test("settings backfill preserves manually entered series", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add a book without an ISBN" }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Manual series book");
  await page.getByLabel(/Authors/).fill("Test Author");
  await page.getByRole("textbox", { name: "ISBN" }).fill(isbn);
  await page.getByRole("textbox", { name: "Series", exact: true }).fill("My Correct Series");
  await page.getByRole("textbox", { name: "Series number" }).fill("4");
  await page.getByRole("button", { name: "Save book" }).click();

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: "No missing series" })).toBeDisabled();
});

test("exports and safely replaces the catalogue from the downloaded backup", async ({ page }, testInfo) => {
  await addBook(page);
  await page.getByRole("button", { name: "Settings" }).click();
  const exportDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export collection" }).click();
  const backup = await exportDownload;
  const backupPath = testInfo.outputPath("catalogue.json");
  await backup.saveAs(backupPath);

  await page.locator("#backup-file").setInputFiles(backupPath);
  await expect(page.getByText("Validated backup")).toBeVisible();
  const safetyDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "1. Download current collection" }).click();
  await safetyDownload;
  await page.getByLabel("I have retained the safety copy").check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Replace collection" }).click();
  await expect(page.getByText("Collection replaced with 1 books.")).toBeVisible();
});

test("primary screens have no serious automated accessibility violations", async ({ page }) => {
  await page.goto("/");
  const scanResults = await new AxeBuilder({ page }).analyze();
  expect(scanResults.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);

  await page.getByRole("button", { name: "Add a book without an ISBN" }).click();
  const editorResults = await new AxeBuilder({ page }).analyze();
  expect(editorResults.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
});
