import { beforeEach, describe, expect, it } from "vitest";
import fixture from "./fixtures/catalogue-v1.json";
import {
  createBackup,
  replaceCatalogue,
  validateBackupJson,
  type BackupPreview
} from "../src/backup";
import { bookDatabase, booksTable, lookupCacheTable, type Book } from "../src/catalog";

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
  await bookDatabase.transaction("rw", booksTable, lookupCacheTable, async () => {
    await booksTable.clear();
    await lookupCacheTable.clear();
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
  });

  it("rolls back the clear when a replacement transaction aborts", async () => {
    await booksTable.add(oldBook);
    const valid = validateBackupJson(JSON.stringify(fixture));
    const invalidAtCommit: BackupPreview = { ...valid, books: [valid.books[0], { ...valid.books[0] }] };
    await expect(replaceCatalogue(invalidAtCommit)).rejects.toBeTruthy();
    expect(await booksTable.toArray()).toEqual([oldBook]);
  });
});
