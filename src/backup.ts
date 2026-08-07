import {
  bookDatabase,
  booksTable,
  canonicaliseDraft,
  isApprovedCoverUrl,
  lookupCacheTable,
  normaliseIsbn,
  setSetting,
  type Book,
  type BookDraft,
  type ReadingStatus,
  ValidationError
} from "./catalog";

export const BACKUP_FORMAT_NAME = "book-scanner-catalogue";
export const BACKUP_FORMAT_VERSION = 1;
export const APP_VERSION = "0.1.0";
export const MAX_BACKUP_BYTES = 32 * 1_024 * 1_024;
const MAX_RECORD_BYTES = 12 * 1_024;
const MAX_BOOKS = 2_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const textEncoder = new TextEncoder();

export interface PortableBookV1 {
  id: string;
  isbn13?: string;
  title: string;
  subtitle?: string;
  authors: string[];
  seriesName?: string;
  seriesNumber?: string;
  publisher?: string;
  publishedDate?: string;
  coverUrl?: string;
  favourite: boolean;
  readingStatus: ReadingStatus;
  metadataSource: "openlibrary" | "manual";
  metadataFetchedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogueBackupV1 {
  formatName: typeof BACKUP_FORMAT_NAME;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  appVersion: string;
  exportedAt: string;
  books: PortableBookV1[];
}

export interface BackupPreview {
  envelope: CatalogueBackupV1;
  books: Book[];
  warnings: string[];
  isbnlessCount: number;
}

const ENVELOPE_KEYS = new Set(["formatName", "formatVersion", "appVersion", "exportedAt", "books"]);
const REQUIRED_BOOK_KEYS = new Set([
  "id", "title", "authors", "favourite", "readingStatus", "metadataSource", "createdAt", "updatedAt"
]);
const OPTIONAL_BOOK_KEYS = new Set([
  "isbn13", "subtitle", "seriesName", "seriesNumber", "publisher", "publishedDate", "coverUrl", "metadataFetchedAt"
]);
const ALL_BOOK_KEYS = new Set([...REQUIRED_BOOK_KEYS, ...OPTIONAL_BOOK_KEYS]);
const READING_STATUSES = new Set<ReadingStatus>(["unread", "reading", "read", "abandoned"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(record: Record<string, unknown>, allowed: Set<string>, required: Set<string>, label: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new ValidationError(`${label} contains an unknown “${unknown}” field.`);
  const missing = [...required].find((key) => !(key in record));
  if (missing) throw new ValidationError(`${label} is missing the required “${missing}” field.`);
}

function requireString(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string") throw new ValidationError(`${label} must be text.`);
  const cleaned = value.trim();
  if (!cleaned) throw new ValidationError(`${label} cannot be empty.`);
  if ([...cleaned].length > maximum) throw new ValidationError(`${label} is too long.`);
  return cleaned;
}

function optionalString(record: Record<string, unknown>, key: string, maximum = 500): string | undefined {
  if (!(key in record)) return undefined;
  if (record[key] === null) throw new ValidationError(`${key} must be omitted rather than null.`);
  return requireString(record[key], key, maximum);
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label, 50);
  if (!UTC_TIMESTAMP.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new ValidationError(`${label} must be a UTC RFC 3339 timestamp.`);
  }
  return timestamp;
}

function toPortableBook(book: Book): PortableBookV1 {
  return {
    id: book.id,
    ...(book.isbn13 ? { isbn13: book.isbn13 } : {}),
    title: book.title,
    ...(book.subtitle ? { subtitle: book.subtitle } : {}),
    authors: [...book.authors],
    ...(book.seriesName ? { seriesName: book.seriesName } : {}),
    ...(book.seriesNumber ? { seriesNumber: book.seriesNumber } : {}),
    ...(book.publisher ? { publisher: book.publisher } : {}),
    ...(book.publishedDate ? { publishedDate: book.publishedDate } : {}),
    ...(book.coverUrl && isApprovedCoverUrl(book.coverUrl) ? { coverUrl: book.coverUrl } : {}),
    favourite: book.favourite,
    readingStatus: book.readingStatus,
    metadataSource: book.metadataSource,
    ...(book.metadataFetchedAt ? { metadataFetchedAt: book.metadataFetchedAt } : {}),
    createdAt: book.createdAt,
    updatedAt: book.updatedAt
  };
}

export async function createBackup(): Promise<{ envelope: CatalogueBackupV1; json: string; filename: string }> {
  const books = (await booksTable.toArray()).sort((left, right) => left.id.localeCompare(right.id)).map(toPortableBook);
  books.forEach((book, index) => {
    if (textEncoder.encode(JSON.stringify(book)).byteLength > MAX_RECORD_BYTES) {
      throw new ValidationError(`Book ${index + 1} exceeds the 12 KiB portable-record limit.`);
    }
  });
  const envelope: CatalogueBackupV1 = {
    formatName: BACKUP_FORMAT_NAME,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    books
  };
  const json = `${JSON.stringify(envelope, null, 2)}\n`;
  if (textEncoder.encode(json).byteLength > MAX_BACKUP_BYTES) {
    throw new ValidationError("The catalogue is too large for the portable backup format.");
  }
  await setSetting("last-backup-prepared-at", envelope.exportedAt);
  return {
    envelope,
    json,
    filename: `book-scanner-backup-${envelope.exportedAt.slice(0, 10)}.json`
  };
}

export function downloadJson(json: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function validatePortableBook(value: unknown, index: number, warnings: string[]): Book {
  if (!isRecord(value)) throw new ValidationError(`Book ${index + 1} must be an object.`);
  assertExactKeys(value, ALL_BOOK_KEYS, REQUIRED_BOOK_KEYS, `Book ${index + 1}`);
  if (textEncoder.encode(JSON.stringify(value)).byteLength > MAX_RECORD_BYTES) {
    throw new ValidationError(`Book ${index + 1} exceeds the 12 KiB record limit.`);
  }

  const id = requireString(value.id, `Book ${index + 1} id`, 36);
  if (!UUID_V4.test(id)) throw new ValidationError(`Book ${index + 1} has an invalid UUID-v4 id.`);
  if (!Array.isArray(value.authors) || !value.authors.length || value.authors.length > 20) {
    throw new ValidationError(`Book ${index + 1} must have between 1 and 20 authors.`);
  }
  const authors = value.authors.map((author, authorIndex) => requireString(author, `Book ${index + 1} author ${authorIndex + 1}`));
  if (typeof value.favourite !== "boolean") throw new ValidationError(`Book ${index + 1} favourite must be true or false.`);
  if (typeof value.readingStatus !== "string" || !READING_STATUSES.has(value.readingStatus as ReadingStatus)) {
    throw new ValidationError(`Book ${index + 1} has an invalid reading status.`);
  }
  if (value.metadataSource !== "openlibrary" && value.metadataSource !== "manual") {
    throw new ValidationError(`Book ${index + 1} has an invalid metadata source.`);
  }

  let isbn13: string | undefined;
  if ("isbn13" in value) {
    const rawIsbn = requireString(value.isbn13, `Book ${index + 1} ISBN`, 13);
    isbn13 = normaliseIsbn(rawIsbn);
    if (isbn13 !== rawIsbn) throw new ValidationError(`Book ${index + 1} ISBN is not canonical ISBN-13.`);
  }

  const importedCover = optionalString(value, "coverUrl", 2_000);
  const coverUrl = importedCover && isApprovedCoverUrl(importedCover) ? importedCover : undefined;
  if (importedCover && !coverUrl) warnings.push(`Book ${index + 1} used an unapproved cover URL; the cover was omitted.`);

  const metadataFetchedAt = "metadataFetchedAt" in value
    ? requireTimestamp(value.metadataFetchedAt, `Book ${index + 1} metadataFetchedAt`)
    : undefined;
  const createdAt = requireTimestamp(value.createdAt, `Book ${index + 1} createdAt`);
  const updatedAt = requireTimestamp(value.updatedAt, `Book ${index + 1} updatedAt`);

  const draft: BookDraft = {
    id,
    isbn: isbn13,
    title: requireString(value.title, `Book ${index + 1} title`),
    subtitle: optionalString(value, "subtitle"),
    authors,
    seriesName: optionalString(value, "seriesName"),
    seriesNumber: optionalString(value, "seriesNumber"),
    publisher: optionalString(value, "publisher"),
    publishedDate: optionalString(value, "publishedDate"),
    coverUrl,
    favourite: value.favourite,
    readingStatus: value.readingStatus as ReadingStatus,
    metadataSource: value.metadataSource,
    metadataFetchedAt
  };
  const canonical = canonicaliseDraft(draft);
  return { ...canonical, id, createdAt, updatedAt };
}

export function validateBackupJson(json: string): BackupPreview {
  if (textEncoder.encode(json).byteLength > MAX_BACKUP_BYTES) throw new ValidationError("The backup file exceeds 32 MiB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ValidationError("The selected file is not valid JSON.");
  }
  if (!isRecord(parsed)) throw new ValidationError("The backup envelope must be an object.");
  assertExactKeys(parsed, ENVELOPE_KEYS, ENVELOPE_KEYS, "Backup");
  if (parsed.formatName !== BACKUP_FORMAT_NAME) throw new ValidationError("This is not a Book Scanner catalogue backup.");
  if (parsed.formatVersion !== BACKUP_FORMAT_VERSION) throw new ValidationError("This backup uses an unsupported future or unknown format version.");
  const appVersion = requireString(parsed.appVersion, "appVersion", 100);
  const exportedAt = requireTimestamp(parsed.exportedAt, "exportedAt");
  if (!Array.isArray(parsed.books)) throw new ValidationError("The backup books field must be an array.");
  if (parsed.books.length > MAX_BOOKS) throw new ValidationError(`The backup contains more than ${MAX_BOOKS} books.`);

  const warnings: string[] = [];
  const books = parsed.books.map((value, index) => validatePortableBook(value, index, warnings));
  const ids = new Set<string>();
  const isbns = new Set<string>();
  books.forEach((book, index) => {
    if (ids.has(book.id)) throw new ValidationError(`Book ${index + 1} duplicates another UUID.`);
    ids.add(book.id);
    if (book.isbn13) {
      if (isbns.has(book.isbn13)) throw new ValidationError(`Book ${index + 1} duplicates another ISBN.`);
      isbns.add(book.isbn13);
    }
  });

  const envelope: CatalogueBackupV1 = {
    formatName: BACKUP_FORMAT_NAME,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion,
    exportedAt,
    books: parsed.books as PortableBookV1[]
  };
  return { envelope, books, warnings, isbnlessCount: books.filter((book) => !book.isbn13).length };
}

export async function validateBackupFile(file: File): Promise<BackupPreview> {
  if (file.size > MAX_BACKUP_BYTES) throw new ValidationError("The backup file exceeds 32 MiB.");
  if (!file.name.toLocaleLowerCase("en-AU").endsWith(".json") && file.type !== "application/json") {
    throw new ValidationError("Choose a .json Book Scanner backup file.");
  }
  return validateBackupJson(await file.text());
}

export async function replaceCatalogue(preview: BackupPreview): Promise<void> {
  const settingsTable = bookDatabase.table("settings");
  await bookDatabase.transaction("rw", booksTable, lookupCacheTable, settingsTable, async () => {
    await booksTable.clear();
    await booksTable.bulkAdd(preview.books);
    await lookupCacheTable.clear();
    await setSetting("last-backup-imported-at", new Date().toISOString());
  });
}
