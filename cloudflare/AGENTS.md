# cloudflare/

Cloudflare Workers deployment of this fork. The Worker runs the unchanged Vercel handlers from `api/` and is the production instance since 2026-10-02, because the Vercel account behind `github-readme-stats-three-psi-40.vercel.app` is disabled (every request answers 402 `DEPLOYMENT_DISABLED`). Vercel never reads this directory (`.vercelignore` lists it), and `vercel.json` plus `api/` still describe the Vercel build.

Production URL: `https://github-readme-stats.victor-long-cheng.workers.dev` (Cloudflare account `df09a764c02c8f903af0a0d02cc2aab7`, Worker `github-readme-stats`). There is no custom domain, so `wrangler.jsonc` keeps `workers_dev: true` (`preview_urls: false`). The profile README in `cl-victor1/cl-victor1` loads its cards from this URL.

## Files

- `worker.js`: Worker entry (`wrangler.jsonc` `main`). Redirects plain HTTP to HTTPS with 308 (as Vercel did; workers.dev has no zone setting for it). Routes `/api`, `/api/pin`, `/api/top-langs`, `/api/wakatime`, `/api/gist`, `/api/status/up` and `/api/status/pat-info` (trailing slash and `.js` suffix allowed, as on Vercel) to the handlers, redirects `/` with 308 to the upstream repository (the `vercel.json` redirect), and answers every other path with 404. Every HTTP method renders the card, as the Vercel handlers ignore the method; only GET and HEAD use the edge cache. It sets axios to its `fetch` adapter and sends `User-Agent: github-readme-stats` (the GitHub API answers 403 without one).
  - Edge cache (stands in for the Vercel content delivery network): a successful response with an `s-maxage` goes into `caches.default` for `s-maxage` plus `stale-while-revalidate` seconds. Inside `s-maxage` a request gets `x-worker-cache: HIT`. After it, the request gets the stale copy at once (`x-worker-cache: STALE`) and the Worker renders a fresh copy in `waitUntil`. Concurrent misses for one URL in one isolate share one render. A cold render takes 3 to 5 s, and GitHub's image proxy (Camo) times out after a few seconds, so the cache matters. The handler's own Cache-Control is restored on every cached answer.
- `worker-core.js`: input/output-free part of the entry (route table, Vercel-style `req.query`, the `res.setHeader`/`res.send` shim, the edge time-to-live parser). Tested by `tests/cloudflare-worker-core.test.js`.
- `module-shim.js`: replaces Node's `module` built-in (`wrangler.jsonc` `alias`). `src/cards/gist.js` and `src/cards/wakatime.js` read `src/common/languageColors.json` with `createRequire(import.meta.url)`, which cannot work on Workers; the shim serves the bundled JSON.

## Build and deploy

- `npm run cf:dry-run` bundles to `.wrangler/dry-run` (about 245 KiB, ASCII only, far below the 128 MB isolate). `npm run cf:dev` runs the Worker locally and reads variables from `.dev.vars` (ignored by git).
- Deploy with `npm run cf:deploy` from a copy of the repository without `.env*` or `.dev.vars` files (`cloudflare/assert-no-dotenv.mjs` refuses the deploy when the root holds one), with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exported. Wrangler does not bake `.env` values into a deploy, but a clean copy keeps local secrets out of the upload by construction.
- A push to git deploys nothing: no Workers Builds and no Vercel deployment are connected.

## Outside git

- Worker runtime variables, plain text (not Secrets), set through the Cloudflare API (`PATCH /accounts/<account>/workers/scripts/github-readme-stats/settings`, binding type `plain_text`); `keep_vars: true` keeps them across deploys. Today only `PAT_1`, a GitHub personal access token (the value from the Vercel production environment). Add `PAT_2`, `PAT_3` and so on for more rate limit, and optionally `WHITELIST`, `GIST_WHITELIST`, `EXCLUDE_REPO`, `CACHE_SECONDS`, `FETCH_MULTI_PAGE_STARS` (see the main readme). `nodejs_compat` copies them into `process.env` before the handler modules evaluate, which `src/common/retryer.js` needs (it counts `PAT_*` at load time). Never set `VERCEL_*` variables on the Worker.
- Check the token health at `/api/status/pat-info`.

## Rollback

Vercel restores nothing while its account is disabled, so fix forward. To take the Worker down: `npx wrangler delete github-readme-stats`, or set `workers_dev: false` and deploy. To point the profile README back to Vercel, revert commit `fd7c972` in `cl-victor1/cl-victor1`.

## Known differences from Vercel

- Vercel served the root files that `.vercelignore` did not exclude (for example `LICENSE`, `package.json`, `themes/`, `src/`) as static files; the Worker answers 404 for them. No README uses them.
- `/robots.txt` answers with the Cloudflare-managed robots.txt (content signals). Cloudflare serves it in front of the Worker on workers.dev; Vercel answered 404.
- Edge cache entries live per Cloudflare data center: the first request for a card in a data center still renders cold (3 to 5 s). There is no shared store (the API token cannot create KV namespaces).
- `src/fetchers/stats.js` logs only the message of a failed GitHub request, because the axios error object holds the Authorization header and Workers Logs persist.
- `/api/status/*` uses the same Cache API path, so `/api/status/up` is kept for 300 s, as its `s-maxage` asks.
