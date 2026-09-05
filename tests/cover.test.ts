import { describe, expect, it, vi } from "vitest";
import { cleanCoverText, readCover } from "../src/cover";
import { cancelLookup, searchCoverBooks } from "../src/metadata";
import { lookupCacheTable } from "../src/catalog";

describe("cover fallback", () => {
  it("keeps title and author words while removing common promotional lines", () => {
    expect(cleanCoverText("THE HOBBIT\nJ. R. R. TOLKIEN\nThe bestselling author of...\nA NOVEL"))
      .toBe("THE HOBBIT J R R TOLKIEN");
    expect(cleanCoverText("123\n?!")).toBe("");
  });

  it("rejects invalid photos before loading the reader", async () => {
    await expect(readCover(new File(["text"], "cover.txt", { type: "text/plain" }), new AbortController().signal, vi.fn()))
      .rejects.toThrow("Choose a photo");
  });

  it("requires confirmation even for one work and does not invent edition facts or cache an ISBN", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ docs: [{
      key: "/works/OL1W", title: "The Hobbit", author_name: ["J. R. R. Tolkien"],
      isbn: ["9780140328721"], publisher: ["Unrelated edition"], publish_date: ["2000"]
    }] })));
    const result = await searchCoverBooks({ text: "The Hobbit Tolkien", title: "", author: "" }, fetcher, 0);
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.get("q")).toBe("The Hobbit Tolkien");
    expect(result).toEqual({ kind: "ambiguous", candidates: [{ title: "The Hobbit", authors: ["J. R. R. Tolkien"], isbn13: "", coverUrl: undefined }] });
    expect(await lookupCacheTable.count()).toBe(0);
  });

  it("uses corrected title and author instead of noisy OCR words", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"docs":[]}'));
    expect(await searchCoverBooks({ text: "noisy words", title: "The Hobbit", author: "Tolkien" }, fetcher, 0)).toEqual({ kind: "not-found" });
    const params = new URL(fetcher.mock.calls[0][0]).searchParams;
    expect(params.get("title")).toBe("The Hobbit");
    expect(params.get("author")).toBe("Tolkien");
    expect(params.has("q")).toBe(false);
  });

  it("ignores a search result after cancellation", async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const result = searchCoverBooks({ text: "Matilda", title: "", author: "" }, fetcher, 0);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    cancelLookup();
    complete(new Response('{"docs":[]}'));
    expect(await result).toEqual({ kind: "cancelled" });
  });
});
