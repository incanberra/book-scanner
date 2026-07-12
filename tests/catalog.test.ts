import { describe, expect, it } from "vitest";
import {
  canonicaliseDraft,
  filterBooks,
  groupBooks,
  isApprovedCoverUrl,
  normaliseIsbn,
  normaliseKey,
  saveBook,
  type Book,
  type BookDraft
} from "../src/catalog";

const draft: BookDraft = {
  isbn: "0-14-032872-6",
  title: "  Matilda  ",
  authors: [" Roald Dahl "],
  favourite: false,
  readingStatus: "unread",
  metadataSource: "manual"
};

function book(overrides: Partial<Book>): Book {
  return {
    id: crypto.randomUUID(),
    title: "Example",
    authors: ["Author"],
    authorKeys: ["author"],
    favourite: false,
    readingStatus: "unread",
    metadataSource: "manual",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("ISBN normalisation", () => {
  it("converts a valid ISBN-10 to canonical ISBN-13", () => {
    expect(normaliseIsbn("0-14-032872-6")).toBe("9780140328721");
  });

  it("accepts a valid ISBN-13 and rejects invalid checksums", () => {
    expect(normaliseIsbn("9780140328721")).toBe("9780140328721");
    expect(() => normaliseIsbn("9780140328722")).toThrow(/valid ISBN/i);
  });

  it("rejects checksum-valid 9790 music identifiers", () => {
    const stem = "979000000000";
    const sum = [...stem].reduce((total, value, index) => total + Number(value) * (index % 2 ? 3 : 1), 0);
    const ismn = `${stem}${(10 - sum % 10) % 10}`;
    expect(() => normaliseIsbn(ismn)).toThrow(/ISMN/i);
  });
});

describe("canonical book pipeline", () => {
  it("trims fields, derives keys, and enforces the Open Library cover origin", () => {
    const result = canonicaliseDraft({
      ...draft,
      seriesName: "  The Classics  ",
      coverUrl: "https://tracking.example/cover.jpg"
    });
    expect(result).toMatchObject({
      isbn13: "9780140328721",
      title: "Matilda",
      authors: ["Roald Dahl"],
      authorKeys: ["roald dahl"],
      seriesName: "The Classics",
      seriesKey: "the classics",
      coverUrl: undefined
    });
  });

  it("requires a title and author", () => {
    expect(() => canonicaliseDraft({ ...draft, title: "" })).toThrow(/Title is required/);
    expect(() => canonicaliseDraft({ ...draft, authors: [] })).toThrow(/author/i);
  });

  it("normalises punctuation and accents deterministically", () => {
    expect(normaliseKey("  Álvaro—Smith! ")).toBe("alvaro smith");
  });

  it("allows only approved cover URLs", () => {
    expect(isApprovedCoverUrl("https://covers.openlibrary.org/b/id/1-M.jpg")).toBe(true);
    expect(isApprovedCoverUrl("http://covers.openlibrary.org/b/id/1-M.jpg")).toBe(false);
    expect(isApprovedCoverUrl("https://example.com/cover.jpg")).toBe(false);
  });

  it("prevents app-created records from exceeding the portable 12 KiB limit", async () => {
    const long = "x".repeat(500);
    await expect(saveBook({
      ...draft,
      isbn: undefined,
      title: long,
      subtitle: long,
      authors: Array.from({ length: 20 }, (_, index) => `${index}${long.slice(2)}`),
      seriesName: long,
      seriesNumber: long,
      publisher: long,
      publishedDate: long
    })).rejects.toThrow(/12 KiB/i);
  });
});

describe("collection selectors", () => {
  const collaboration = book({
    id: "a",
    title: "Shared Work",
    authors: ["Alice Writer", "Bob Writer"],
    authorKeys: ["alice writer", "bob writer"]
  });
  const sequel = book({
    id: "b",
    title: "Second Work",
    authors: ["Alice Writer"],
    authorKeys: ["alice writer"],
    seriesName: "A Series",
    seriesKey: "a series",
    seriesNumber: "2"
  });

  it("places a multi-author book under each individual author", () => {
    const groups = groupBooks([collaboration, sequel], "author");
    expect(groups.find((group) => group.key === "alice writer")?.books).toHaveLength(2);
    expect(groups.find((group) => group.key === "bob writer")?.books).toEqual([collaboration]);
  });

  it("searches title, author, series, and ISBN text", () => {
    expect(filterBooks([collaboration, sequel], "bob")).toEqual([collaboration]);
    expect(filterBooks([collaboration, sequel], "series")).toEqual([sequel]);
    expect(filterBooks([collaboration, sequel], "missing")).toEqual([]);
  });
});
