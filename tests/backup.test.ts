import { beforeEach, describe, expect, it } from "vitest";
import fixture from "./fixtures/catalogue-v1.json";
import {
  booksToCsv,
  createBackup,
  createCsvExport,
  CSV_COLUMNS,
  escapeCsvField,
  replaceCatalogue,
  validateBackupJson,
  type BackupPreview
} from "../src/backup";
import { bookDatabase, booksTable, getSetting, lookupCacheTable, type Book } from "../src/catalog";

const settingsTable = bookDatabase.table<{ key: string; value: unknown }, string>("settings");

const oldBook: Book = {
  id: "22222222-2222-4222-8222-222222222222",
  isbn13: "9780061120084",
  title: "The Old Collection",
  authors: ["Harper Lee"],
  authorKeys: ["harper lee"],
  favourite: false,
  readingStatus: "unread",
  metadataSource: "manual",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

beforeEach(async () => {
  await bookDatabase.transaction("rw", booksTable, lookupCacheTable, settingsTable, async () => {
    await booksTable.clear();
    await lookupCacheTable.clear();
    await settingsTable.clear();
  });
});

describe("portable catalogue backup v1", () => {
  it("restores the committed human-readable v1 fixture", () => {
    const preview = validateBackupJson(JSON.stringify(fixture));
    expect(preview.books).toHaveLength(1);
    expect(preview.books[0]).toMatchObject({
      isbn13: "9780140328721",
      title: "Matilda",
      authorKeys: ["roald dahl"],
      favourite: true,
      readingStatus: "read"
    });
  });

  it("rejects future versions and unknown record fields", () => {
    expect(() => validateBackupJson(JSON.stringify({ ...fixture, formatVersion: 2 }))).toThrow(/unsupported future/i);
    const changed = structuredClone(fixture) as typeof fixture & { books: Array<Record<string, unknown>> };
    changed.books[0].unexpected = true;
    expect(() => validateBackupJson(JSON.stringify(changed))).toThrow(/unknown/i);
  });

  it("rejects duplicate UUIDs and canonical ISBNs before mutation", () => {
    const duplicateUuid = structuredClone(fixture);
    duplicateUuid.books.push({ ...duplicateUuid.books[0], isbn13: "9780061120084" });
    expect(() => validateBackupJson(JSON.stringify(duplicateUuid))).toThrow(/duplicates another UUID/i);

    const duplicateIsbn = structuredClone(fixture);
    duplicateIsbn.books.push({ ...duplicateIsbn.books[0], id: "33333333-3333-4333-8333-333333333333" });
    expect(() => validateBackupJson(JSON.stringify(duplicateIsbn))).toThrow(/duplicates another ISBN/i);
  });

  it("omits unapproved imported cover URLs with a warning", () => {
    const changed = structuredClone(fixture);
    changed.books[0].coverUrl = "https://tracking.example/cover.jpg";
    const preview = validateBackupJson(JSON.stringify(changed));
    expect(preview.books[0].coverUrl).toBeUndefined();
    expect(preview.warnings).toHaveLength(1);
  });

  it("round-trips an app-created export", async () => {
    await booksTable.add(oldBook);
    const exported = await createBackup();
    const preview = validateBackupJson(exported.json);
    expect(preview.books).toEqual([oldBook]);
    expect(exported.filename).toMatch(/^book-scanner-backup-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it("atomically replaces books and clears the lookup cache", async () => {
    await booksTable.add(oldBook);
    await lookupCacheTable.add({ isbn13: oldBook.isbn13!, outcome: "not-found", lookedUpAt: oldBook.updatedAt });
    const preview = validateBackupJson(JSON.stringify(fixture));
    await replaceCatalogue(preview);
    expect((await booksTable.toArray()).map((book) => book.title)).toEqual(["Matilda"]);
    expect(await lookupCacheTable.count()).toBe(0);
    expect(await getSetting<string>("last-backup-imported-at")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rolls back the catalogue when recording import status fails", async () => {
    await booksTable.add(oldBook);
    await lookupCacheTable.add({ isbn13: oldBook.isbn13!, outcome: "not-found", lookedUpAt: oldBook.updatedAt });
    const preview = validateBackupJson(JSON.stringify(fixture));
    const failImportStatus = (_key: string, record: { key: string }): void => {
      if (record.key === "last-backup-imported-at") throw new Error("Simulated settings write failure");
    };
    settingsTable.hook("creating", failImportStatus);

    try {
      await expect(replaceCatalogue(preview)).rejects.toThrow(/Simulated settings write failure/);
    } finally {
      settingsTable.hook.creating.unsubscribe(failImportStatus);
    }

    expect(await booksTable.toArray()).toEqual([oldBook]);
    expect(await lookupCacheTable.count()).toBe(1);
    expect(await getSetting("last-backup-imported-at")).toBeUndefined();
  });

  it("rolls back the clear when a replacement transaction aborts", async () => {
    await booksTable.add(oldBook);
    const valid = validateBackupJson(JSON.stringify(fixture));
    const invalidAtCommit: BackupPreview = { ...valid, books: [valid.books[0], { ...valid.books[0] }] };
    await expect(replaceCatalogue(invalidAtCommit)).rejects.toBeTruthy();
    expect(await booksTable.toArray()).toEqual([oldBook]);
  });
});

describe("CSV spreadsheet export", () => {
  it("escapes fields with commas, quotes, and newlines per RFC 4180", () => {
    expect(escapeCsvField(undefined)).toBe("");
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField("")).toBe("");
    expect(escapeCsvField("Simple Title")).toBe("Simple Title");
    expect(escapeCsvField('Book "Special" Edition')).toBe('"Book ""Special"" Edition"');
    expect(escapeCsvField("Title, with comma")).toBe('"Title, with comma"');
    expect(escapeCsvField("Multi\nline\ntext")).toBe('"Multi\nline\ntext"');
    expect(escapeCsvField("Line\r\nbreak")).toBe('"Line\r\nbreak"');
  });

  it("formats books to CSV with UTF-8 BOM, headers, and formatted fields", () => {
    const bookWithQuotesAndCommas: Book = {
      id: "11111111-1111-4111-8111-111111111111",
      isbn13: "9780140328721",
      title: 'Matilda, or "The Bookworm"',
      subtitle: "A Children's Classic",
      authors: ["Roald Dahl", "Quentin Blake"],
      authorKeys: ["roald dahl", "quentin blake"],
      seriesName: "Dahl Collection",
      seriesNumber: "3",
      publisher: "Puffin Books, UK",
      publishedDate: "1988",
      coverUrl: "https://covers.openlibrary.org/b/id/12345-M.jpg",
      favourite: true,
      readingStatus: "read",
      metadataSource: "openlibrary",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    };

    const bookWithoutIsbn: Book = {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Self-Published Diary",
      authors: ["Jane Doe"],
      authorKeys: ["jane doe"],
      favourite: false,
      readingStatus: "reading",
      metadataSource: "manual",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z"
    };

    const csv = booksToCsv([bookWithQuotesAndCommas, bookWithoutIsbn]);

    // Starts with UTF-8 BOM for Excel compatibility
    expect(csv.startsWith("\uFEFF")).toBe(true);

    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines).toHaveLength(3); // Header + 2 books

    // Header matches CSV_COLUMNS
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));

    // First book row
    expect(lines[1]).toContain('"Matilda, or ""The Bookworm"""');
    expect(lines[1]).toContain('"Roald Dahl, Quentin Blake"');
    expect(lines[1]).toContain("9780140328721");
    expect(lines[1]).toContain('"Puffin Books, UK"');
    expect(lines[1]).toContain("read");
    expect(lines[1]).toContain("Yes");

    // Second book row (no ISBN, no series, favourite is No)
    expect(lines[2]).toContain("Self-Published Diary");
    expect(lines[2]).toContain("Jane Doe");
    expect(lines[2]).toContain("reading");
    expect(lines[2]).toContain("No");
  });

  it("exports all books from database sorted alphabetically by title", async () => {
    const bookZ: Book = { ...oldBook, id: "33333333-3333-4333-8333-333333333333", title: "Zebra Crossing", isbn13: "9781111111111" };
    const bookA: Book = { ...oldBook, id: "44444444-4444-4444-8444-444444444444", title: "All About Books", isbn13: "9782222222222" };

    await booksTable.bulkAdd([bookZ, bookA]);

    const result = await createCsvExport();
    expect(result.count).toBe(2);
    expect(result.filename).toMatch(/^book-scanner-collection-\d{4}-\d{2}-\d{2}\.csv$/);

    const lines = result.csv.slice(1).trim().split("\r\n");
    expect(lines[1]).toContain("All About Books");
    expect(lines[2]).toContain("Zebra Crossing");
  });
});
