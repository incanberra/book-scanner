import "./styles.css";
import {
  createBackup,
  downloadJson,
  replaceCatalogue,
  validateBackupFile,
  type BackupPreview
} from "./backup";
import {
  bookToDraft,
  booksTable,
  candidateToDraft,
  clearActiveDraft,
  DuplicateBookError,
  emptyDraft,
  filterBooks,
  findOwnedBookMatch,
  getSetting,
  groupBooks,
  loadActiveDraft,
  normaliseIsbn,
  observeBooks,
  removeBook,
  restoreBook,
  saveActiveDraft,
  saveBook,
  setSetting,
  type Book,
  type BookDraft,
  type GroupMode,
  type MetadataCandidate,
  type ReadingStatus,
  ValidationError
} from "./catalog";
import { cancelLookup, lookupBook, lookupSeriesByIsbn, searchCoverBooks } from "./metadata";
import { readCover } from "./cover";
import { initialisePwa } from "./pwa";
import { startScanner, type ScannerSession } from "./scanner";

type View = "cover" | "scan" | "checker" | "editor" | "collection" | "settings";
type ScanState = "ready" | "starting" | "active" | "lookup" | "ambiguous";
type CheckerStatus = "ready" | "starting" | "active" | "lookup" | "ambiguous" | "owned" | "not-owned" | "unable";
type CheckerReason = "offline" | "not-found" | "missing-author" | "failed";
type EditorOrigin = "scan" | "checker" | "collection";

interface CheckerState {
  status: CheckerStatus;
  candidate?: MetadataCandidate;
  candidates: MetadataCandidate[];
  reason?: CheckerReason;
}

interface AppState {
  view: View;
  scanState: ScanState;
  fallbackIsbn?: string;
  cover?: {
    origin: "scan" | "checker";
    isbn: string;
    status: "ready" | "reading" | "searching" | "results";
    text: string;
    title: string;
    author: string;
    candidates: MetadataCandidate[];
  };
  checker: CheckerState;
  editorOrigin: EditorOrigin;
  books: Book[];
  draft?: BookDraft;
  recoverableDraft?: BookDraft;
  candidates: MetadataCandidate[];
  message?: { tone: "info" | "success" | "warning" | "error"; text: string };
  query: string;
  groupMode: GroupMode;
  offlineReady: boolean;
  updateAction?: () => Promise<void>;
  deletedBook?: Book;
  draftDirty: boolean;
  savingBook: boolean;
  backupPreview?: BackupPreview;
  backupFileName?: string;
  backupSafetyPrepared: boolean;
  backupAcknowledged: boolean;
  databaseUpdateRequired: boolean;
  lastBackupPreparedAt?: string;
  backupReminderDismissed: boolean;
  seriesBackfill?: {
    running: boolean;
    cancelRequested: boolean;
    total: number;
    processed: number;
    updated: number;
    notFound: number;
    failed: number;
  };
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("Application root is missing.");
const root: HTMLDivElement = appElement;

const state: AppState = {
  view: "scan",
  scanState: "ready",
  checker: { status: "ready", candidates: [] },
  editorOrigin: "scan",
  books: [],
  candidates: [],
  query: "",
  groupMode: "title",
  offlineReady: false,
  draftDirty: false,
  savingBook: false,
  backupSafetyPrepared: false,
  backupAcknowledged: false,
  databaseUpdateRequired: false,
  backupReminderDismissed: false
};

let coverController: AbortController | undefined;
let coverOperationId = 0;

let scannerSession: ScannerSession | undefined;
let cameraOperationId = 0;
let draftTimer: number | undefined;
let undoTimer: number | undefined;
let deferredInstall: BeforeInstallPromptEvent | undefined;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setMessage(tone: NonNullable<AppState["message"]>["tone"], text: string): void {
  state.message = { tone, text };
}

function announceRuntimeMessage(tone: NonNullable<AppState["message"]>["tone"], text: string): void {
  setMessage(tone, text);
  const current = document.querySelector<HTMLElement>("[data-runtime-notice]");
  if (current) {
    current.className = `notice notice--${tone}`;
    current.textContent = text;
    return;
  }
  const notice = document.createElement("div");
  notice.dataset.runtimeNotice = "true";
  notice.className = `notice notice--${tone}`;
  notice.setAttribute("role", "status");
  notice.textContent = text;
  document.querySelector(".topbar, .editor-bar")?.insertAdjacentElement("afterend", notice);
}

function resetChecker(): void {
  state.checker = { status: "ready", candidates: [] };
}

function stopScanner(): void {
  cameraOperationId += 1;
  scannerSession?.stop();
  scannerSession = undefined;
  if (state.scanState === "active" || state.scanState === "starting") state.scanState = "ready";
  if (state.checker.status === "active" || state.checker.status === "starting") state.checker.status = "ready";
}

function navigation(view: View): void {
  stopCover();
  state.cover = undefined;
  state.fallbackIsbn = undefined;
  stopScanner();
  cancelLookup();
  state.view = view;
  state.scanState = "ready";
  resetChecker();
  state.candidates = [];
  state.message = undefined;
  render();
}

function statusMarkup(): string {
  const message = state.message
    ? `<div class="notice notice--${state.message.tone}" role="status" data-runtime-notice>${escapeHtml(state.message.text)}</div>`
    : "";
  const offline = !navigator.onLine
    ? `<div class="connection-pill" role="status">Offline — saved books still work</div>`
    : "";
  const update = state.updateAction
    ? `<div class="notice notice--info update-notice"><span>An update is ready.</span><button class="button button--small" data-action="apply-update">Update now</button></div>`
    : "";
  const databaseUpdate = state.databaseUpdateRequired
    ? `<div class="notice notice--error update-notice"><span>Book Scanner was updated in another window. Reload before making changes.</span><button class="button button--small" data-action="reload-app">Reload</button></div>`
    : "";
  return `${offline}${databaseUpdate}${update}${message}`;
}

function topBar(title: string, eyebrow: string): string {
  return `<header class="topbar">
    <div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1></div>
    <div class="book-count" aria-label="${state.books.length} books saved"><strong>${state.books.length}</strong><span>books</span></div>
  </header>`;
}

function stopCover(): void {
  coverOperationId += 1;
  coverController?.abort();
  coverController = undefined;
  cancelLookup();
}

function coverFallback(): string {
  if (!state.fallbackIsbn) return "";
  return `<section class="manual-card cover-fallback"><p class="eyebrow">Another way to find it</p><h2>Try the front cover</h2>
    <p>Read the title and author from a photo, then choose the matching book.</p>
    <button class="button button--wide" data-action="open-cover">Scan front cover</button>
    <button class="text-button" data-action="cover-manual">Enter details manually</button></section>`;
}

function openCover(): void {
  if (!state.fallbackIsbn) return;
  const origin = state.view === "checker" ? "checker" : "scan";
  stopScanner();
  stopCover();
  state.cover = { origin, isbn: state.fallbackIsbn, status: "ready", text: "", title: "", author: "", candidates: [] };
  state.view = "cover";
  state.message = undefined;
  render();
}

function coverView(): string {
  const cover = state.cover!;
  const busy = cover.status === "reading" || cover.status === "searching";
  return `${topBar("Scan front cover", "Find by title and author")}${statusMarkup()}
    <main id="main-content" class="content scan-content">
      ${cover.candidates.length ? `<section class="candidate-panel"><h2>Confirm the title and author</h2><p>Choose only if both match your cover. These may show a different edition’s artwork.</p>
        ${cover.candidates.map((candidate, index) => `<button class="candidate" data-cover-candidate="${index}">
          <span class="candidate__cover" aria-hidden="true">${candidate.coverUrl ? `<img src="${escapeHtml(candidate.coverUrl)}" alt="" referrerpolicy="no-referrer" />` : "▥"}</span>
          <span><strong>${escapeHtml(candidate.title)}</strong><small>${escapeHtml(candidate.authors.join(", ") || "Unknown author")}</small></span>
        </button>`).join("")}</section>` : ""}
      <section class="manual-card cover-card">
        <h2>Photograph the front cover</h2>
        <p>Fill the photo with the cover, keep it upright and avoid glare. Make sure the title and author are clear.</p>
        <input class="is-hidden" type="file" id="cover-camera" data-cover-file accept="image/*" capture="environment" aria-label="Take a front cover photo" />
        <input class="is-hidden" type="file" id="cover-upload" data-cover-file accept="image/*" aria-label="Choose a front cover photo" />
        <div class="button-row"><button class="button" data-action="cover-photo" ${busy ? "disabled" : ""}>Take cover photo</button>
          <button class="button button--secondary" data-action="cover-upload" ${busy ? "disabled" : ""}>Choose photo</button></div>
        <p class="cover-help">Your photo stays on this device. Reading English cover text requires an initial download; book searches need an internet connection.</p>
      </section>
      ${busy ? `<div class="lookup-progress" role="status"><span class="spinner" aria-hidden="true"></span><p id="cover-progress">${cover.status === "reading" ? "Reading cover…" : "Searching for the title and author…"}</p></div>` : ""}
      <section class="manual-card cover-card"><h2>Review or refine the search</h2>
        <p>Remove quotes and promotional text. You can also enter the title and author yourself.</p>
        <form id="cover-search-form" class="cover-form">
          <label class="field"><span>Words read from the cover</span><textarea name="text" rows="3" maxlength="300" ${busy ? "disabled" : ""}>${escapeHtml(cover.text)}</textarea></label>
          <label class="field"><span>Book title</span><input name="title" value="${escapeHtml(cover.title)}" maxlength="200" ${busy ? "disabled" : ""} /></label>
          <label class="field"><span>Author</span><input name="author" value="${escapeHtml(cover.author)}" maxlength="150" ${busy ? "disabled" : ""} /></label>
          <p class="cover-help">If you enter a title or author, we search those fields instead of the cover words.</p>
          <button class="button" type="submit" ${busy ? "disabled" : ""}>Search books</button>
        </form>
      </section>
      ${!busy ? `<button class="text-button" data-action="cover-manual">${cover.candidates.length ? "None of these — enter details manually" : "Enter details manually"}</button>` : ""}
      <button class="button button--secondary" data-action="cancel-cover">Cancel cover search</button>
    </main>`;
}

async function recogniseCover(file: File): Promise<void> {
  const cover = state.cover;
  if (!cover) return;
  stopCover();
  const operationId = coverOperationId;
  const controller = new AbortController();
  coverController = controller;
  cover.status = "reading";
  cover.candidates = [];
  cover.text = "";
  cover.title = "";
  cover.author = "";
  state.message = undefined;
  render();
  try {
    const text = await readCover(file, controller.signal, (message) => {
      if (operationId !== coverOperationId) return;
      const progress = document.querySelector("#cover-progress");
      if (progress) progress.textContent = message;
    });
    if (operationId !== coverOperationId || state.view !== "cover") return;
    cover.text = text;
    if (!text) {
      cover.status = "ready";
      setMessage("warning", "No readable title or author found. Try a clearer photo or enter them below.");
      render();
      return;
    }
    await findCoverMatches();
  } catch (error) {
    if (operationId !== coverOperationId || state.view !== "cover") return;
    cover.status = "ready";
    setMessage("warning", error instanceof Error ? `${error.message} You can enter the title and author below.` : "Could not read this photo. Try another photo or enter the title and author below.");
    render();
  } finally {
    if (coverController === controller) coverController = undefined;
  }
}

async function findCoverMatches(): Promise<void> {
  const cover = state.cover;
  if (!cover) return;
  if (![cover.text, cover.title, cover.author].some((value) => value.trim())) {
    setMessage("warning", "Take a cover photo or enter a title and author first.");
    render();
    return;
  }
  const operationId = ++coverOperationId;
  cover.status = "searching";
  cover.candidates = [];
  state.message = undefined;
  render();
  const result = await searchCoverBooks(cover);
  if (result.kind === "cancelled" || operationId !== coverOperationId || state.view !== "cover") return;
  cover.status = "results";
  if (result.kind === "ambiguous") {
    cover.candidates = result.candidates;
  } else {
    setMessage("warning", result.kind === "offline" ? "You’re offline. Reconnect to search, or enter the details manually."
      : result.kind === "failed" ? result.message
      : "No matching books found. Remove extra cover words, enter the title and author, or try another photo.");
  }
  render();
}

function scanView(): string {
  const recover = state.recoverableDraft
    ? `<section class="resume-card"><div><strong>Unsaved book found</strong><p>Continue where you left off or discard the draft.</p></div><div class="button-row"><button class="button button--small" data-action="recover-draft">Continue</button><button class="button button--small button--ghost" data-action="discard-recovery">Discard</button></div></section>`
    : "";

  const camera = state.scanState === "starting" || state.scanState === "active"
    ? `<div class="camera-shell">
        <video id="camera-preview" muted playsinline aria-label="Rear camera barcode preview"></video>
        <div class="scan-guide" aria-hidden="true"><span></span></div>
        <div class="camera-actions">
          <button class="button button--ghost-on-dark" data-action="stop-camera">Cancel</button>
          <button class="button button--ghost-on-dark is-hidden" data-action="toggle-torch">Torch</button>
        </div>
      </div>`
    : `<button class="scan-launch" data-action="start-camera">
        <span class="scan-launch__icon" aria-hidden="true">▣</span>
        <span><strong>Scan a book</strong><small>Point your rear camera at the ISBN barcode</small></span>
      </button>`;

  const progress = state.scanState === "lookup"
    ? `<div class="lookup-progress" role="status"><span class="spinner" aria-hidden="true"></span><div><strong>Finding your book…</strong><p>Checking Open Library for this exact edition.</p></div></div>`
    : "";

  const ambiguous = state.scanState === "ambiguous"
    ? `<section class="candidate-panel"><h2>Choose the matching edition</h2><p>We found more than one exact-ISBN candidate and won’t guess.</p>${state.candidates.map((candidate, index) => `
        <button class="candidate" data-candidate="${index}">
          <span class="candidate__cover">${candidate.coverUrl ? `<img src="${escapeHtml(candidate.coverUrl)}" alt="" referrerpolicy="no-referrer" />` : "▥"}</span>
          <span><strong>${escapeHtml(candidate.title)}</strong><small>${escapeHtml(candidate.authors.join(", ") || "Unknown author")}</small><small>${escapeHtml([candidate.publisher, candidate.publishedDate].filter(Boolean).join(" · "))}</small></span>
        </button>`).join("")}
        <button class="text-button" data-action="manual-from-ambiguous">None of these — enter details manually</button>
      </section>`
    : "";

  const checkerEntry = state.scanState === "ready"
    ? `<button class="checker-launch" data-action="open-checker" aria-label="Book Check">
        <span class="checker-launch__icon" aria-hidden="true">✓</span>
        <span><strong>Book Check</strong><small>See if you already own a book before buying it</small></span>
      </button>`
    : "";

  return `${topBar("Scan a book", "Your private shelf")}${statusMarkup()}${recover}
    <main id="main-content" class="content scan-content">
      ${coverFallback()}${camera}${checkerEntry}${progress}${ambiguous}
      <section class="manual-card">
        <div><p class="eyebrow">Can’t scan it?</p><h2>Enter the ISBN</h2></div>
        <form id="isbn-form" class="inline-form">
          <label class="sr-only" for="manual-isbn">ISBN-10 or ISBN-13</label>
          <input id="manual-isbn" name="isbn" inputmode="numeric" autocomplete="off" placeholder="978…" ${state.scanState === "lookup" ? "disabled" : ""} />
          <button class="button" type="submit" ${state.scanState === "lookup" ? "disabled" : ""}>Find book</button>
        </form>
        <button class="text-button" data-action="add-without-isbn">Add a book without an ISBN</button>
      </section>
      <aside class="privacy-note"><span aria-hidden="true">◉</span><p><strong>Private by default</strong><br />Your catalogue stays on this device. Only an ISBN or cover search words are sent to Open Library. Cover photos stay on this device.</p></aside>
    </main>`;
}

function checkerView(): string {
  const status = state.checker.status;
  const camera = status === "starting" || status === "active"
    ? `<div class="camera-shell">
        <video id="camera-preview" muted playsinline aria-label="Rear camera barcode preview"></video>
        <div class="scan-guide" aria-hidden="true"><span></span></div>
        <div class="camera-actions">
          <button class="button button--ghost-on-dark" data-action="stop-checker-camera">Cancel</button>
          <button class="button button--ghost-on-dark is-hidden" data-action="toggle-torch">Torch</button>
        </div>
      </div>`
    : status === "ready"
      ? `<button class="scan-launch" data-action="start-checker-camera">
          <span class="scan-launch__icon" aria-hidden="true">✓</span>
          <span><strong>Scan to check</strong><small>Point your rear camera at the ISBN barcode</small></span>
        </button>`
      : "";

  const progress = status === "lookup"
    ? `<div class="lookup-progress" role="status"><span class="spinner" aria-hidden="true"></span><div><strong>Checking your collection…</strong><p>Identifying this edition and comparing it with your saved books.</p></div></div>`
    : "";

  const ambiguous = status === "ambiguous"
    ? `<section class="candidate-panel"><h2>Choose the matching edition</h2><p>We found more than one exact-ISBN candidate and won’t guess.</p>${state.checker.candidates.map((candidate, index) => `
        <button class="candidate" data-checker-candidate="${index}">
          <span class="candidate__cover">${candidate.coverUrl ? `<img src="${escapeHtml(candidate.coverUrl)}" alt="" referrerpolicy="no-referrer" />` : "▥"}</span>
          <span><strong>${escapeHtml(candidate.title)}</strong><small>${escapeHtml(candidate.authors.join(", ") || "Unknown author")}</small><small>${escapeHtml([candidate.publisher, candidate.publishedDate].filter(Boolean).join(" · "))}</small></span>
        </button>`).join("")}
      </section>`
    : "";

  const result = status === "owned"
    ? `<section class="checker-result checker-result--owned" role="status"><span class="checker-result__icon" aria-hidden="true">✓</span><h2>Already owned</h2><button class="button button--wide" data-action="check-another">Check another book</button></section>`
    : status === "not-owned"
      ? `<section class="checker-result checker-result--not-owned" role="status"><span class="checker-result__icon" aria-hidden="true">＋</span><h2>Not in your collection</h2><div class="checker-result__actions"><button class="button button--wide" data-action="add-checked-book">Add book</button><button class="button button--wide button--secondary" data-action="check-another">Check another book</button></div></section>`
      : status === "unable"
        ? `<section class="checker-result checker-result--unable" role="status"><span class="checker-result__icon" aria-hidden="true">?</span><h2>Unable to check</h2><p>${escapeHtml(checkerReasonText(state.checker.reason))}</p><button class="button button--wide" data-action="check-another">Check a different book</button></section>`
        : "";

  const manual = ["ready", "starting", "active", "lookup"].includes(status)
    ? `<section class="manual-card">
        <div><p class="eyebrow">Can’t scan it?</p><h2>Enter the ISBN</h2></div>
        <form id="checker-isbn-form" class="inline-form">
          <label class="sr-only" for="checker-manual-isbn">Book Check ISBN-10 or ISBN-13</label>
          <input id="checker-manual-isbn" name="isbn" inputmode="numeric" autocomplete="off" placeholder="978…" ${status === "lookup" ? "disabled" : ""} />
          <button class="button" type="submit" ${status === "lookup" ? "disabled" : ""}>Check book</button>
        </form>
      </section>`
    : "";

  return `${topBar("Book Check", "Before you buy")}${statusMarkup()}
    <main id="main-content" class="content scan-content checker-content">
      ${camera}${progress}${ambiguous}${coverFallback()}${result}${manual}
      ${status === "ready" ? `<aside class="privacy-note"><span aria-hidden="true">◉</span><p><strong>Check without changing your shelf</strong><br />No book is added unless you choose Add book and save it.</p></aside>` : ""}
    </main>`;
}

function checkerReasonText(reason?: CheckerReason): string {
  if (reason === "offline") return "Unable to check while offline unless this exact ISBN is already saved.";
  if (reason === "not-found") return "Open Library could not identify this ISBN.";
  if (reason === "missing-author") return "The book was identified, but author information was unavailable.";
  return "Book information could not be retrieved. Please try again.";
}

function input(name: keyof BookDraft, label: string, value?: string, options = ""): string {
  return `<label class="field"><span>${escapeHtml(label)}</span><input name="${name}" value="${escapeHtml(value)}" ${options} /></label>`;
}

function editorView(): string {
  const draft = state.draft ?? emptyDraft();
  const existing = Boolean(draft.id);
  return `<header class="editor-bar"><button class="icon-button" data-action="close-editor" aria-label="Close editor" ${state.savingBook ? "disabled" : ""}>←</button><div><p class="eyebrow">${existing ? "Editing your copy" : "Confirm the details"}</p><h1>${existing ? "Book details" : "New book"}</h1></div></header>
    ${statusMarkup()}
    <main id="main-content" class="content editor-content">
      <form id="book-form" class="book-form" aria-busy="${state.savingBook}">
        <section class="book-hero">
          <div class="cover-preview">${draft.coverUrl ? `<img src="${escapeHtml(draft.coverUrl)}" alt="Book cover" referrerpolicy="no-referrer" />` : `<span aria-hidden="true">▥</span><small>No cover</small>`}</div>
          <div class="book-hero__fields">
            ${input("title", "Title", draft.title, "required maxlength=\"500\"")}
            ${input("subtitle", "Subtitle", draft.subtitle, "maxlength=\"500\"")}
          </div>
        </section>
        <label class="field"><span>Authors <small>one per line</small></span><textarea name="authors" rows="3" required>${escapeHtml(draft.authors.join("\n"))}</textarea></label>
        <div class="field-grid">
          ${input("isbn", "ISBN", draft.isbn, "inputmode=\"numeric\"")}
          ${input("publisher", "Publisher", draft.publisher, "maxlength=\"500\"")}
          ${input("publishedDate", "Publication date", draft.publishedDate, "maxlength=\"500\"")}
          ${input("seriesName", "Series", draft.seriesName, "maxlength=\"500\"")}
          ${input("seriesNumber", "Series number", draft.seriesNumber, "maxlength=\"500\"")}
          <label class="field"><span>Reading status</span><select name="readingStatus">
            ${(["unread", "reading", "read", "abandoned"] as ReadingStatus[]).map((status) => `<option value="${status}" ${draft.readingStatus === status ? "selected" : ""}>${status.charAt(0).toUpperCase() + status.slice(1)}</option>`).join("")}
          </select></label>
        </div>
        <label class="check-field"><input type="checkbox" name="favourite" ${draft.favourite ? "checked" : ""} /><span aria-hidden="true">★</span> Favourite</label>
        ${draft.coverUrl ? `<button class="text-button" type="button" data-action="remove-cover">Remove cover</button>` : ""}
        <div class="form-actions">
          <button class="button button--wide" type="submit" data-save-button ${state.savingBook ? "disabled" : ""}>${state.savingBook ? "Saving…" : "Save book"}</button>
          ${!existing ? `<button class="button button--wide button--secondary" type="button" data-action="save-next" ${state.savingBook ? "disabled" : ""}>Save and scan another</button>` : ""}
          ${existing ? `<button class="text-button text-button--danger" type="button" data-action="delete-book">Delete book</button>` : ""}
        </div>
      </form>
    </main>`;
}

function collectionView(): string {
  const filtered = filterBooks(state.books, state.query);
  const groups = groupBooks(filtered, state.groupMode);
  const empty = !state.books.length
    ? `<section class="empty-state"><span aria-hidden="true">▥</span><h2>Your shelf is empty</h2><p>Scan your first book to start building the collection.</p><button class="button" data-nav="scan">Scan a book</button></section>`
    : !filtered.length
      ? `<section class="empty-state"><h2>No books match</h2><p>Try a different title, author, series, or ISBN.</p><button class="text-button" data-action="clear-search">Clear search</button></section>`
      : groups.map((group) => `<section class="book-group"><h2>${escapeHtml(group.label)} <span>${group.books.length}</span></h2><div class="book-list">${group.books.map((book) => `
          <button class="book-row" data-book="${book.id}">
            <span class="mini-cover">${book.coverUrl ? `<img src="${escapeHtml(book.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : "▥"}</span>
            <span class="book-row__body"><strong>${escapeHtml(book.title)}</strong><small>${escapeHtml(book.authors.join(", "))}</small>${book.seriesName ? `<small>${escapeHtml(book.seriesName)}${book.seriesNumber ? ` · ${escapeHtml(book.seriesNumber)}` : ""}</small>` : ""}</span>
            <span class="book-row__meta"><span class="status-dot status-dot--${book.readingStatus}">${escapeHtml(book.readingStatus)}</span>${book.favourite ? `<span class="star" aria-label="Favourite">★</span>` : ""}</span>
          </button>`).join("")}</div></section>`).join("");

  return `${topBar("Your collection", "Browse the shelf")}${statusMarkup()}
    <main id="main-content" class="content collection-content">
      <label class="search-box"><span class="sr-only">Search collection</span><span aria-hidden="true">⌕</span><input type="search" id="collection-search" value="${escapeHtml(state.query)}" placeholder="Title, author, series or ISBN" /></label>
      <div class="segmented" aria-label="Group books by">${(["title", "author", "series", "status"] as GroupMode[]).map((mode) => `<button data-group="${mode}" aria-pressed="${state.groupMode === mode}">${mode === "status" ? "Reading" : mode.charAt(0).toUpperCase() + mode.slice(1)}</button>`).join("")}</div>
      ${empty}
    </main>`;
}

function settingsView(): string {
  const backupIsOld = state.lastBackupPreparedAt
    ? Date.now() - Date.parse(state.lastBackupPreparedAt) >= 14 * 24 * 60 * 60 * 1_000
    : state.books.length > 0;
  const backupReminder = backupIsOld && !state.backupReminderDismissed
    ? `<div class="notice notice--warning"><strong>Keep an external backup</strong><p>${state.lastBackupPreparedAt ? "Your last prepared export is more than 14 days old." : "This collection has not been exported yet."}</p><button class="text-button" data-action="dismiss-backup-reminder">Dismiss</button></div>`
    : "";
  const lastBackup = state.lastBackupPreparedAt
    ? `<p class="settings-meta">Last export prepared: ${escapeHtml(new Date(state.lastBackupPreparedAt).toLocaleString("en-AU"))}</p>`
    : "";
  const preview = state.backupPreview
    ? `<div class="backup-preview" role="status">
        <p class="eyebrow">Validated backup</p>
        <h3>${escapeHtml(state.backupFileName ?? "Selected file")}</h3>
        <dl class="backup-summary">
          <div><dt>Current</dt><dd>${state.books.length}</dd></div>
          <div><dt>Replacement</dt><dd>${state.backupPreview.books.length}</dd></div>
          <div><dt>Without ISBN</dt><dd>${state.backupPreview.isbnlessCount}</dd></div>
        </dl>
        ${state.backupPreview.warnings.length ? `<div class="notice notice--warning"><strong>Import warnings</strong><ul>${state.backupPreview.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>` : ""}
        <div class="safety-step">
          <button class="button button--secondary" data-action="safety-export">${state.backupSafetyPrepared ? "Safety copy prepared ✓" : "1. Download current collection"}</button>
          <label class="check-field"><input id="backup-acknowledgement" type="checkbox" ${state.backupAcknowledged ? "checked" : ""} ${state.backupSafetyPrepared ? "" : "disabled"} />I have retained the safety copy</label>
          <button class="button button--danger" data-action="replace-catalogue" ${state.backupSafetyPrepared && state.backupAcknowledged ? "" : "disabled"}>Replace collection</button>
        </div>
      </div>`
    : "";
  const missingSeriesCount = state.books.filter((book) => book.isbn13 && !book.seriesName).length;
  const missingSeriesLabel = `${missingSeriesCount} ${missingSeriesCount === 1 ? "book" : "books"}`;
  const seriesBackfill = state.seriesBackfill;
  const seriesProgress = seriesBackfill
    ? `<div class="notice notice--${seriesBackfill.running ? "info" : "success"}" role="status">
        <strong>${seriesBackfill.running ? (seriesBackfill.cancelRequested ? "Stopping series lookup…" : `Finding series ${seriesBackfill.processed}/${seriesBackfill.total}`) : "Series lookup finished"}</strong>
        <p>${seriesBackfill.updated} updated · ${seriesBackfill.notFound} not found · ${seriesBackfill.failed} failed</p>
      </div>`
    : "";
  return `${topBar("Settings", "This device")}${statusMarkup()}
    <main id="main-content" class="content settings-content">
      <section class="settings-card"><h2>Install Book Scanner</h2><p>Add it to your Android home screen for a full-screen, app-like experience.</p><button class="button" data-action="install-app" ${deferredInstall ? "" : "disabled"}>${deferredInstall ? "Install app" : "Already installed or unavailable"}</button></section>
      <section class="settings-card"><h2>Local storage</h2><p>Your books live in this browser’s IndexedDB storage and work offline. Browser storage is not a backup.</p><button class="button button--secondary" data-action="request-storage">Request persistent storage</button></section>
      <section class="settings-card"><p class="eyebrow">Portable catalogue</p><h2>Backup and restore</h2><p>Export a JSON copy you can retain outside this browser. Import replaces the complete collection only after validation, a safety export, and confirmation.</p>
        ${backupReminder}${lastBackup}
        <div class="button-row"><button class="button" data-action="export-backup">Export collection</button><label class="button button--secondary file-button">Choose backup<input id="backup-file" type="file" accept=".json,application/json" /></label></div>
        ${preview}
      </section>
      <section class="settings-card"><p class="eyebrow">Catalogue cleanup</p><h2>Find missing series</h2><p>Check exact-edition Open Library records for saved ISBN books. Only books without a series name are updated; your manual series entries are never replaced.</p>
        ${seriesProgress}
        <div class="button-row">
          <button class="button" data-action="backfill-series" ${seriesBackfill?.running || missingSeriesCount === 0 ? "disabled" : ""}>${missingSeriesCount ? `Check ${missingSeriesLabel}` : "No missing series"}</button>
          ${seriesBackfill?.running ? `<button class="button button--secondary" data-action="cancel-series-backfill" ${seriesBackfill.cancelRequested ? "disabled" : ""}>${seriesBackfill.cancelRequested ? "Stopping…" : "Stop"}</button>` : ""}
        </div>
      </section>
      <section class="settings-card"><h2>Book information</h2><p>New ISBN lookups use <a href="https://openlibrary.org" target="_blank" rel="noreferrer">Open Library</a>. Saved book facts remain available without it.</p></section>
    </main>`;
}

function bottomNav(): string {
  if (state.view === "editor") return "";
  return `<nav class="bottom-nav" aria-label="Main navigation">
    <button data-nav="scan" aria-current="${state.view === "scan" || state.view === "checker" || state.view === "cover" ? "page" : "false"}"><span aria-hidden="true">▣</span>Scan</button>
    <button data-nav="collection" aria-current="${state.view === "collection" ? "page" : "false"}"><span aria-hidden="true">▥</span>Collection</button>
    <button data-nav="settings" aria-current="${state.view === "settings" ? "page" : "false"}"><span aria-hidden="true">⚙</span>Settings</button>
  </nav>`;
}

function undoMarkup(): string {
  return state.deletedBook
    ? `<div class="undo-toast" role="status"><span>“${escapeHtml(state.deletedBook.title)}” deleted</span><button data-action="undo-delete">Undo</button></div>`
    : "";
}

function render(): void {
  const view = state.view === "cover" ? coverView() : state.view === "scan"
    ? scanView()
    : state.view === "checker"
      ? checkerView()
      : state.view === "editor"
        ? editorView()
        : state.view === "collection"
          ? collectionView()
          : settingsView();
  root.innerHTML = `<div class="app-shell">${view}${bottomNav()}${undoMarkup()}</div>`;
  bindEvents();
}

function renderOutsideEditor(): void {
  const cameraInProgress = Boolean(scannerSession)
    || state.scanState === "starting"
    || state.scanState === "active"
    || state.checker.status === "starting"
    || state.checker.status === "active";
  if (!cameraInProgress && (state.view !== "editor" || !document.querySelector("#book-form"))) render();
}

function readDraftForm(): BookDraft | undefined {
  const form = document.querySelector<HTMLFormElement>("#book-form");
  if (!form || !state.draft) return undefined;
  const data = new FormData(form);
  return {
    ...state.draft,
    isbn: String(data.get("isbn") ?? ""),
    title: String(data.get("title") ?? ""),
    subtitle: String(data.get("subtitle") ?? ""),
    authors: String(data.get("authors") ?? "").split(/\r?\n|,/),
    seriesName: String(data.get("seriesName") ?? ""),
    seriesNumber: String(data.get("seriesNumber") ?? ""),
    publisher: String(data.get("publisher") ?? ""),
    publishedDate: String(data.get("publishedDate") ?? ""),
    favourite: data.get("favourite") === "on",
    readingStatus: String(data.get("readingStatus") ?? "unread") as ReadingStatus
  };
}

function queueDraftSave(): void {
  state.draftDirty = true;
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    const draft = readDraftForm();
    if (!draft) return;
    state.draft = draft;
    void saveActiveDraft(draft);
  }, 350);
}

async function beginLookup(isbnInput: string): Promise<void> {
  try {
    const isbn13 = normaliseIsbn(isbnInput);
    if (!isbn13) throw new ValidationError("Enter an ISBN first.");
    stopScanner();
    cancelLookup();
    state.fallbackIsbn = undefined;
    const duplicate = state.books.find((book) => book.isbn13 === isbn13);
    if (duplicate) {
      state.draft = bookToDraft(duplicate);
      state.editorOrigin = "scan";
      state.view = "editor";
      setMessage("info", "Already in your collection — opening the saved book.");
      await saveActiveDraft(state.draft);
      render();
      return;
    }
    state.scanState = "lookup";
    setMessage("info", `Looking up ISBN ${isbn13}…`);
    render();
    const result = await lookupBook(isbn13);
    if (result.kind === "cancelled") return;
    if (result.kind === "matched") {
      openEditor(candidateToDraft(result.candidate));
    } else if (result.kind === "ambiguous") {
      state.scanState = "ambiguous";
      state.candidates = result.candidates;
      state.message = undefined;
      render();
    } else {
      if (result.kind === "not-found") {
        state.scanState = "ready";
        state.fallbackIsbn = isbn13;
        setMessage("warning", "No exact ISBN match found. Try the front cover to identify the title and author.");
        render();
        return;
      }
      const message = result.kind === "offline"
          ? "You’re offline. Add the details manually or retry later."
          : result.message;
      openEditor({ ...emptyDraft(isbn13), isbn: isbn13 });
      setMessage(result.kind === "failed" ? "error" : "warning", message);
      render();
    }
  } catch (error) {
    setMessage("error", error instanceof Error ? error.message : "Enter a valid book ISBN.");
    state.scanState = "ready";
    render();
  }
}

async function evaluateCheckerCandidate(candidate: MetadataCandidate): Promise<void> {
  try {
    const books = await booksTable.toArray();
    if (state.view !== "checker") return;
    state.books = books;
    state.checker.candidates = [];
    state.message = undefined;
    const owned = findOwnedBookMatch(books, candidate);
    if (!owned && !candidate.authors.length) {
      state.checker = { status: "unable", candidates: [], reason: "missing-author" };
      render();
      return;
    }
    state.checker = {
      status: owned ? "owned" : "not-owned",
      candidate,
      candidates: []
    };
    render();
  } catch {
    if (state.view !== "checker") return;
    state.checker = { status: "unable", candidates: [], reason: "failed" };
    render();
  }
}

async function beginCheckerLookup(isbnInput: string): Promise<void> {
  try {
    stopScanner();
    cancelLookup();
    state.fallbackIsbn = undefined;
    const isbn13 = normaliseIsbn(isbnInput);
    if (!isbn13) throw new ValidationError("Enter an ISBN first.");
    state.message = undefined;

    const books = await booksTable.toArray();
    if (state.view !== "checker") return;
    state.books = books;
    if (findOwnedBookMatch(books, { isbn13 })) {
      state.checker = { status: "owned", candidates: [] };
      render();
      return;
    }
    if (!navigator.onLine) {
      state.checker = { status: "unable", candidates: [], reason: "offline" };
      render();
      return;
    }

    state.checker = { status: "lookup", candidates: [] };
    render();
    const result = await lookupBook(isbn13);
    if (result.kind === "cancelled") return;
    if (result.kind === "matched") {
      await evaluateCheckerCandidate(result.candidate);
    } else if (result.kind === "ambiguous") {
      state.checker = { status: "ambiguous", candidates: result.candidates };
      state.message = undefined;
      render();
    } else {
      if (result.kind === "not-found") state.fallbackIsbn = isbn13;
      state.checker = {
        status: "unable",
        candidates: [],
        reason: result.kind === "offline" ? "offline" : result.kind === "not-found" ? "not-found" : "failed"
      };
      state.message = undefined;
      render();
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      resetChecker();
      setMessage("error", error.message);
    } else {
      state.checker = { status: "unable", candidates: [], reason: "failed" };
      state.message = undefined;
    }
    render();
  }
}

function openEditor(draft: BookDraft, origin: EditorOrigin = state.view === "checker" ? "checker" : state.view === "collection" ? "collection" : "scan"): void {
  stopScanner();
  stopCover();
  state.cover = undefined;
  state.fallbackIsbn = undefined;
  cancelLookup();
  state.draft = draft;
  state.editorOrigin = origin;
  state.draftDirty = false;
  state.recoverableDraft = undefined;
  state.view = "editor";
  state.scanState = "ready";
  state.candidates = [];
  state.message = undefined;
  void saveActiveDraft(draft);
  render();
}

async function startCamera(mode: "scan" | "checker" = "scan"): Promise<void> {
  cancelLookup();
  stopScanner();
  state.fallbackIsbn = undefined;
  const operationId = ++cameraOperationId;
  if (mode === "checker") state.checker.status = "starting";
  else state.scanState = "starting";
  setMessage("info", "Starting the rear camera…");
  render();
  const video = document.querySelector<HTMLVideoElement>("#camera-preview");
  if (!video) return;
  try {
    const session = await startScanner(
      video,
      (isbn) => void (mode === "checker" ? beginCheckerLookup(isbn) : beginLookup(isbn)),
      (message) => announceRuntimeMessage("warning", message),
      (message) => announceRuntimeMessage("error", message)
    );
    if (operationId !== cameraOperationId || state.view !== mode) {
      session.stop();
      return;
    }
    scannerSession = session;
    if (mode === "checker") state.checker.status = "active";
    else state.scanState = "active";
    setMessage("info", "Hold the barcode inside the frame.");
    render();
    const replacementVideo = document.querySelector<HTMLVideoElement>("#camera-preview");
    if (replacementVideo !== video) {
      // Rendering a live video would detach its stream, so restore the original node.
      const shell = replacementVideo?.parentElement;
      replacementVideo?.replaceWith(video);
      shell?.querySelector<HTMLButtonElement>("[data-action='toggle-torch']")?.classList.toggle("is-hidden", !scannerSession.hasTorch);
    }
  } catch (error) {
    if (operationId !== cameraOperationId || state.view !== mode) return;
    if (mode === "checker") state.checker.status = "ready";
    else state.scanState = "ready";
    setMessage("error", error instanceof Error ? error.message : "The camera is unavailable.");
    render();
  }
}

async function submitBook(scanNext = false): Promise<void> {
  if (state.savingBook) return;
  const form = document.querySelector<HTMLFormElement>("#book-form");
  if (!form?.reportValidity()) return;
  const draft = readDraftForm();
  if (!draft) return;
  window.clearTimeout(draftTimer);
  draftTimer = undefined;
  state.draft = draft;
  state.savingBook = true;
  form.setAttribute("aria-busy", "true");
  form.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = true; });
  const saveButton = form.querySelector<HTMLButtonElement>("[data-save-button]");
  if (saveButton) saveButton.textContent = "Saving…";
  let book: Book;
  try {
    book = await saveBook(draft);
  } catch (error) {
    state.savingBook = false;
    if (error instanceof DuplicateBookError) {
      const existing = await booksTable.get(error.existingId);
      if (existing) state.draft = bookToDraft(existing);
    }
    setMessage("error", error instanceof Error ? error.message : "The book could not be saved.");
    render();
    return;
  }

  const draftCleared = await clearDraftAfterMutation("save");
  state.savingBook = false;
  state.draft = undefined;
  state.draftDirty = false;
  state.recoverableDraft = undefined;
  setMessage(
    draftCleared ? "success" : "warning",
    draftCleared
      ? `Saved “${book.title}”.`
      : `Saved “${book.title}”, but temporary recovery data could not be cleared. Your book is safe.`
  );
  if (scanNext) {
    if (state.editorOrigin === "checker") {
      state.view = "checker";
      resetChecker();
      void startCamera("checker");
      return;
    }
    state.view = "scan";
    state.scanState = "ready";
  } else {
    state.view = "collection";
  }
  render();
}

async function clearDraftAfterMutation(operation: "save" | "delete"): Promise<boolean> {
  try {
    await clearActiveDraft();
    return true;
  } catch (error) {
    console.warn(`Book ${operation} succeeded but draft cleanup failed`, error);
    return false;
  }
}

async function deleteCurrentBook(): Promise<void> {
  const id = state.draft?.id;
  if (!id || !window.confirm("Delete this book from your collection?")) return;
  let deleted: Book | undefined;
  try {
    deleted = await removeBook(id);
  } catch (error) {
    setMessage("error", error instanceof Error ? error.message : "The book could not be deleted.");
    render();
    return;
  }
  if (!deleted) return;
  const draftCleared = await clearDraftAfterMutation("delete");
  state.deletedBook = deleted;
  state.draft = undefined;
  state.draftDirty = false;
  state.view = "collection";
  setMessage(
    draftCleared ? "success" : "warning",
    draftCleared ? "Book deleted." : "Book deleted, but temporary recovery data could not be cleared."
  );
  window.clearTimeout(undoTimer);
  undoTimer = window.setTimeout(() => { state.deletedBook = undefined; render(); }, 10_000);
  render();
}

async function closeEditor(): Promise<void> {
  if (state.draftDirty && !window.confirm("Discard your unsaved changes?")) return;
  const destination: View = state.draft?.id ? "collection" : state.editorOrigin === "checker" ? "checker" : "scan";
  await clearActiveDraft();
  state.draft = undefined;
  state.draftDirty = false;
  navigation(destination);
}

async function exportCurrentCatalogue(safetyCopy = false): Promise<void> {
  try {
    const backup = await createBackup();
    downloadJson(backup.json, backup.filename);
    state.lastBackupPreparedAt = backup.envelope.exportedAt;
    state.backupReminderDismissed = false;
    await setSetting("backup-reminder-dismissed", false);
    if (safetyCopy) state.backupSafetyPrepared = true;
    setMessage("success", safetyCopy
      ? "Safety copy prepared. Retain the downloaded file before replacing the collection."
      : "Backup prepared. Retain the downloaded file outside this browser.");
    render();
  } catch (error) {
    setMessage("error", error instanceof Error ? error.message : "The backup could not be prepared.");
    render();
  }
}

async function chooseBackup(file?: File): Promise<void> {
  if (!file) return;
  try {
    state.backupPreview = await validateBackupFile(file);
    state.backupFileName = file.name;
    state.backupSafetyPrepared = false;
    state.backupAcknowledged = false;
    setMessage("success", "Backup validated. Review the counts before replacing your collection.");
  } catch (error) {
    state.backupPreview = undefined;
    state.backupFileName = undefined;
    setMessage("error", error instanceof Error ? error.message : "The backup file is invalid.");
  }
  render();
}

async function confirmReplacement(): Promise<void> {
  if (!state.backupPreview || !state.backupSafetyPrepared || !state.backupAcknowledged) return;
  const count = state.backupPreview.books.length;
  if (!window.confirm(`Replace all ${state.books.length} current books with ${count} books from this backup?`)) return;
  try {
    await replaceCatalogue(state.backupPreview);
    state.backupPreview = undefined;
    state.backupFileName = undefined;
    state.backupSafetyPrepared = false;
    state.backupAcknowledged = false;
    setMessage("success", `Collection replaced with ${count} books.`);
  } catch {
    setMessage("error", "Import failed and was rolled back. Your previous collection is unchanged.");
  }
  render();
}

async function backfillMissingSeries(): Promise<void> {
  if (state.seriesBackfill?.running) return;
  const targets = state.books.filter((book) => book.isbn13 && !book.seriesName);
  if (!targets.length) {
    setMessage("info", "All ISBN books already have series information or have been checked manually.");
    render();
    return;
  }

  state.seriesBackfill = {
    running: true,
    cancelRequested: false,
    total: targets.length,
    processed: 0,
    updated: 0,
    notFound: 0,
    failed: 0
  };
  state.message = undefined;
  render();

  for (const target of targets) {
    const progress = state.seriesBackfill;
    if (!progress || progress.cancelRequested) break;
    try {
      const result = await lookupSeriesByIsbn(target.isbn13!);
      if (result.kind === "matched") {
        const current = await booksTable.get(target.id);
        if (current && !current.seriesName) {
          await saveBook({
            ...bookToDraft(current),
            seriesName: result.seriesName,
            seriesNumber: current.seriesNumber ?? result.seriesNumber
          });
          progress.updated += 1;
        }
      } else if (result.kind === "not-found") {
        progress.notFound += 1;
      } else {
        progress.failed += 1;
        if (result.kind === "offline") progress.cancelRequested = true;
      }
    } catch {
      progress.failed += 1;
    }
    progress.processed += 1;
    if (state.view === "settings") render();
  }

  const progress = state.seriesBackfill;
  if (!progress) return;
  const stopped = progress.cancelRequested && progress.processed < progress.total;
  const updatedLabel = `${progress.updated} ${progress.updated === 1 ? "book" : "books"}`;
  progress.running = false;
  setMessage(
    progress.failed ? "warning" : "success",
    stopped
      ? `Series lookup stopped after ${progress.processed} books. ${updatedLabel} ${progress.updated === 1 ? "was" : "were"} updated.`
      : `Series lookup finished. ${updatedLabel} ${progress.updated === 1 ? "was" : "were"} updated.`
  );
  render();
}

function bindEvents(): void {
  document.querySelectorAll<HTMLInputElement>("[data-cover-file]").forEach((input) => input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) void recogniseCover(file);
  }));
  document.querySelector<HTMLFormElement>("#cover-search-form")?.addEventListener("input", () => {
    if (!state.cover) return;
    const form = document.querySelector<HTMLFormElement>("#cover-search-form")!;
    const data = new FormData(form);
    state.cover.text = String(data.get("text") ?? "");
    state.cover.title = String(data.get("title") ?? "");
    state.cover.author = String(data.get("author") ?? "");
  });
  document.querySelector<HTMLFormElement>("#cover-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void findCoverMatches();
  });
  document.querySelectorAll<HTMLElement>("[data-cover-candidate]").forEach((element) => element.addEventListener("click", () => {
    const cover = state.cover;
    const candidate = cover?.candidates[Number(element.dataset.coverCandidate)];
    if (!cover || !candidate) return;
    const confirmed = { ...candidate, isbn13: cover.isbn };
    if (cover.origin === "checker") {
      stopCover();
      state.cover = undefined;
      state.fallbackIsbn = undefined;
      state.view = "checker";
      void evaluateCheckerCandidate(confirmed);
    } else openEditor(candidateToDraft(confirmed), "scan");
  }));
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach((element) => element.addEventListener("click", () => navigation(element.dataset.nav as View)));
  document.querySelector<HTMLFormElement>("#isbn-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = new FormData(event.currentTarget as HTMLFormElement).get("isbn");
    void beginLookup(String(input ?? ""));
  });
  document.querySelector<HTMLFormElement>("#checker-isbn-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = new FormData(event.currentTarget as HTMLFormElement).get("isbn");
    void beginCheckerLookup(String(input ?? ""));
  });
  document.querySelector<HTMLFormElement>("#book-form")?.addEventListener("submit", (event) => { event.preventDefault(); void submitBook(false); });
  document.querySelector<HTMLFormElement>("#book-form")?.addEventListener("input", queueDraftSave);
  document.querySelector<HTMLInputElement>("#collection-search")?.addEventListener("input", (event) => {
    state.query = (event.target as HTMLInputElement).value;
    render();
    const search = document.querySelector<HTMLInputElement>("#collection-search");
    search?.focus();
    search?.setSelectionRange(state.query.length, state.query.length);
  });
  document.querySelector<HTMLInputElement>("#backup-file")?.addEventListener("change", (event) => {
    void chooseBackup((event.currentTarget as HTMLInputElement).files?.[0]);
  });
  document.querySelector<HTMLInputElement>("#backup-acknowledgement")?.addEventListener("change", (event) => {
    state.backupAcknowledged = (event.currentTarget as HTMLInputElement).checked;
    render();
  });
  document.querySelectorAll<HTMLElement>("[data-group]").forEach((element) => element.addEventListener("click", () => {
    state.groupMode = element.dataset.group as GroupMode;
    render();
  }));
  document.querySelectorAll<HTMLElement>("[data-book]").forEach((element) => element.addEventListener("click", () => {
    const book = state.books.find((candidate) => candidate.id === element.dataset.book);
    if (book) openEditor(bookToDraft(book));
  }));
  document.querySelectorAll<HTMLElement>("[data-candidate]").forEach((element) => element.addEventListener("click", () => {
    const candidate = state.candidates[Number(element.dataset.candidate)];
    if (candidate) openEditor(candidateToDraft(candidate));
  }));
  document.querySelectorAll<HTMLElement>("[data-checker-candidate]").forEach((element) => element.addEventListener("click", () => {
    const candidate = state.checker.candidates[Number(element.dataset.checkerCandidate)];
    if (candidate) void evaluateCheckerCandidate(candidate);
  }));

  document.querySelectorAll<HTMLElement>("[data-action]").forEach((element) => element.addEventListener("click", () => {
    const action = element.dataset.action;
    if (action === "open-cover") openCover();
    if (action === "cover-photo") document.querySelector<HTMLInputElement>("#cover-camera")?.click();
    if (action === "cover-upload") document.querySelector<HTMLInputElement>("#cover-upload")?.click();
    if (action === "cancel-cover") {
      const origin = state.cover?.origin ?? "scan";
      navigation(origin);
    }
    if (action === "cover-manual") {
      const cover = state.cover;
      openEditor({ ...emptyDraft(cover?.isbn ?? state.fallbackIsbn), title: cover?.title ?? "", authors: cover?.author ? [cover.author] : [] }, cover?.origin ?? (state.view === "checker" ? "checker" : "scan"));
    }
    if (action === "start-camera") void startCamera();
    if (action === "open-checker") navigation("checker");
    if (action === "start-checker-camera") void startCamera("checker");
    if (action === "stop-camera") { stopScanner(); setMessage("info", "Scan cancelled."); render(); }
    if (action === "stop-checker-camera") { stopScanner(); setMessage("info", "Book Check cancelled."); render(); }
    if (action === "toggle-torch") void scannerSession?.setTorch(true).catch((error) => announceRuntimeMessage("warning", error instanceof Error ? error.message : String(error)));
    if (action === "check-another") { resetChecker(); state.message = undefined; void startCamera("checker"); }
    if (action === "add-checked-book" && state.checker.candidate) openEditor(candidateToDraft(state.checker.candidate), "checker");
    if (action === "add-without-isbn") openEditor(emptyDraft());
    if (action === "manual-from-ambiguous") openEditor(emptyDraft(state.candidates[0]?.isbn13));
    if (action === "recover-draft" && state.recoverableDraft) { openEditor(state.recoverableDraft); state.draftDirty = true; }
    if (action === "discard-recovery") void clearActiveDraft().then(() => { state.recoverableDraft = undefined; render(); });
    if (action === "close-editor") void closeEditor();
    if (action === "remove-cover" && state.draft) { state.draft.coverUrl = undefined; state.draftDirty = true; void saveActiveDraft(state.draft); render(); }
    if (action === "save-next") void submitBook(true);
    if (action === "delete-book") void deleteCurrentBook();
    if (action === "undo-delete" && state.deletedBook) void restoreBook(state.deletedBook).then(() => { window.clearTimeout(undoTimer); state.deletedBook = undefined; setMessage("success", "Book restored."); render(); });
    if (action === "clear-search") { state.query = ""; render(); }
    if (action === "apply-update") void state.updateAction?.();
    if (action === "install-app" && deferredInstall) void deferredInstall.prompt().then(() => { deferredInstall = undefined; render(); });
    if (action === "request-storage") void navigator.storage?.persist?.().then((granted) => { setMessage(granted ? "success" : "warning", granted ? "Persistent storage was granted on this device." : "Persistent storage was not granted. Keep a backup once export is available."); render(); });
    if (action === "export-backup") void exportCurrentCatalogue(false);
    if (action === "safety-export") void exportCurrentCatalogue(true);
    if (action === "replace-catalogue") void confirmReplacement();
    if (action === "backfill-series") void backfillMissingSeries();
    if (action === "cancel-series-backfill" && state.seriesBackfill?.running) {
      state.seriesBackfill.cancelRequested = true;
      render();
    }
    if (action === "reload-app") window.location.reload();
    if (action === "dismiss-backup-reminder") void setSetting("backup-reminder-dismissed", true).then(() => { state.backupReminderDismissed = true; render(); });
  }));
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event as BeforeInstallPromptEvent;
  if (state.view === "settings") render();
});
window.addEventListener("online", renderOutsideEditor);
window.addEventListener("offline", renderOutsideEditor);
document.addEventListener("visibilitychange", () => {
  const cameraInProgress = Boolean(scannerSession)
    || state.scanState === "starting"
    || state.scanState === "active"
    || state.checker.status === "starting"
    || state.checker.status === "active";
  if (document.hidden && cameraInProgress) {
    stopScanner();
    setMessage("info", "Camera stopped while the app was in the background.");
    render();
  }
});
window.addEventListener("bookscanner:database-updated", () => {
  stopScanner();
  cancelLookup();
  state.databaseUpdateRequired = true;
  setMessage("error", "Reload to continue. Unsaved form data has been preserved.");
  render();
});
window.addEventListener("bookscanner:database-blocked", () => {
  setMessage("warning", "Close other Book Scanner windows so the database update can finish.");
  render();
});

initialisePwa({
  onOfflineReady: () => { state.offlineReady = true; setMessage("success", "Book Scanner is ready to work offline."); renderOutsideEditor(); },
  onUpdateAvailable: (applyUpdate) => { state.updateAction = applyUpdate; renderOutsideEditor(); }
});

observeBooks((books) => {
  const previousBooks = new Map(state.books.map((book) => [book.id, book.updatedAt]));
  const catalogueChanged = books.length !== state.books.length
    || books.some((book) => previousBooks.get(book.id) !== book.updatedAt);
  state.books = books;
  if (catalogueChanged && state.view === "checker" && ["owned", "not-owned"].includes(state.checker.status)) {
    resetChecker();
    setMessage("info", "Your collection changed. Check the book again.");
  }
  renderOutsideEditor();
});

void loadActiveDraft().then((draft) => {
  if (!state.draft) state.recoverableDraft = draft;
  renderOutsideEditor();
});
void Promise.all([
  getSetting<string>("last-backup-prepared-at"),
  getSetting<boolean>("backup-reminder-dismissed")
]).then(([lastBackupPreparedAt, backupReminderDismissed]) => {
  state.lastBackupPreparedAt = lastBackupPreparedAt;
  state.backupReminderDismissed = Boolean(backupReminderDismissed);
  renderOutsideEditor();
});

render();
