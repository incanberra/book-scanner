import { describe, expect, it } from "vitest";
import { collectionContent, selectCollection, PAGE_SIZE, type CollectionOptions } from "../src/collection";
import { filterBooks, groupBooks, type Book } from "../src/catalog";

const options: CollectionOptions = { query: "", order: "title", status: "all", favouritesOnly: false, visibleCount: PAGE_SIZE };
function book(id: string, overrides: Partial<Book> = {}): Book {
  return {
    id, title: `Book ${id}`, authors: ["Author"], authorKeys: ["author"], favourite: false,
    readingStatus: "unread", metadataSource: "manual", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", ...overrides
  };
}

describe("collection browsing", () => {
  it("combines reading and favourite filters with unordered search words", () => {
    const target = book("1", { title: "L’Étranger", authors: ["Albert Camus"], readingStatus: "read", favourite: true });
    const books = [target, book("2", { title: "L’Étranger", authors: ["Albert Camus"] })];
    expect(selectCollection(books, { ...options, query: "camus etranger", status: "read", favouritesOnly: true }).filtered).toEqual([target]);
  });

  it("finds ISBN-10, formatted ISBN-13 and partial barcode searches", () => {
    const target = book("1", { isbn13: "9780140328721" });
    for (const query of ["0-14-032872-6", "978-0-14-032872-1", "014032"]) {
      expect(filterBooks([target], query)).toEqual([target]);
    }
  });

  it("searches a replacement snapshot after a title edit", () => {
    const original = book("1", { title: "Old title" });
    expect(filterBooks([original], "old")).toHaveLength(1);
    const updated = { ...original, title: "New title" };
    expect(filterBooks([updated], "old")).toEqual([]);
    expect(filterBooks([updated], "new")).toEqual([updated]);
  });

  it("orders recently added books by creation, not last edit, without mutating input", () => {
    const older = book("1", { updatedAt: "2026-10-20T00:00:00.000Z" });
    const newer = book("2", { createdAt: "2026-10-01T00:00:00.000Z" });
    const books = [older, newer];
    expect(selectCollection(books, { ...options, order: "recent" }).groups[0].books).toEqual([newer, older]);
    expect(books).toEqual([older, newer]);
  });

  it("bounds rendering even for co-authored books and reveals the remaining rows", () => {
    const books = Array.from({ length: 100 }, (_, i) => book(String(i), { authors: ["Alice", "Bob"], authorKeys: ["alice", "bob"] }));
    const first = selectCollection(books, { ...options, order: "author" });
    expect(first.filtered).toHaveLength(100);
    expect(first.totalRows).toBe(200);
    expect(first.shownRows).toBe(PAGE_SIZE);
    expect(selectCollection(books, { ...options, order: "author", visibleCount: 240 }).shownRows).toBe(200);
  });

  it("does not duplicate a book with repeated author aliases in the same group", () => {
    const target = book("1", { authors: ["Alice", "ALICE"], authorKeys: ["alice", "alice"] });
    expect(groupBooks([target], "author")[0].books).toEqual([target]);
  });

  it("escapes imported names and ids in collection markup", () => {
    const markup = collectionContent([book('" onclick="alert(1)', { title: "<script>bad()</script>" })], options);
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain('data-book="" onclick=');
    expect(markup).toContain("&lt;script&gt;");
  });
});
