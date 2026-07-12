import Dexie, { liveQuery, type Table } from "dexie";

export type ReadingStatus = "unread" | "reading" | "read" | "abandoned";

export interface Book {
  id: string;
  isbn13?: string;
  title: string;
  subtitle?: string;
  authors: string[];
  authorKeys: string[];
  seriesName?: string;
  seriesKey?: string;
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

export interface BookDraft {
  id?: string;
  isbn?: string;
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
}

export interface MetadataCandidate {
  editionKey?: string;
  isbn13: string;
  title: string;
  subtitle?: string;
  authors: string[];
  publisher?: string;
  publishedDate?: string;
  coverUrl?: string;
}

export interface LookupCacheRecord {
  isbn13: string;
  outcome: "matched" | "not-found";
  candidate?: MetadataCandidate;
  lookedUpAt: string;
  expiresAt?: string;
}

interface SettingRecord {
  key: string;
  value: unknown;
}

export const bookDatabase = new Dexie("book-scanner");
bookDatabase.version(1).stores({
  books: "id,&isbn13,*authorKeys,seriesKey,readingStatus,favourite,updatedAt",
  lookupCache: "isbn13,outcome,expiresAt",
  settings: "key"
});

export const booksTable = bookDatabase.table<Book, string>("books");
export const lookupCacheTable = bookDatabase.table<LookupCacheRecord, string>("lookupCache");
const settingsTable: Table<SettingRecord, string> = bookDatabase.table("settings");

bookDatabase.on("versionchange", () => {
  window.dispatchEvent(new CustomEvent("bookscanner:database-updated"));
  bookDatabase.close();
});
bookDatabase.on("blocked", () => {
  window.dispatchEvent(new CustomEvent("bookscanner:database-blocked"));
});

const collator = new Intl.Collator("en-AU", { sensitivity: "base", numeric: false });
const MAX_BOOKS = 2_000;
const MAX_AUTHORS = 20;
const MAX_FIELD_LENGTH = 500;
const MAX_PORTABLE_RECORD_BYTES = 12 * 1_024;
const COVER_ORIGIN = "https://covers.openlibrary.org";

export class ValidationError extends Error {
  readonly field?: keyof BookDraft;

  constructor(message: string, field?: keyof BookDraft) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

export class DuplicateBookError extends Error {
  readonly existingId: string;

  constructor(existingId: string) {
    super("A book with this ISBN is already in your collection.");
    this.name = "DuplicateBookError";
    this.existingId = existingId;
  }
}

function cleanOptional(value?: string): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function assertLength(value: string | undefined, label: string): void {
  if (value && [...value].length > MAX_FIELD_LENGTH) {
    throw new ValidationError(`${label} must be ${MAX_FIELD_LENGTH} characters or fewer.`);
  }
}

export function normaliseKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-AU")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactIsbn(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "");
}

function isValidIsbn10(value: string): boolean {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  const total = [...value].reduce((sum, character, index) => {
    const digit = character === "X" ? 10 : Number(character);
    return sum + digit * (10 - index);
  }, 0);
  return total % 11 === 0;
}

function isValidIsbn13(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  const total = [...value].slice(0, 12).reduce(
    (sum, character, index) => sum + Number(character) * (index % 2 === 0 ? 1 : 3),
    0
  );
  return (10 - (total % 10)) % 10 === Number(value[12]);
}

function isbn10To13(value: string): string {
  const stem = `978${value.slice(0, 9)}`;
  const total = [...stem].reduce(
    (sum, character, index) => sum + Number(character) * (index % 2 === 0 ? 1 : 3),
    0
  );
  return `${stem}${(10 - (total % 10)) % 10}`;
}

export function normaliseIsbn(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  const compact = compactIsbn(value);
  const isbn13 = compact.length === 10 && isValidIsbn10(compact)
    ? isbn10To13(compact)
    : compact;
  if (!isValidIsbn13(isbn13)) {
    throw new ValidationError("Enter a valid ISBN-10 or ISBN-13.", "isbn");
  }
  if (isbn13.startsWith("9790")) {
    throw new ValidationError("This is an ISMN music identifier, not a book ISBN.", "isbn");
  }
  if (!isbn13.startsWith("978") && !isbn13.startsWith("979")) {
    throw new ValidationError("This barcode is not in an ISBN book range.", "isbn");
  }
  return isbn13;
}

export function isApprovedCoverUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === COVER_ORIGIN;
  } catch {
    return false;
  }
}

export function canonicaliseDraft(input: BookDraft): Omit<Book, "id" | "createdAt" | "updatedAt"> {
  const title = input.title.trim();
  if (!title) throw new ValidationError("Title is required.", "title");
  assertLength(title, "Title");

  const authors = input.authors.map((author) => author.trim()).filter(Boolean);
  if (!authors.length) throw new ValidationError("Add an author or use “Unknown author”.", "authors");
  if (authors.length > MAX_AUTHORS) throw new ValidationError(`Use no more than ${MAX_AUTHORS} authors.`, "authors");
  authors.forEach((author) => assertLength(author, "Each author"));

  const optionalFields = {
    subtitle: cleanOptional(input.subtitle),
    seriesName: cleanOptional(input.seriesName),
    seriesNumber: cleanOptional(input.seriesNumber),
    publisher: cleanOptional(input.publisher),
    publishedDate: cleanOptional(input.publishedDate)
  };
  Object.entries(optionalFields).forEach(([name, value]) => assertLength(value, name));

  const coverUrl = isApprovedCoverUrl(input.coverUrl) ? input.coverUrl : undefined;
  const isbn13 = normaliseIsbn(input.isbn);
  const authorKeys = authors.map(normaliseKey);
  const seriesKey = optionalFields.seriesName ? normaliseKey(optionalFields.seriesName) : undefined;

  return {
    isbn13,
    title,
    ...optionalFields,
    authors,
    authorKeys,
    seriesKey,
    coverUrl,
    favourite: Boolean(input.favourite),
    readingStatus: input.readingStatus,
    metadataSource: input.metadataSource,
    metadataFetchedAt: cleanOptional(input.metadataFetchedAt)
  };
}

export async function saveBook(input: BookDraft): Promise<Book> {
  const canonical = canonicaliseDraft(input);
  const existing = canonical.isbn13
    ? await booksTable.where("isbn13").equals(canonical.isbn13).first()
    : undefined;
  if (existing && existing.id !== input.id) throw new DuplicateBookError(existing.id);

  const current = input.id ? await booksTable.get(input.id) : undefined;
  if (!current && await booksTable.count() >= MAX_BOOKS) {
    throw new ValidationError(`The catalogue limit is ${MAX_BOOKS} books.`);
  }

  const now = new Date().toISOString();
  const book: Book = {
    ...canonical,
    id: current?.id ?? crypto.randomUUID(),
    createdAt: current?.createdAt ?? now,
    updatedAt: now
  };
  const { authorKeys: _authorKeys, seriesKey: _seriesKey, ...portableFields } = book;
  if (new TextEncoder().encode(JSON.stringify(portableFields)).byteLength > MAX_PORTABLE_RECORD_BYTES) {
    throw new ValidationError("This book’s details exceed the 12 KiB portable-record limit.");
  }
  await booksTable.put(book);
  return book;
}

export async function removeBook(id: string): Promise<Book | undefined> {
  const existing = await booksTable.get(id);
  if (existing) await booksTable.delete(id);
  return existing;
}

export async function restoreBook(book: Book): Promise<void> {
  await booksTable.put(book);
}

export function observeBooks(onChange: (books: Book[]) => void): () => void {
  const subscription = liveQuery(() => booksTable.toArray()).subscribe({
    next: onChange,
    error: (error) => console.error("Book catalogue observation failed", error)
  });
  return () => subscription.unsubscribe();
}

export function bookToDraft(book: Book): BookDraft {
  return {
    id: book.id,
    isbn: book.isbn13,
    title: book.title,
    subtitle: book.subtitle,
    authors: [...book.authors],
    seriesName: book.seriesName,
    seriesNumber: book.seriesNumber,
    publisher: book.publisher,
    publishedDate: book.publishedDate,
    coverUrl: book.coverUrl,
    favourite: book.favourite,
    readingStatus: book.readingStatus,
    metadataSource: book.metadataSource,
    metadataFetchedAt: book.metadataFetchedAt
  };
}

export function candidateToDraft(candidate: MetadataCandidate): BookDraft {
  return {
    isbn: candidate.isbn13,
    title: candidate.title,
    subtitle: candidate.subtitle,
    authors: candidate.authors.length ? candidate.authors : ["Unknown author"],
    seriesName: undefined,
    seriesNumber: undefined,
    publisher: candidate.publisher,
    publishedDate: candidate.publishedDate,
    coverUrl: candidate.coverUrl,
    favourite: false,
    readingStatus: "unread",
    metadataSource: "openlibrary",
    metadataFetchedAt: new Date().toISOString()
  };
}

export function emptyDraft(isbn?: string): BookDraft {
  return {
    isbn,
    title: "",
    authors: [""],
    favourite: false,
    readingStatus: "unread",
    metadataSource: "manual"
  };
}

export function filterBooks(books: Book[], query: string): Book[] {
  const needle = normaliseKey(query);
  if (!needle) return [...books];
  return books.filter((book) => normaliseKey([
    book.title,
    book.subtitle,
    ...book.authors,
    book.seriesName,
    book.isbn13
  ].filter(Boolean).join(" ")).includes(needle));
}

export type GroupMode = "title" | "author" | "series" | "status";
export interface BookGroup { key: string; label: string; books: Book[] }

function stableBookSort(left: Book, right: Book): number {
  return collator.compare(left.title, right.title) || left.id.localeCompare(right.id);
}

function authorLabels(books: Book[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  books.forEach((book) => book.authorKeys.forEach((key, index) => {
    const label = book.authors[index];
    const variants = counts.get(key) ?? new Map<string, number>();
    variants.set(label, (variants.get(label) ?? 0) + 1);
    counts.set(key, variants);
  }));
  return new Map([...counts].map(([key, variants]) => {
    const label = [...variants].sort((a, b) =>
      b[1] - a[1] || collator.compare(a[0], b[0]) || a[0].localeCompare(b[0])
    )[0][0];
    return [key, label];
  }));
}

function compareSeriesNumbers(left?: string, right?: string): number {
  const numeric = /^\d+(?:\.\d+)?$/;
  const leftNumber = left?.trim();
  const rightNumber = right?.trim();
  const leftIsNumeric = Boolean(leftNumber && numeric.test(leftNumber));
  const rightIsNumeric = Boolean(rightNumber && numeric.test(rightNumber));
  if (leftIsNumeric && rightIsNumeric) return Number(leftNumber) - Number(rightNumber);
  if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1;
  if (leftNumber && rightNumber) return collator.compare(leftNumber, rightNumber);
  if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
  return 0;
}

export function groupBooks(books: Book[], mode: GroupMode): BookGroup[] {
  const groups = new Map<string, BookGroup>();
  const labels = authorLabels(books);
  const add = (key: string, label: string, book: Book) => {
    const group = groups.get(key) ?? { key, label, books: [] };
    if (!group.books.some((candidate) => candidate.id === book.id)) group.books.push(book);
    groups.set(key, group);
  };

  books.forEach((book) => {
    if (mode === "author") {
      book.authorKeys.forEach((key) => add(key, labels.get(key) ?? "Unknown author", book));
    } else if (mode === "series") {
      add(book.seriesKey ?? "~none", book.seriesName ?? "No series", book);
    } else if (mode === "status") {
      const label = ({ unread: "Unread", reading: "Reading", read: "Read", abandoned: "Abandoned" } as const)[book.readingStatus];
      add(book.readingStatus, label, book);
    } else {
      const first = normaliseKey(book.title).charAt(0).toUpperCase() || "#";
      add(first, first, book);
    }
  });

  groups.forEach((group) => group.books.sort((left, right) => {
    if (mode === "series") {
      return compareSeriesNumbers(left.seriesNumber, right.seriesNumber) || stableBookSort(left, right);
    }
    return stableBookSort(left, right);
  }));
  return [...groups.values()].sort((left, right) =>
    left.key === "~none" ? 1 : right.key === "~none" ? -1 : collator.compare(left.label, right.label)
  );
}

const DRAFT_KEY = "active-book-draft-v1";

export async function saveActiveDraft(draft: BookDraft): Promise<void> {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, draft, savedAt: new Date().toISOString() }));
  await settingsTable.put({ key: DRAFT_KEY, value: { version: 1, draft, savedAt: new Date().toISOString() } });
}

export async function loadActiveDraft(): Promise<BookDraft | undefined> {
  const sessionValue = sessionStorage.getItem(DRAFT_KEY);
  if (sessionValue) {
    try {
      const value = JSON.parse(sessionValue) as { version?: number; draft?: BookDraft };
      if (value.version === 1 && value.draft) return value.draft;
    } catch {
      sessionStorage.removeItem(DRAFT_KEY);
    }
  }
  const record = await settingsTable.get(DRAFT_KEY);
  const value = record?.value as { version?: number; draft?: BookDraft } | undefined;
  return value?.version === 1 ? value.draft : undefined;
}

export async function clearActiveDraft(): Promise<void> {
  sessionStorage.removeItem(DRAFT_KEY);
  await settingsTable.delete(DRAFT_KEY);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await settingsTable.put({ key, value });
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await settingsTable.get(key))?.value as T | undefined;
}
