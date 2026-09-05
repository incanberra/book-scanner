# Book Scanner

A private, phone-first progressive web app for scanning ISBN barcodes and keeping a personal book catalogue on one device.

**[Open Book Scanner](https://incanberra.github.io/book-scanner/)**

## Features

- Rear-camera ISBN scanning with ZXing and complete camera-track cleanup.
- Book Check scans an ISBN before purchase and tells you whether the same title is already in your collection, including another edition with the same title and author.
- Front-cover photo fallback after an ISBN is not found, with on-device text recognition, editable search words/title/author, and explicit match confirmation.
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
- Catalogue data remains on the device. Only the decoded ISBN or cover-search words are sent to Open Library when identification is required. Cover photos are read locally and are not uploaded or saved. The cover reader downloads its OCR engine and English language data on first use.

## Front-cover fallback

When an ISBN cannot be identified, both Scan and Book Check offer **Scan front cover**.

1. Select **Take cover photo** (rear-camera capture on supported phones) or **Choose photo**.
2. The app reads English cover text locally with Tesseract.js and searches Open Library automatically.
3. Review the suggested titles and authors and select the matching book. Even a single result needs confirmation.
4. If needed, remove promotional text from the detected words or enter **Book title** and **Author** to refine the search. Unreadable photos, no matches, connection failures and cancellation all leave a manual route available.

A confirmed result retains the original scanned ISBN. Work-level cover search does not copy a different edition's ISBN, publisher or publication date, and does not create an exact-ISBN metadata cache entry. Cover artwork may represent another edition. Book Check still compares against the latest local catalogue and never saves automatically.

Cover recognition and catalogue coverage are imperfect, particularly for decorative lettering, glare and non-English covers. Confirm the title and author before continuing. No API key, account or backend is required.

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
npm run build
```

## GitHub Pages

1. Push the repository to GitHub.
2. In **Settings → Pages**, select **GitHub Actions** as the source.
3. Push to `main` or `master`, or run the workflow manually.
4. Open the HTTPS Pages URL in Chrome on the target Android phone.
5. Use **Settings → Install app**, or Chrome’s **Add to Home screen** command.

The real-device spike must verify camera permission, rear-camera selection, barcode decode, Open Library lookup, cover fallback, offline reopen, and that the camera indicator turns off after success, cancellation, navigation, and backgrounding.

