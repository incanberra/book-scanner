import { describe, expect, it, vi } from "vitest";
import { lookupCacheTable } from "../src/catalog";
import {
  cancelLookup,
  classifyOpenLibraryResponse,
  lookupBook,
  parseOpenLibrarySeries
} from "../src/metadata";

const isbn = "9780140328721";

describe("Open Library result classification", () => {
  it.each([
    ["Harry Potter, #1", { seriesName: "Harry Potter", seriesNumber: "1" }],
    ["Percy Jackson and the Olympians #1", { seriesName: "Percy Jackson and the Olympians", seriesNumber: "1" }],
    ["Wheel of Time (1)", { seriesName: "Wheel of Time", seriesNumber: "1" }],
    ["Dune chronicles -- bk. 1", { seriesName: "Dune chronicles", seriesNumber: "1" }],
    ["The expanse -- volume 2", { seriesName: "The expanse", seriesNumber: "2" }],
    ["A Court of Thorns and Roses", { seriesName: "A Court of Thorns and Roses" }]
  ])("normalizes Open Library series value %s", (value, expected) => {
    expect(parseOpenLibrarySeries([value])).toEqual(expected);
  });

  it("returns no series for empty or malformed edition data", () => {
    expect(parseOpenLibrarySeries([])).toBeUndefined();
    expect(parseOpenLibrarySeries([null, 12])).toBeUndefined();
  });

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

  it("enriches an exact ISBN match from the edition series record", async () => {
    await lookupCacheTable.clear();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(JSON.stringify(url.includes("search.json")
        ? { docs: [{ edition_key: ["OL1M"], title: "Series book", author_name: ["Author"], isbn: [isbn] }] }
        : { series: ["Example Saga, #3"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const result = await lookupBook(isbn, fetcher as typeof fetch, 0);

    expect(result).toEqual({
      kind: "matched",
      candidate: expect.objectContaining({ seriesName: "Example Saga", seriesNumber: "3" })
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1][0])).toBe(`https://openlibrary.org/isbn/${isbn}.json`);
  });

  it("does not permanently cache a book when series enrichment fails", async () => {
    await lookupCacheTable.clear();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("search.json")) {
        return new Response(JSON.stringify({
          docs: [{ edition_key: ["OL1M"], title: "Series book", author_name: ["Author"], isbn: [isbn] }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("unavailable", { status: 503 });
    });

    await lookupBook(isbn, fetcher as typeof fetch, 0);
    await lookupBook(isbn, fetcher as typeof fetch, 0);

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(await lookupCacheTable.get(isbn)).toBeUndefined();
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
