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
  ROOT_REDIRECT,
  createResponseShim,
  edgeTtl,
  resolveRoute,
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

    if (url.pathname === "/") {
      return Response.redirect(ROOT_REDIRECT, 308);
    }

    const route = resolveRoute(url.pathname);
    if (!route) {
      return new Response("The page could not be found.\n\nNOT_FOUND\n", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    // Edge cache, in place of Vercel's CDN, which kept each card for its
    // s-maxage. GitHub's image proxy (Camo) gives up after a few seconds, and
    // a cold top-langs render can take about 4 s.
    const cache = globalThis.caches?.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set(
          "Cache-Control",
          headers.get(ORIGIN_CACHE_CONTROL) ?? "no-cache",
        );
        headers.delete(ORIGIN_CACHE_CONTROL);
        headers.set("x-worker-cache", "HIT");
        return new Response(request.method === "HEAD" ? null : cached.body, {
          status: cached.status,
          headers,
        });
      }
    }

    const { res, toResponse } = createResponseShim();
    const req = {
      method: "GET",
      url: url.pathname + url.search,
      query: toQuery(url.searchParams),
      headers: Object.fromEntries(request.headers),
    };

    try {
      await HANDLERS[route](req, res);
    } catch (err) {
      console.error(err);
      return new Response("Internal Server Error", { status: 500 });
    }
    const response = toResponse("GET");
    const ttl = edgeTtl(response.headers.get("Cache-Control"));
    if (cache && response.status === 200 && ttl > 0) {
      const copy = new Response(response.clone().body, response);
      copy.headers.set(
        ORIGIN_CACHE_CONTROL,
        response.headers.get("Cache-Control") ?? "",
      );
      copy.headers.set("Cache-Control", `public, max-age=${ttl}`);
      ctx.waitUntil(cache.put(cacheKey, copy));
    }
    response.headers.set("x-worker-cache", "MISS");
    return request.method === "HEAD" ? new Response(null, response) : response;
  },
};
