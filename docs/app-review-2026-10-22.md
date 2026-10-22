# Book Scanner app review

Reviewed 22 October 2026. Baseline: `1f9a175` on `main`. The live GitHub Pages app, repository source, automated tests, and an isolated local preview were inspected. Sample books in the preview are demonstration data, not the owner's catalogue.

## Assessment

Book Scanner has a useful foundation for a private personal library: local storage, offline access, duplicate checking, manual entry, book identification, and portable backups. The green and cream palette, book-like typography, and persistent bottom navigation are worth keeping. The largest immediate improvement is making the saved collection as useful as the scanner.

The current work improves that collection experience without changing the database schema or backup format. It also repairs two data-handling issues and updates vulnerable development dependencies. Camera hardware, lighting conditions, and installed Android PWA behaviour still need a physical-device check.

## Findings addressed

| Finding | Why it mattered | Change |
| --- | --- | --- |
| Every search input rebuilt the complete app and rebound its controls | Typing did unnecessary work, moved the caret to the end, and risked interrupting the mobile keyboard | Update only search results; retain the search element and use a single delegated listener for result actions |
| Filtering repeatedly normalised every book's text | Larger shelves did the same Unicode/string work on each keystroke | Cache search text per immutable catalogue snapshot; discard old snapshots through weak references |
| A large collection rendered every row, including repeated author entries | More layout work, HTML, and event listeners than needed for the visible shelf | Initially render 60 entries, then reveal 60 at a time |
| Grouping used a linear duplicate scan for each addition and calculated author labels for all modes | A group containing most of the shelf incurred quadratic membership work | Use sets for membership and compute author labels only for author grouping |
| Saved reading states and favourites had no corresponding filters | Users could see individual values but could not efficiently browse them | Combine reading-state and favourite filters with search; add recently added ordering and collection counts |
| Adding a book required returning to Scan | More navigation for manual catalogue maintenance | Add a direct Add book action on Collection; newly saved books become visible in Recently added |
| Opening and returning from a book lost useful browsing context | Working through a large shelf was cumbersome | Preserve query, filters, loaded entries, scroll position, and return focus |
| Author text was split on commas despite the form saying one per line | A name such as `Doe, Jane` became two authors after saving | Split only on line breaks; verify through a save-and-reopen test |
| Duplicate and capacity checks ran outside the write transaction | Simultaneous saves could pass stale checks and return a raw constraint error | Run checks and the write in one transaction; test simultaneous saves of the same ISBN |
| Several direct dependencies used `latest`; the locked tree had 11 audit findings | Installs were harder to maintain predictably and build/test tools had known vulnerabilities | Use bounded version ranges, patch within the existing tool major versions, and refresh compatible transitive dependencies; audit now reports zero findings |
| Browser tests reused any server on port 4173 | This review actually encountered another app on that port | Make the test port configurable, require the exact port, and refuse to reuse an unrelated server |

## Remaining priorities

### 1. Correct edition metadata before expanding catalogue automation

`classifyOpenLibraryResponse` in `src/metadata.ts` checks whether the requested ISBN appears in a search result, but then takes the first edition key, publisher, and publication date from separate arrays. Those values are not proven to belong to that ISBN. The exact-ISBN series request does not correct the other fields.

This is a source-level correctness finding, not a measured error rate in the owner's books. Open Library distinguishes work information from edition-specific publisher, ISBN, and cover information. The next change should populate edition fields from `/isbn/{isbn}.json`, resolve authors separately when necessary, and label uncertain work-level fallbacks. Add a fixture where a work has multiple editions with different publishers and dates. See the official [Search API](https://openlibrary.org/dev/docs/api/search) and [Works, Editions and ISBN documentation](https://openlibrary.org/dev/docs/api/books).

### 2. Put backup health where the user sees it

The backup reminder currently appears only in Settings. Once dismissed, it stays dismissed until an export resets the setting. A compact collection notice should show when a backup is overdue, offer an export action, and snooze for a defined period. Describe exports as prepared/downloaded rather than claiming that the file has safely been retained.

### 3. Add shelf location, tags, and personal notes

These are the highest-value additions for managing physical books: “Where is my copy?”, “Which books cover this topic?”, and “What did I think of it?”. Add a shelf/location field, reusable tags, and notes. Make them searchable, support a bulk location/tag action, and include them in JSON and CSV exports. Introduce a versioned migration and backwards-compatible backup reader; the current strict v1 format rejects unknown fields.

### 4. Track loans and wishlists separately from reading state

Reading, ownership, and availability are different concepts. A read book may be lent out; a wishlist book is not owned. Add borrower, loan date, and optional due date with a clear Returned action. Keep wishlist entries outside owned-book matching so Book Check never says a wanted book is already owned. If multiple physical copies matter, introduce copy records rather than removing ISBN uniqueness without a replacement model.

### 5. Make the book detail screen useful without editing

The row currently opens the complete editing form. A compact detail screen could show cover, title, author, series, location and notes, with direct reading/favourite actions and an explicit Edit details button. Place secondary bibliographic fields behind a disclosure. Consider a compact list/cover-grid toggle after testing the primary list with a real collection.

### 6. Improve import and multi-device workflows deliberately

JSON replacement is guarded and CSV export is already implemented. The next practical step is CSV import with column mapping, a duplicate preview, and an explicit merge policy. For phone/desktop use, design optional authenticated sync with conflict handling and deletion history before adding a hosted database. Preserve offline use and local export. These are separate projects, not additions to this patch.

## Code organisation and comments

`src/collection.ts` now owns the collection options, selection logic, and markup. `src/html.ts` centralises safe template escaping. The existing persistence, metadata lookup, camera, OCR, and backup boundaries remain in place. Comments explain the important invariants: why the input must stay mounted, why pagination counts author entries, why weak references are safe for catalogue snapshots, and why save checks need a transaction.

`src/main.ts` still coordinates too many concerns. Extract the scanner/checker controller, editor lifecycle, and settings/backup view in separate small changes, preserving their cancellation tests. Avoid a wholesale framework rewrite merely to reduce file length. Later, centralise shared limits and reading-status labels so validation, backups, and rendering cannot drift.

The catalogue still has a 2,000-book limit. Incremental rendering improves browsing inside that supported limit; it does not remove the limit or make all queries constant-time. Search still scans the catalogue, and grouping still sorts matches. After the user explicitly loads all entries, the DOM can again contain the full result set. No phone latency or battery-life improvement is claimed without measurement.

## Validation

- 89 unit tests pass, including combined filtering, ISBN variations, refreshed search snapshots, grouping, escaped markup, and simultaneous-save handling.
- All 52 browser scenarios passed across the full run and targeted reruns. The full run initially needed one existing Favourite selector made exact because the new filter introduced another matching label.
- All 28 affected app/collection scenarios pass after the new-book navigation adjustment.
- Production build, TypeScript checks, and five production-path OCR tests pass.
- Mobile accessibility checks include a 320-pixel viewport, zero reported Axe violations on the collection, and no horizontal overflow.
- Dependency audit reports zero known vulnerabilities after compatible updates.
- Visual inspection uses an isolated preview with sample books. Real-device camera acceptance, slow-network profiling, and personal catalogue content were not exercised.

The first practical release should contain these browsing and correctness improvements. The next focused release should address edition metadata and backup visibility, then add location/tags/notes with a tested format migration.
