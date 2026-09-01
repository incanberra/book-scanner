# Book Scanner

A private, phone-first progressive web app for scanning ISBN barcodes and keeping a personal book catalogue on one device.

## Features

- Rear-camera ISBN scanning with ZXing and complete camera-track cleanup.
- Book Check scans an ISBN before purchase and tells you whether the same title is already in your collection, including another edition with the same title and author.
- Exact-edition Open Library lookup with timeout, caching, ambiguity handling, and manual fallback.
- Local IndexedDB catalogue using Dexie; no account, backend, analytics, or hosted database.
- Editable book details, multiple authors, series, reading state, favourites, search, and grouping.
- Duplicate-ISBN protection, durable unsaved drafts, deletion Undo, offline app shell, and install prompt.
- Mobile-first accessible interface and generated GitHub Pages deployment workflow.
- Versioned portable JSON export, strict import preview, mandatory safety copy, and atomic replacement rollback.
- Prompt-based PWA updates, blocked-client messaging, schema compatibility metadata, and v1 golden fixtures.
- Reliable camera shutdown and fresh catalogue checks when the app is backgrounded, another window changes the collection, or a lookup is cancelled.

## Local development

```powershell
npm install
npm run dev
```

Quality checks:

```powershell
npm test
npm run test:e2e
npm run typecheck
npm run build
```

## GitHub Pages

1. Push the repository to GitHub.
2. In **Settings → Pages**, select **GitHub Actions** as the source.
3. Push to `main` or `master`, or run the workflow manually.
4. Open the HTTPS Pages URL in Chrome on the target Android phone.
5. Use **Settings → Install app**, or Chrome’s **Add to Home screen** command.

The real-device spike must verify camera permission, rear-camera selection, barcode decode, Open Library lookup, cover fallback, offline reopen, and that the camera indicator turns off after success, cancellation, navigation, and backgrounding.
