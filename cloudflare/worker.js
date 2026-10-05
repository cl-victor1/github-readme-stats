// @ts-check

/**
 * @file Cloudflare Worker entry (named by `wrangler.jsonc` `main`).
 *
 * Runs the unchanged Vercel handlers from `api/` on Workers. Vercel never
 * reads this directory. Runtime variables (`PAT_1`, optional `WHITELIST`,
 * `CACHE_SECONDS`, ...) are plain-text Worker variables; `nodejs_compat`
 * exposes them on `process.env` before the handler modules load, which the
 * module-level reads in `src/common/retryer.js` and `src/common/envs.js` need.
 */

import axios from "axios";
import statsCard from "../api/index.js";
import repoCard from "../api/pin.js";
import langCard from "../api/top-langs.js";
import wakatimeCard from "../api/wakatime.js";
import gistCard from "../api/gist.js";
import statusUp from "../api/status/up.js";
import patInfo from "../api/status/pat-info.js";
import {
  ORIGIN_CACHE_CONTROL,
  ROBOTS_TXT,
  ROOT_REDIRECT,
  createResponseShim,
  edgeTtl,
  resolveRoute,
  staleTtl,
  toQuery,
} from "./worker-core.js";

// Workers have no XMLHttpRequest and no Node http client; use axios' fetch adapter.
axios.defaults.adapter = "fetch";
// The GitHub API answers 403 to requests without a User-Agent. Node's axios
// http adapter sends "axios/<version>"; Workers fetch sends none.
axios.defaults.headers.common["User-Agent"] = "github-readme-stats";

/** @type {Record<string, (req: any, res: any) => Promise<any>>} */
const HANDLERS = {
  index: statsCard,
  pin: repoCard,
  "top-langs": langCard,
  wakatime: wakatimeCard,
  gist: gistCard,
  "status/up": statusUp,
  "status/pat-info": patInfo,
};

/** Cached copy header: when the copy was stored (epoch milliseconds). */
const STORED_AT = "x-worker-stored-at";
/** Cached copy header: how many seconds the copy stays fresh. */
const FRESH_TTL = "x-worker-fresh-ttl";

/**
 * Renders in flight in this isolate, keyed by URL, so concurrent misses for
 * the same card share one render instead of each calling the GitHub API.
 *
 * The promises carry plain data, not Response objects: a Workers stream body
 * belongs to the request that created it and cannot be read by another one.
 *
 * @typedef {{ status: number, headers: [string, string][], body: string }} Rendered
 * @type {Map<string, Promise<Rendered>>}
 */
const inflight = new Map();

/**
 * Runs the handler for one route.
 *
 * @param {string} route Handler name.
 * @param {URL} url Request URL.
 * @param {Request} request Incoming request.
 * @returns {Promise<Rendered>} Rendered status, headers and body.
 */
const render = async (route, url, request) => {
  const { res, toResponse } = createResponseShim();
  const req = {
    method: request.method,
    url: url.pathname + url.search,
    query: toQuery(url.searchParams),
    headers: Object.fromEntries(request.headers),
  };
  try {
    await HANDLERS[route](req, res);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "handler failed");
    return { status: 500, headers: [], body: "Internal Server Error" };
  }
  const response = toResponse("GET");
  return {
    status: response.status,
    headers: [...response.headers],
    body: await response.text(),
  };
};

/**
 * Builds a new Response from rendered data.
 *
 * @param {Rendered} rendered Rendered status, headers and body.
 * @returns {Response} Response.
 */
const toFetchResponse = (rendered) =>
  new Response(rendered.body, {
    status: rendered.status,
    headers: rendered.headers,
  });

/**
 * Stores a rendered response in the edge cache for its `s-maxage` plus its
 * `stale-while-revalidate` window.
 *
 * @param {Cache} cache Edge cache.
 * @param {Request} cacheKey Cache key.
 * @param {Rendered} rendered Rendered status, headers and body.
 * @returns {Promise<void>} Resolves when stored (or skipped).
 */
const store = async (cache, cacheKey, rendered) => {
  const copy = toFetchResponse(rendered);
  const cacheControl = copy.headers.get("Cache-Control");
  const ttl = edgeTtl(cacheControl);
  if (rendered.status !== 200 || ttl <= 0) {
    return;
  }
  copy.headers.set(ORIGIN_CACHE_CONTROL, cacheControl ?? "");
  copy.headers.set(STORED_AT, String(Date.now()));
  copy.headers.set(FRESH_TTL, String(ttl));
  copy.headers.set(
    "Cache-Control",
    `public, max-age=${ttl + staleTtl(cacheControl)}`,
  );
  await cache.put(cacheKey, copy);
};

/**
 * Renders a card once per isolate for concurrent requests and stores it.
 *
 * @param {string} route Handler name.
 * @param {URL} url Request URL.
 * @param {Request} request Incoming request.
 * @param {Cache | undefined} cache Edge cache.
 * @param {Request} cacheKey Cache key.
 * @param {{ waitUntil: (promise: Promise<any>) => void }} ctx Execution context.
 * @returns {Promise<Response>} A new Response for this request.
 */
const renderShared = (route, url, request, cache, cacheKey, ctx) => {
  const key = url.toString();
  let pending = inflight.get(key);
  if (!pending) {
    pending = render(route, url, request).then((rendered) => {
      if (cache) {
        ctx.waitUntil(store(cache, cacheKey, rendered).catch(() => {}));
      }
      return rendered;
    });
    inflight.set(key, pending);
    pending.finally(() => inflight.delete(key)).catch(() => {});
  }
  return pending.then(toFetchResponse);
};

export default {
  /**
   * Handles one HTTP request.
   *
   * @param {Request} request Incoming request.
   * @param {unknown} _env Worker bindings (variables reach the handlers via process.env).
   * @param {{ waitUntil: (promise: Promise<any>) => void }} ctx Execution context.
   * @returns {Promise<Response>} Response.
   */
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);

    // Vercel redirected plain HTTP to HTTPS with a 308; workers.dev does not.
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 308);
    }

    if (url.pathname === "/") {
      return Response.redirect(ROOT_REDIRECT, 308);
    }

    if (url.pathname === "/robots.txt") {
      return new Response(request.method === "HEAD" ? null : ROBOTS_TXT, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    const route = resolveRoute(url.pathname);
    if (!route) {
      return new Response("The page could not be found.\n\nNOT_FOUND\n", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const isHead = request.method === "HEAD";
    // The Vercel handlers ignore the method, so every method renders the
    // card; only GET and HEAD use the edge cache.
    if (request.method !== "GET" && !isHead) {
      return toFetchResponse(await render(route, url, request));
    }

    // Edge cache, in place of Vercel's CDN, which kept each card for its
    // s-maxage and then served it stale for its stale-while-revalidate window
    // while it rendered again. GitHub's image proxy (Camo) gives up after a
    // few seconds, and a cold render can take 3 to 5 s.
    const cache = globalThis.caches?.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const storedAt = Number(cached.headers.get(STORED_AT) ?? 0);
        const freshTtl = Number(cached.headers.get(FRESH_TTL) ?? 0);
        const stale = Date.now() - storedAt > freshTtl * 1000;
        if (stale) {
          ctx.waitUntil(
            renderShared(route, url, request, cache, cacheKey, ctx).catch(
              () => {},
            ),
          );
        }
        const headers = new Headers(cached.headers);
        headers.set(
          "Cache-Control",
          headers.get(ORIGIN_CACHE_CONTROL) ?? "no-cache",
        );
        headers.delete(ORIGIN_CACHE_CONTROL);
        headers.delete(STORED_AT);
        headers.delete(FRESH_TTL);
        headers.set("x-worker-cache", stale ? "STALE" : "HIT");
        return new Response(isHead ? null : cached.body, {
          status: cached.status,
          headers,
        });
      }
    }

    const response = await renderShared(
      route,
      url,
      request,
      cache,
      cacheKey,
      ctx,
    );
    response.headers.set("x-worker-cache", "MISS");
    return isHead ? new Response(null, response) : response;
  },
};
