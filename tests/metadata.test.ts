import { describe, expect, it, vi } from "vitest";
import { lookupCacheTable } from "../src/catalog";
import { cancelLookup, classifyOpenLibraryResponse, lookupBook } from "../src/metadata";

const isbn = "9780140328721";

describe("Open Library result classification", () => {
  it("returns not-found when no exact ISBN candidate exists", () => {
    expect(classifyOpenLibraryResponse({ docs: [{ title: "Wrong edition", isbn: ["9780000000002"] }] }, isbn)).toEqual({ kind: "not-found" });
  });

  it("returns a single normalized exact candidate", () => {
    const result = classifyOpenLibraryResponse({
      docs: [{
        key: "/works/OL1W",
        edition_key: ["OL1M"],
        title: "Matilda",
        author_name: ["Roald Dahl"],
        publisher: ["Puffin"],
        publish_date: ["1988"],
        isbn: [isbn],
        cover_i: 123
      }]
    }, isbn);
    expect(result).toEqual({
      kind: "matched",
      candidate: expect.objectContaining({
        editionKey: "OL1M",
        isbn13: isbn,
        title: "Matilda",
        authors: ["Roald Dahl"],
        coverUrl: "https://covers.openlibrary.org/b/id/123-M.jpg"
      })
    });
  });

  it("deduplicates edition keys and reports genuinely ambiguous candidates", () => {
    const docs = [
      { edition_key: ["OL1M"], title: "Edition one", author_name: ["Author"], isbn: [isbn] },
      { edition_key: ["OL1M"], title: "Edition one duplicate", author_name: ["Author"], isbn: [isbn] },
      { edition_key: ["OL2M"], title: "Edition two", author_name: ["Author"], isbn: [isbn] }
    ];
    const result = classifyOpenLibraryResponse({ docs }, isbn);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.candidates).toHaveLength(2);
  });

  it("makes an obsolete in-flight lookup harmless when it is cancelled", async () => {
    await lookupCacheTable.clear();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const pending = lookupBook(isbn, fetcher as typeof fetch);
    await Promise.resolve();
    cancelLookup();
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
  });
});
