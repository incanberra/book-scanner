# Live cover scanning

## Diagnosis of the previous feature

The deployed implementation behind PR #3 opened a file picker (`capture="environment"`) instead of an in-app live camera. It did not extract separate title/author values: both fields remained blank and the entire cleaned OCR string became the search query. Marketing text and OCR mistakes could therefore prevent a match.

A production-build reproduction at `/book-scanner/` deliberately blocked the English language-model download. The old code waited until its timeout and left one native worker alive afterwards. In Tesseract.js 7.0.0, a language-initialisation rejection can leave `createWorker()` unresolved; the app's worker reference was only assigned after that promise resolved. Its empty error handler and `worker?.terminate()` could neither report that failure promptly nor stop the uninitialised worker. The test shortened the existing 60-second timeout to three seconds. This reproduces a concrete defect; it does not establish which network or device condition triggered the user's original failure.

The previous testing exercised mocked UI flows and a synthetic cover with locally substituted CDN responses. That did not establish real phone behaviour or reliable cold-start loading.

## Implementation

- `cover-camera.ts` owns the rear-camera stream, releases late permission responses after cancellation, maps the guide through `object-fit: contain` letterboxing, and captures a bounded PNG frame. The camera stops as soon as that frame has been drawn.
- `cover.ts` synchronously owns a dedicated OCR host worker and its abort/timeout handlers. Terminating that worker terminates its nested Tesseract worker, including during startup. Startup errors return immediately through the host message channel.
- `cover-ocr.worker.ts` loads Tesseract, downsizes images to a maximum 2,000-pixel edge, honours image orientation, applies grayscale/contrast preprocessing, and requests automatic small-angle deskewing. It asks for OCR blocks/lines as well as raw text.
- `cover-text.ts` filters promotional lines and combines line position, height, confidence and name/byline patterns to suggest a title and author. These are heuristics, not an authoritative identification or a language-model judgement. Results are editable; confirmation is always required.
- Both fields, when present, are searched automatically through Open Library. Partial extraction provides an explicit title-only/author-only notice and a Search books button. If fields remain empty, edited useful OCR words can be searched instead.
- Confirmed work-level matches retain the scanned ISBN, do not import another edition's ISBN/publisher/year, and do not create an exact-ISBN cache entry. Book Check reads the latest local catalogue and never saves automatically.

## Assets and privacy

`npm run prepare:ocr` copies pinned Tesseract.js 7.0.0, core 7.0.0 and English data 1.0.0 from installed packages into generated `public/ocr/v1`. `predev` and `prebuild` run it automatically. Generated binaries are ignored by Git and included in the built site. The worker, core and traineddata paths all derive from Vite's base URL. There is no runtime OCR CDN dependency and no API key or backend.

OCR files download from the app's own origin on first use. The PWA caches requested versioned OCR assets, and Tesseract caches language data. This cache is best effort: first use and evicted caches need a connection. Open Library searches always need a connection. Bump the versioned asset directory/cache when changing OCR models or core versions.

Frames and uploaded images exist only in memory and are processed locally. They are not uploaded, added to the catalogue, saved as cover artwork, or included in backups. Only search words/title/author go to Open Library. Returned cover artwork may be from another edition.

## Automated validation

Run `npm test`, `npm run test:e2e`, `npm run typecheck` and `npm run test:production`.

The production command builds with `GITHUB_ACTIONS=true` and `GITHUB_REPOSITORY=incanberra/book-scanner`, then tests the preview at `/book-scanner/`. Tests use genuine HTMLVideoElement/MediaStream frames from a deterministic canvas camera. Real OCR tests do not mock recognition or OCR asset downloads and deny external OCR hosts. Portrait, landscape and slightly tilted frames must yield editable title/author fields, selectable candidates and the original ISBN. Failed model/worker downloads must report errors and leave no page workers alive. Development-mode real OCR is tested separately; explicit dependency optimisation prevents a first-use Vite reload.

Other browser tests mock only the OCR worker message boundary to exercise permission denial, pending permissions, cancellation, backgrounding, DOM replacement, navigation, repeat scans, offline search, missing matches, editor/Book Check behaviour and accessibility. These checks cannot establish physical focus, glare handling or hardware camera indicators.

## Physical Android checklist — not yet performed by the implementation agent

Use a modern Android Chrome browser on HTTPS and an installed PWA if applicable. Record phone model, Android/Chrome versions, book title/author/ISBN and outcomes. Do not clear site storage: it contains the catalogue. Use Settings → Export collection before any storage troubleshooting.

1. Open https://incanberra.github.io/book-scanner/ and accept **Update now** if offered. Confirm the new screen shows a live preview and **Read cover**, not **Take cover photo**.
2. With a real book whose valid ISBN produces no exact match, try both Scan and Book Check. Confirm **Scan front cover** appears and opens the rear camera after permission is granted.
3. Frame the cover upright in daylight without glare. Tap **Read cover**. Verify the hardware camera indicator turns off, progress appears, and the extracted title/author are editable. Confirm the candidate only if both match the book. Check the original ISBN in the editor before saving.
4. Repeat with a book already owned in another edition. Verify Book Check reports Already owned and the catalogue count does not increase. Try an unowned title and confirm adding still requires an explicit save.
5. Try portrait/landscape orientation, slight tilt, decorative lettering, a dark cover, a blurry image, and a cover containing review quotes. Record wrong suggestions; do not treat guessed fields as confirmed facts.
6. Cancel while permission is pending, cancel while the preview is live, navigate away, lock the phone/background Chrome, and interrupt OCR startup. Verify camera indicators turn off and late results do not replace the destination screen. Restart and scan a different cover.
7. Deny camera permission. Verify retry, Choose image instead, editable fields and manual entry remain available. Restore permission and retry.
8. Test a slow connection/first OCR use and then a warm repeat. Temporarily go offline: the reader may work if cached, but search must explain that it needs a connection. Manual entry must retain the scanned ISBN.
9. Confirm no horizontal scrolling and that preview controls, progress, candidates and manual fields remain reachable in both browser and installed-PWA modes.

Known limits: English OCR, decorative type, glare, low contrast, substantial rotation, ambiguous author/title layouts, and incomplete Open Library coverage. Manual correction and candidate confirmation are part of the feature. Physical-device acceptance remains open until someone runs this checklist.
