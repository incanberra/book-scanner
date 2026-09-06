# Book Scanner

A private, phone-first progressive web app for scanning ISBN barcodes and keeping a personal book catalogue on one device.

**[Open Book Scanner](https://incanberra.github.io/book-scanner/)**

## Features

- Rear-camera ISBN scanning with ZXing and complete camera-track cleanup.
- Book Check scans an ISBN before purchase and tells you whether the same title is already in your collection, including another edition with the same title and author.
- Live rear-camera cover scanning after an ISBN is not found, with on-device OCR, suggested editable title/author fields, and explicit match confirmation.
- Exact-edition Open Library lookup with timeout, caching, ambiguity handling, and manual fallback.
- Local IndexedDB catalogue using Dexie; no account, backend, analytics, or hosted database.
- Editable book details, multiple authors, series, reading state, favourites, search, and grouping.
- Duplicate-ISBN protection, durable unsaved drafts, deletion Undo, offline app shell, and install prompt.
- Mobile-first accessible interface and generated GitHub Pages deployment workflow.
- Versioned portable JSON export, strict import preview, mandatory safety copy, and atomic replacement rollback.
- Prompt-based PWA updates, blocked-client messaging, schema compatibility metadata, and v1 golden fixtures.
- Reliable camera shutdown and fresh catalogue checks when the app is backgrounded, another window changes the collection, or a lookup is cancelled.

## Book Check

Book Check lets you scan a book while shopping to see whether you already own the same title. It checks without adding or changing anything in your catalogue.

1. Open **Scan**, then select **Book Check**.
2. Scan the ISBN barcode with the rear camera, or enter the ISBN manually.
3. Book Scanner displays one of three results:
   - **Already owned** — the exact ISBN is saved, or another edition has the same normalised title and at least one matching author.
   - **Not in your collection** — the book was identified but no saved match was found. Select **Add book** to review its details before saving.
   - **Unable to check** — the phone is offline without an exact ISBN match, the ISBN could not be identified, author information is missing, or the lookup failed.
4. Select **Check another book** to restart the camera without returning to the main Scan screen.

If a lookup returns several possible editions, Book Check asks you to choose the correct edition before comparing it with your collection.

### Matching rules

- Exact ISBN matches are checked locally first and work offline.
- Different editions require an online Open Library lookup, an exact title match after ignoring case, accents, punctuation, and extra spaces, and at least one matching author.
- Matching is deliberately not fuzzy and never uses title alone, reducing the chance of incorrectly saying that an unrelated book is owned.
- A check never saves a book. The catalogue changes only after you choose **Add book** and successfully submit the existing book form.

### Reliability and privacy

- Every ownership decision reads the latest catalogue from IndexedDB rather than relying on an older screen snapshot.
- If another Book Scanner window changes the catalogue, an existing result is cleared and the book must be checked again.
- Pending and active camera sessions stop when you cancel, navigate away, or put the app in the background.
- Catalogue data remains on the device. ISBNs and cover-search words are sent to Open Library when identification is required. Default local OCR does not upload images and downloads its engine and English data from this app. Optional AI mode sends cover images through Netlify to OpenRouter and the selected Qwen provider; its API key remains on the server.

## Live front-cover scanning

When an ISBN cannot be identified, both Scan and Book Check offer **Scan front cover**.

1. Allow camera access. The rear-camera preview opens inside the app.
2. Hold the cover inside the guide, keep the title and author visible, avoid glare and tap **Read cover**. The camera stops once the frame is captured.
3. The app reads the frame locally, suggests a title and author and searches Open Library. Review and correct the editable fields if needed. If only one field is recognised, the app explains the limited search.
4. Select **Use this book** only when both the title and author match your cover. The original scanned ISBN is retained. Book Check compares the confirmed title and author with the latest saved catalogue and never saves automatically.

**Choose image instead**, camera retry and manual entry remain available for permission errors, unreadable covers or failed searches. Cancelling, navigating away or backgrounding the app stops cover scanning. Camera access requires HTTPS or localhost and a supported browser; modern Android Chrome is the primary target.

Local OCR files are served with the app and downloaded on first use. Cached files may allow later offline reading, but book searches require a connection. In local mode, images remain on-device and are not uploaded or saved. Optional AI mode uploads the selected frame. Recognition and title/author suggestions can be wrong. Work-level artwork can show a different edition; unrelated edition ISBNs, publishers and dates are not copied.

See [implementation diagnosis, validation and the Android phone checklist](docs/live-cover-scanning.md). The automated tests include genuine OCR on synthetic camera frames; physical phone acceptance still needs that checklist.

## Using the hosted app

Open [incanberra.github.io/book-scanner](https://incanberra.github.io/book-scanner/) on the phone that will hold the catalogue. Allow rear-camera access when prompted. The app can then be installed from the browser's **Add to Home Screen** or install command.

Because the catalogue is stored only in that browser on that device, periodically use **Settings → Export collection** and retain the backup file somewhere outside browser storage.

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
npm run test:production
```

## GitHub Pages

1. Push the repository to GitHub.
2. In **Settings → Pages**, select **GitHub Actions** as the source.
3. Push to `main` or `master`, or run the workflow manually.
4. Open the HTTPS Pages URL in Chrome on the target Android phone.
5. Use **Settings → Install app**, or Chrome’s **Add to Home screen** command.

The real-device spike must verify camera permission, rear-camera selection, barcode decode, Open Library lookup, cover fallback, offline reopen, and that the camera indicator turns off after success, cancellation, navigation, and backgrounding.
# Optional AI cover reading

Use Qwen through a secure Netlify function instead of local OCR. See [Netlify/OpenRouter setup](docs/netlify-openrouter.md). The OpenRouter key stays server-side. The service address is built in; enter the separate scanner token once and the device remembers it across reloads. Cover images leave the device only when AI scanning is enabled. Local OCR remains available.
