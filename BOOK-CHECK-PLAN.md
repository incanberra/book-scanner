# Book Check feature plan

Status: Approved for implementation  
Verified against the codebase: 2026-08-31

## Context

Book Check will let the sole user scan a book while shopping and determine whether the local catalogue already contains that title. It must recognize both the exact ISBN and another edition of the same title, without weakening the app's local-first, single-user, no-backend design.

Today, the normal add-book scan performs an exact-ISBN duplicate check and opens the saved record when it finds one. It does not provide a check-only result, and it cannot recognize a different ISBN for the same title and author.

Success is observable: one scan produces a truthful `Already owned`, `Not in your collection`, or `Unable to check` result, and checking never changes the catalogue unless the user explicitly completes the existing save form.

## Current state

| Component | Existing behaviour | Reuse for Book Check |
|---|---|---|
| `src/scanner.ts:16` | Rear-camera scanner returns one normalized ISBN and stops | Reuse unchanged |
| `src/main.ts:172` | Scan screen provides camera scanning and manual ISBN fallback | Reuse its camera, fallback, and lifecycle patterns |
| `src/main.ts:394` | Add-book lookup checks exact ISBN before querying Open Library | Split check-only behaviour from add-book behaviour |
| `src/metadata.ts:211` | Open Library lookup returns matched, ambiguous, not-found, offline, cancelled, or failed results | Reuse unchanged |
| `src/catalog.ts:125` | `normaliseKey()` removes case, accent, punctuation, and whitespace differences | Reuse for title and author comparison |
| `src/catalog.ts:217` | Saved books already contain normalized `authorKeys` | Reuse without a schema migration |

Baseline before implementation: 33 unit tests and 11 Playwright browser tests.

## Proposed change

Add a prominent **Book Check** option to the existing Scan screen. It opens a dedicated check-only screen while keeping the three-item bottom navigation unchanged.

```text
Scan screen -> Book Check -> Scan ISBN
                              |
                              +-> exact local ISBN ----------------> Already owned
                              |
                              +-> offline, no exact ISBN ----------> Unable to check
                              |
                              +-> Open Library lookup
                                    |
                                    +-> ambiguous -> choose edition
                                    +-> title + author local match -> Already owned
                                    +-> identified, no match ------> Not in your collection
                                    +-> unidentified/failed --------> Unable to check
```

## User experience

### Entry

- Keep the existing `Scan a book` action unchanged.
- Add a second prominent action labelled `Book Check` on the Scan screen.
- Book Check is not a fourth bottom-navigation item.
- The Book Check screen uses the existing rear-camera presentation, torch handling, cancel behaviour, and manual ISBN fallback.

### Already owned

- Display only `Already owned` as the result information.
- Display `Check another book`.
- Selecting it clears the result and immediately restarts the camera.
- Do not open the saved record and do not write to IndexedDB.

### Not in your collection

- Display `Not in your collection`.
- Display `Add book` and `Check another book`.
- `Add book` opens the existing editor with lookup metadata pre-filled.
- Nothing is saved until the existing save operation succeeds.
- The editor's existing `Save and scan another` action returns to Book Check and restarts its camera when the editor was opened from Book Check.

### Unable to check

- Use this outcome when the phone is offline without an exact local ISBN match, Open Library cannot identify the ISBN, metadata has no usable author, or the lookup fails.
- Display a short reason and `Check a different book`.
- Selecting it clears the result and immediately restarts the camera.
- Do not claim the book is unowned and do not offer manual addition from this result.

### Ambiguous lookup

- Reuse the existing edition-selection presentation.
- Run ownership matching only after the user selects an edition.
- `None of these` is not shown in Book Check because an unidentified book must use the unable-to-check result rather than manual addition.

## Matching contract

Add a pure catalogue helper with this shape:

```ts
interface OwnershipCandidate {
  isbn13: string;
  title?: string;
  authors?: string[];
}

function findOwnedBookMatch(
  books: readonly Book[],
  candidate: OwnershipCandidate
): Book | undefined;
```

The function must apply these rules in order:

1. Return a book with an exact `isbn13` match, without requiring title or author metadata.
2. If title or all authors are missing, return no match.
3. Normalize the candidate title with `normaliseKey()`.
4. Require exact equality with `normaliseKey(savedBook.title)`.
5. Normalize every candidate author and require at least one value to exist in `savedBook.authorKeys`.
6. Return the first matching saved book; callers only need the boolean ownership outcome.

Subtitles, publisher, publication date, cover, format, series, and series number do not participate. Matching is intentionally not fuzzy: false `Already owned` results are worse than an unable-to-check result.

## Application state and control flow

- Extend `View` with `checker`; keep the Scan bottom-navigation item current while `checker` is active.
- Add checker-specific state rather than reusing editor draft state:

```ts
type CheckerStatus =
  | "ready"
  | "starting"
  | "active"
  | "lookup"
  | "ambiguous"
  | "owned"
  | "not-owned"
  | "unable";

interface CheckerState {
  status: CheckerStatus;
  candidate?: MetadataCandidate;
  candidates: MetadataCandidate[];
  reason?: "offline" | "not-found" | "missing-author" | "failed";
}
```

- Keep the current add-book `beginLookup()` behaviour unchanged.
- Add a separate Book Check lookup controller so a check can never accidentally open the editor or save a draft.
- Exact ISBN comparison happens before any network request.
- When no exact match exists, check `navigator.onLine` before metadata lookup. Do not use cached metadata to claim a different-edition match while offline.
- Continue using the existing lookup cancellation sequence so navigation or a second request cannot render stale results.
- `Check another book` resets only checker state, then calls the existing camera-start path.
- Track editor origin as `scan | checker | collection`. This makes `Save and scan another` return to the correct scanning mode without changing normal add-book behaviour.

## Failure and concurrency rules

- Invalid non-book barcodes retain the existing scanner warning and keep scanning.
- Repeated scan callbacks after the first decoded ISBN remain ignored by `scanner.ts`.
- A cancelled or superseded lookup renders no result.
- A network timeout, HTTP error, rate limit, missing exact Open Library record, or missing author produces `Unable to check`.
- Backgrounding, navigation, and app-update events stop the camera and cancel the lookup as they do today.
- Live catalogue updates are reflected before the next comparison through the existing `observeBooks()` state.
- Repeated `Add book` taps remain protected by the existing save lock.

## Implementation sequence

1. Add and unit-test the pure ownership matcher.
2. Add checker state and check-only lookup orchestration.
3. Add Book Check entry, camera/ISBN screen, results, and edition selection.
4. Preserve the editor origin through add and save-another flows.
5. Add browser regression coverage and run the full release checks.

The matcher comes first because every UI outcome depends on its exact contract. The UI follows only after check-only orchestration is separated from the existing mutation path.

## Acceptance criteria

1. The Scan screen contains a prominent `Book Check` action without adding a fourth bottom-navigation item.
2. Book Check accepts a camera-scanned ISBN and the same manual ISBN fallback as the normal scan screen.
3. An exact saved ISBN reports `Already owned`, including while offline.
4. A different ISBN reports `Already owned` only when normalized title equality and at least one normalized author match both succeed.
5. The same normalized title with a different author reports `Not in your collection`.
6. Different punctuation, case, accents, or spacing in an otherwise equal title and author still match.
7. An identified unmatched book reports `Not in your collection` and offers `Add book` and `Check another book`.
8. `Add book` opens the existing editor with metadata pre-filled and performs no save before user confirmation.
9. `Save and scan another`, when entered from Book Check, returns to Book Check and starts another camera scan.
10. Offline checks without an exact ISBN match report `Unable to check while offline`.
11. Not-found, failed, rate-limited, timed-out, or authorless lookups report `Unable to check` and never report `Not in your collection`.
12. Ambiguous metadata requires edition selection before ownership comparison.
13. `Check another book` and `Check a different book` clear the old result and immediately restart the camera.
14. Checking alone creates no book, active draft, or setting write. Existing Open Library lookup-cache writes remain allowed and never alter the catalogue.
15. Existing add-book scanning, saving, catalogue browsing, series lookup, backup/restore, and offline saved-book access continue to pass their tests.

## Testing plan

| Layer | Coverage | Added count |
|---|---|---:|
| Unit | Exact ISBN; title/author edition match; punctuation/case normalization; same title/different author; missing author; unmatched candidate | 6 |
| Browser | Entry and reset; exact owned; different-edition owned; unowned add flow; offline unable; ambiguous selection; lookup failure unable | 7 |
| Existing regression | Full Vitest, full Playwright, TypeScript check, production PWA build | 44 existing tests |

Browser tests may use the manual ISBN fallback with mocked Open Library responses; camera decoding remains covered by the existing scanner unit tests.

## Files reference

| File | Change |
|---|---|
| `src/catalog.ts` | Add `OwnershipCandidate` and `findOwnedBookMatch()` |
| `src/main.ts` | Add checker view/state, check-only lookup, result actions, editor-origin return, and rendering |
| `src/styles.css` | Add Book Check entry and result styling using existing design tokens |
| `tests/catalog.test.ts` | Add six matcher tests |
| `tests/e2e/app.spec.ts` | Add seven Book Check journeys and retain accessibility checks |

No change is planned for `src/metadata.ts`, `src/scanner.ts`, the Dexie schema, backup format, PWA manifest, deployment workflow, or external services.

## Do not touch

- Exact ISBN validation and ISBN-10 to ISBN-13 conversion.
- Existing add-book duplicate behaviour.
- Open Library request rate limiting, timeout, cache, and cancellation semantics.
- The books table and portable backup format.
- The save reliability lock and atomic mutation fixes.

## Out of scope

- Fuzzy or approximate title matching.
- Matching by title without a matching author.
- Cover-image recognition.
- Check history, wish lists, shopping lists, pricing, or store integration.
- Cloud catalogue access, accounts, or multi-device synchronization.
- Automatically combining or editing existing catalogue records.
- A fourth bottom-navigation item.

## Rollback

Revert the feature commit. No migration or persisted checker state exists, so rollback cannot alter or delete catalogue data.

## Effort estimate

| Work | Estimate |
|---|---:|
| Matcher and unit tests | 1–2 hours |
| Checker state, lookup orchestration, and result UI | 3–4 hours |
| Editor-origin return behaviour | 1 hour |
| Browser tests, accessibility check, and release verification | 2–3 hours |
| Total | One focused development day |

The number of prevented duplicate purchases cannot be measured inside this local-only app without adding tracking, which is intentionally out of scope.
