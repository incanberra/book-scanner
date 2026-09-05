# Changelog

All notable changes to Book Scanner are documented in this file.

## Unreleased

### Live cover scanner replacement

- Replace the photo-first interaction with an in-app rear-camera preview, guide and Read cover button in both scan modes.
- Capture and preprocess frames locally; suggest separate editable title/author fields from OCR layout and confidence.
- Serve pinned OCR worker/core/language assets with the app at root and GitHub Pages subpaths.
- Terminate OCR workers even during failed startup, and stop camera tracks on capture, cancellation, navigation, backgrounding and late permission responses.
- Add real development/production OCR checks, failed-asset checks, camera lifecycle tests and an Android acceptance checklist.


### Added

- Offer front-cover scanning when ISBN identification finds no match in Scan and Book Check.
- Read cover text locally, search Open Library, and require title/author confirmation while retaining the scanned ISBN.
- Allow photo selection, corrected title/author searches, retries, cancellation and manual entry.
- Add regression coverage for fallback search, edition safety, Book Check, cancellation and mobile accessibility.

## [0.2.0.0] - 2026-09-01

### Added

- Check a scanned or manually entered ISBN against the local collection before buying a book.
- Recognise another edition as owned when its normalised title and author match a saved book.
- Add a book directly from a “Not in your collection” result, then return to Book Check after saving.
- Show clear offline, unidentified, ambiguous, and unavailable lookup results without changing the catalogue.

### Fixed

- Stop pending and active camera sessions safely when checking is cancelled, the app is backgrounded, or navigation changes.
- Keep the live camera preview attached during background catalogue and connectivity updates.
- Read the latest IndexedDB catalogue for each ownership decision and invalidate stale results after cross-window changes.


