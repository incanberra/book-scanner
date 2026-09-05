# Enable Qwen cover scanning with Netlify

The public app can remain at https://incanberra.github.io/book-scanner/.
Netlify hosts the private-key proxy at `/.netlify/functions/read-cover`.
No OpenRouter key belongs in GitHub, a VITE_ variable, the browser, or chat.

## Setup

1. Import `incanberra/book-scanner` from GitHub into a new Netlify project. Use the branch containing this integration. `netlify.toml` supplies build command `npm run build`, publish directory `dist`, and functions directory `netlify/functions`. Use Node 24 or newer. This does not move or erase the GitHub Pages catalogue.
2. In Netlify project environment variables, create these values with Functions scope (or all scopes if the plan does not offer scope selection):

   | Name | Value |
   | --- | --- |
   | `OPENROUTER_API_KEY` | A dedicated OpenRouter key with a small credit limit |
   | `COVER_ACCESS_TOKEN` | A separate random 64-character hexadecimal secret generated in your password manager; save it privately |
   | `COVER_ALLOWED_ORIGIN` | `https://incanberra.github.io` (no path or trailing slash) |

3. Deploy/redeploy after setting those values. Confirm the `read-cover` function is deployed. The model is fixed to `qwen/qwen3.7-flash` in server code; clients cannot choose a different model or prompt.
4. Ensure the frontend integration is deployed to GitHub Pages too. Open Book Scanner there, go to Settings → AI cover scanning. Enter `https://YOUR-SITE.netlify.app/.netlify/functions/read-cover` and your **scanner access token**, not your OpenRouter key. Select Enable AI for this session.
5. Try a failed ISBN lookup → Scan front cover → Read cover. Review the title/author and select the book. The scanned ISBN is retained.

The endpoint is remembered. The access token stays in memory and must be re-entered after reload. Anyone holding that token can use this restricted scanner endpoint and spend your credits: do not share it publicly. Rotate it in Netlify and redeploy if exposed. Disable AI with Use local OCR instead in Settings.

## Security, billing and privacy

- Netlify platform rate limiting is configured for 20 requests per minute per domain/IP combination, including preflight requests. Verify enforcement in the deployed project; it is not simulated by local unit tests. This is not a global budget cap. Set a dedicated key credit limit in OpenRouter and review Netlify usage too.
- CORS only allows the configured origin; it is NOT authentication. The separate random bearer token is required even for clients that spoof Origin.
- Only JPEG/PNG/WebP uploads up to 3 MiB are accepted. The browser resizes to a maximum 1600-pixel edge and converts to JPEG. The function fixes the prompt/model, limits completion tokens, and does not expose arbitrary proxy requests.
- Requests time out, errors are sanitized, and responses are no-store. This code does not persist or log images, tokens or model responses. Netlify, OpenRouter and the selected model provider process the image; their service policies still apply. No zero-retention guarantee is implied.
- One provider request per explicit scan; no automatic paid retries. Cancelling prevents stale UI results, but an already-submitted provider request may still be billed.
- AI is opt-in. Local OCR remains the default until configured and can be restored in Settings. AI failure leaves manual fields available; it does not silently retry through another paid model.

## Verification before relying on it

Automated tests mock OpenRouter: they validate authentication, origin checks, payload limits, response validation and the browser integration, not recognition accuracy. Real provider calls require the privately configured key and deployed endpoint.

On the deployed function verify: wrong token → 401; disallowed origin → 403; missing server settings → 503; oversized image → 413; repeated requests → rate limiting. None of these rejected requests should reach OpenRouter. Never put secrets into URLs or copy them into test logs.

Test five or more real covers (including stylised type, glare and a cover the local OCR misreads). Verify readable title/author results, deliberate unknowns, no invented ISBN, cancellation, expiry/reload unlock, offline failure, Book Check, and local fallback. Check OpenRouter request costs and Netlify usage. Image capability does not guarantee accurate book identification.

References: [Netlify Functions API](https://docs.netlify.com/build/functions/api/), [OpenRouter model](https://openrouter.ai/qwen/qwen3.7-flash), [API authentication](https://openrouter.ai/docs/api_reference/authentication).
