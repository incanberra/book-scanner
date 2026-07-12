import {
  lookupCacheTable,
  type LookupCacheRecord,
  type MetadataCandidate,
  normaliseIsbn
} from "./catalog";

type LookupResult =
  | { kind: "matched"; candidate: MetadataCandidate }
  | { kind: "ambiguous"; candidates: MetadataCandidate[] }
  | { kind: "not-found" }
  | { kind: "offline" }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

interface OpenLibraryDocument {
  key?: string;
  edition_key?: string[];
  title?: string;
  subtitle?: string;
  author_name?: string[];
  publisher?: string[];
  publish_date?: string[];
  first_publish_year?: number;
  isbn?: string[];
  cover_i?: number;
}

interface OpenLibraryResponse { docs?: OpenLibraryDocument[] }

let activeController: AbortController | undefined;
let operationSequence = 0;
let lastRequestAt = 0;

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function stringValue(value?: string): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

export function classifyOpenLibraryResponse(payload: OpenLibraryResponse, requestedIsbn: string): LookupResult {
  const candidates = (payload.docs ?? [])
    .filter((document) => document.isbn?.some((value) => {
      try { return normaliseIsbn(value) === requestedIsbn; } catch { return false; }
    }))
    .filter((document) => Boolean(stringValue(document.title)))
    .map<MetadataCandidate>((document) => ({
      editionKey: document.edition_key?.[0] ?? document.key,
      isbn13: requestedIsbn,
      title: document.title!.trim(),
      subtitle: stringValue(document.subtitle),
      authors: (document.author_name ?? []).map((author) => author.trim()).filter(Boolean),
      publisher: stringValue(document.publisher?.[0]),
      publishedDate: stringValue(document.publish_date?.[0]) ?? (document.first_publish_year ? String(document.first_publish_year) : undefined),
      coverUrl: document.cover_i ? `https://covers.openlibrary.org/b/id/${document.cover_i}-M.jpg` : undefined
    }));

  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    const key = candidate.editionKey ?? [
      candidate.isbn13,
      candidate.title.toLocaleLowerCase("en-AU"),
      candidate.publisher?.toLocaleLowerCase("en-AU"),
      candidate.publishedDate
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!unique.length) return { kind: "not-found" };
  if (unique.length === 1) return { kind: "matched", candidate: unique[0] };
  return { kind: "ambiguous", candidates: unique.slice(0, 3) };
}

async function readCache(isbn13: string): Promise<LookupResult | undefined> {
  const cached = await lookupCacheTable.get(isbn13);
  if (!cached) return undefined;
  if (cached.expiresAt && Date.parse(cached.expiresAt) <= Date.now()) {
    await lookupCacheTable.delete(isbn13);
    return undefined;
  }
  if (cached.outcome === "matched" && cached.candidate) return { kind: "matched", candidate: cached.candidate };
  if (cached.outcome === "not-found") return { kind: "not-found" };
  return undefined;
}

async function writeCache(isbn13: string, result: LookupResult): Promise<void> {
  if (result.kind !== "matched" && result.kind !== "not-found") return;
  const record: LookupCacheRecord = {
    isbn13,
    outcome: result.kind,
    candidate: result.kind === "matched" ? result.candidate : undefined,
    lookedUpAt: new Date().toISOString(),
    expiresAt: result.kind === "not-found"
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString()
      : undefined
  };
  await lookupCacheTable.put(record);
}

export function cancelLookup(): void {
  operationSequence += 1;
  activeController?.abort();
  activeController = undefined;
}

export async function lookupBook(isbnInput: string, fetcher: typeof fetch = fetch): Promise<LookupResult> {
  const isbn13 = normaliseIsbn(isbnInput);
  if (!isbn13) return { kind: "not-found" };

  const operationId = ++operationSequence;
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;

  const cached = await readCache(isbn13);
  if (operationId !== operationSequence) return { kind: "cancelled" };
  if (cached) {
    if (activeController === controller) activeController = undefined;
    return cached;
  }
  if (!navigator.onLine) {
    if (activeController === controller) activeController = undefined;
    return { kind: "offline" };
  }

  const delay = Math.max(0, 1_000 - (Date.now() - lastRequestAt));
  if (delay) await wait(delay);
  if (operationId !== operationSequence) return { kind: "cancelled" };
  lastRequestAt = Date.now();

  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 8_000);

  try {
    const fields = "key,edition_key,title,subtitle,author_name,publisher,publish_date,first_publish_year,isbn,cover_i";
    const url = `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn13)}&fields=${encodeURIComponent(fields)}&limit=10`;
    const response = await fetcher(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (operationId !== operationSequence) return { kind: "cancelled" };
    if (response.status === 429) return { kind: "failed", message: "Open Library is busy. Wait a moment, retry, or enter the details manually." };
    if (!response.ok) return { kind: "failed", message: "Book lookup failed. Retry or enter the details manually." };
    const result = classifyOpenLibraryResponse(await response.json() as OpenLibraryResponse, isbn13);
    if (operationId !== operationSequence) return { kind: "cancelled" };
    await writeCache(isbn13, result);
    return result;
  } catch (error) {
    if (operationId !== operationSequence) return { kind: "cancelled" };
    if (timedOut) return { kind: "failed", message: "Book lookup timed out. Retry or enter the details manually." };
    if (error instanceof DOMException && error.name === "AbortError") return { kind: "cancelled" };
    return { kind: "failed", message: "You appear to be offline. Enter the details manually or retry later." };
  } finally {
    window.clearTimeout(timeout);
    if (activeController === controller) activeController = undefined;
  }
}
