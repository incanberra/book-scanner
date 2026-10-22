import { filterBooks, groupBooks, type Book, type BookGroup, type GroupMode, type ReadingStatus } from "./catalog";
import { escapeHtml } from "./html";

export const PAGE_SIZE = 60;
export type CollectionOrder = GroupMode | "recent";
export interface CollectionOptions {
  query: string;
  order: CollectionOrder;
  status: ReadingStatus | "all";
  favouritesOnly: boolean;
  visibleCount: number;
}

export const readingLabels: Record<ReadingStatus, string> = {
  unread: "Unread", reading: "Reading", read: "Read", abandoned: "Abandoned"
};

/** Filter before grouping so counts refer to books, including co-authored books. */
export function selectCollection(books: Book[], options: CollectionOptions) {
  const filtered = filterBooks(books, options.query).filter(book =>
    (options.status === "all" || book.readingStatus === options.status)
    && (!options.favouritesOnly || book.favourite)
  );
  const groups: BookGroup[] = options.order === "recent"
    ? [{ key: "recent", label: "Recently added", books: [...filtered].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)) }]
    : groupBooks(filtered, options.order);

  // Bound the DOM by rows, not unique books: one book can appear under several authors.
  let remaining = options.visibleCount;
  const visibleGroups = groups.flatMap(group => {
    const visible = group.books.slice(0, Math.max(0, remaining));
    remaining -= visible.length;
    return visible.length ? [{ ...group, books: visible, totalCount: group.books.length }] : [];
  });
  const totalRows = groups.reduce((count, group) => count + group.books.length, 0);
  return { filtered, groups: visibleGroups, totalRows, shownRows: options.visibleCount - remaining };
}

function bookRow(book: Book): string {
  return `<button class="book-row" data-book="${escapeHtml(book.id)}">
    <span class="mini-cover" aria-hidden="true">${book.coverUrl ? `<img src="${escapeHtml(book.coverUrl)}" alt="" loading="lazy" decoding="async" width="46" height="66" referrerpolicy="no-referrer" />` : "▥"}</span>
    <span class="book-row__body"><strong>${escapeHtml(book.title)}</strong><small>${escapeHtml(book.authors.join(", "))}</small>${book.seriesName ? `<small>${escapeHtml(book.seriesName)}${book.seriesNumber ? ` · ${escapeHtml(book.seriesNumber)}` : ""}</small>` : ""}</span>
    <span class="book-row__meta"><span class="status-dot status-dot--${book.readingStatus}">${escapeHtml(book.readingStatus)}</span>${book.favourite ? `<span class="star" aria-label="Favourite">★</span>` : ""}</span>
  </button>`;
}

export function collectionResults(books: Book[], options: CollectionOptions): string {
  const { filtered, groups, totalRows, shownRows } = selectCollection(books, options);
  const summary = `${filtered.length} of ${books.length} books`;
  const empty = !books.length
    ? `<section class="empty-state"><span aria-hidden="true">▥</span><h2>Your shelf is empty</h2><p>Scan a book or add its details to start your collection.</p><button class="button" data-collection-action="scan">Scan a book</button></section>`
    : !filtered.length
      ? `<section class="empty-state"><h2>No books match</h2><p>Try fewer search words or clear your filters.</p><button class="text-button" data-collection-action="reset">Clear search and filters</button></section>`
      : groups.map(group => `<section class="book-group"><h2>${escapeHtml(group.label)} <span>${group.totalCount}</span></h2><div class="book-list">${group.books.map(bookRow).join("")}</div></section>`).join("");
  return `<p class="collection-summary" role="status" aria-live="polite" aria-atomic="true">${summary}${shownRows < totalRows ? ` · Showing ${shownRows} of ${totalRows} entries` : ""}</p>
    ${empty}
    ${shownRows < totalRows ? `<button class="button button--secondary button--wide" data-collection-action="more">Show more books</button>` : ""}`;
}

export function collectionContent(books: Book[], options: CollectionOptions): string {
  const counts = { unread: 0, reading: 0, read: 0, abandoned: 0 };
  books.forEach(book => { counts[book.readingStatus] += 1; });
  return `<main id="main-content" class="content collection-content">
    <div class="collection-toolbar"><p>Your books, at a glance.</p><button class="button button--small" data-collection-action="add">Add book</button></div>
    <div class="shelf-summary" aria-label="Collection overview">
      <span><strong>${counts.unread}</strong> to read</span><span><strong>${counts.reading}</strong> reading</span><span><strong>${counts.read}</strong> finished</span>
    </div>
    <label class="search-box"><span class="sr-only">Search collection</span><span aria-hidden="true">⌕</span><input type="search" id="collection-search" value="${escapeHtml(options.query)}" placeholder="Title, author, series or ISBN" /></label>
    <div class="collection-filters">
      <label class="field"><span>Reading filter</span><select id="collection-status"><option value="all">All reading states</option>${Object.entries(readingLabels).map(([value, label]) => `<option value="${value}" ${options.status === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label class="field"><span>Browse by</span><select id="collection-order">${Object.entries({ title: "Title A–Z", author: "Author", series: "Series order", status: "Reading status", recent: "Recently added" }).map(([value, label]) => `<option value="${value}" ${options.order === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    </div>
    <div class="collection-filter-actions"><label class="check-field"><input id="collection-favourites" type="checkbox" ${options.favouritesOnly ? "checked" : ""} />Favourites only</label><button class="text-button" data-collection-action="reset">Clear filters</button></div>
    <div id="collection-results">${collectionResults(books, options)}</div>
  </main>`;
}
