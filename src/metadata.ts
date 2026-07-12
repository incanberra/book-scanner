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

export interface SeriesMetadata {
  seriesName: string;
  seriesNumber?: string;
}

export type SeriesLookupResult =
  | ({ kind: "matched" } & SeriesMetadata)
  | { kind: "not-found" }
  | { kind: "offline" }
  | { kind: "failed" };

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
interface OpenLibraryEdition { series?: unknown }

let activeController: AbortController | undefined;
let operationSequence = 0;
let lastRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

const LOOKUP_METADATA_VERSION = 2;
const REQUEST_INTERVAL_MS = 1_000;

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function stringValue(value?: string): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

function cleanSeriesName(value: string): string {
  return value.replace(/[\s,;:–—-]+$/gu, "").trim();
}

export function parseOpenLibrarySeries(value: unknown): SeriesMetadata | undefined {
  const values = Array.isArray(value) ? value : [value];
  const raw = values.find((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate.trim()))?.trim();
  if (!raw) return undefined;

  const patterns = [
    /^(.*?)\s*\(\s*(?:(?:book|bk\.?|volume|vol\.?)\s*)?#?\s*(\d+(?:\.\d+)?[a-z]?)\s*\)$/iu,
    /^(.*?)\s*,?\s*#\s*(\d+(?:\.\d+)?[a-z]?)$/iu,
    /^(.*?)\s*(?:(?:--|[-–—,:])\s*)?(?:book|bk\.?|volume|vol\.?)\s*#?\s*(\d+(?:\.\d+)?[a-z]?)$/iu
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const seriesName = match ? cleanSeriesName(match[1]) : "";
    if (seriesName && match) return { seriesName, seriesNumber: match[2] };
  }
  return { seriesName: raw };
}

function waitForRequestSlot(requestIntervalMs: number): Promise<void> {
  const reservation = requestQueue.then(async () => {
    const delay = Math.max(0, requestIntervalMs - (Date.now() - lastRequestAt));
    if (delay) await wait(delay);
    lastRequestAt = Date.now();
  });
  requestQueue = reservation.catch(() => undefined);
  return reservation;
}

async function requestEditionSeries(
  isbn13: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
  requestIntervalMs: number
): Promise<SeriesLookupResult> {
  await waitForRequestSlot(requestIntervalMs);
  const response = await fetcher(`https://openlibrary.org/isbn/${encodeURIComponent(isbn13)}.json`, {
    signal,
    headers: { Accept: "application/json" }
  });
  if (response.status === 404) return { kind: "not-found" };
  if (!response.ok) return { kind: "failed" };
  const series = parseOpenLibrarySeries((await response.json() as OpenLibraryEdition).series);
  return series ? { kind: "matched", ...series } : { kind: "not-found" };
}

function addSeries(result: LookupResult, series: SeriesLookupResult): LookupResult {
  if (series.kind !== "matched") return result;
  const fields = { seriesName: series.seriesName, seriesNumber: series.seriesNumber };
  if (result.kind === "matched") return { ...result, candidate: { ...result.candidate, ...fields } };
  if (result.kind === "ambiguous") return {
    ...result,
    candidates: result.candidates.map((candidate) => ({ ...candidate, ...fields }))
  };
  return result;
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
  if (cached.metadataVersion !== LOOKUP_METADATA_VERSION) {
    await lookupCacheTable.delete(isbn13);
    return undefined;
  }
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
    metadataVersion: LOOKUP_METADATA_VERSION,
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

export async function lookupSeriesByIsbn(
  isbnInput: string,
  fetcher: typeof fetch = fetch,
  requestIntervalMs = REQUEST_INTERVAL_MS
): Promise<SeriesLookupResult> {
  const isbn13 = normaliseIsbn(isbnInput);
  if (!isbn13) return { kind: "not-found" };
  if (!navigator.onLine) return { kind: "offline" };

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    return await requestEditionSeries(isbn13, fetcher, controller.signal, requestIntervalMs);
  } catch {
    return navigator.onLine ? { kind: "failed" } : { kind: "offline" };
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function lookupBook(
  isbnInput: string,
  fetcher: typeof fetch = fetch,
  requestIntervalMs = REQUEST_INTERVAL_MS
): Promise<LookupResult> {
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

  await waitForRequestSlot(requestIntervalMs);
  if (operationId !== operationSequence) return { kind: "cancelled" };

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
    let result = classifyOpenLibraryResponse(await response.json() as OpenLibraryResponse, isbn13);
    let cacheable = true;
    if (operationId !== operationSequence) return { kind: "cancelled" };
    if (result.kind === "matched" || result.kind === "ambiguous") {
      try {
        const seriesResult = await requestEditionSeries(isbn13, fetcher, controller.signal, requestIntervalMs);
        result = addSeries(result, seriesResult);
        cacheable = seriesResult.kind === "matched" || seriesResult.kind === "not-found";
      } catch {
        // Series enrichment is best-effort; the exact-edition lookup must not discard valid book details.
        cacheable = false;
      }
      if (operationId !== operationSequence) return { kind: "cancelled" };
    }
    if (cacheable) await writeCache(isbn13, result);
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
