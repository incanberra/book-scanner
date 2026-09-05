# Changelog

All notable changes to Book Scanner are documented in this file.

## Unreleased

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


