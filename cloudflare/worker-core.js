// @ts-check

/**
 * @file I/O-free core of the Cloudflare Worker entry (`cloudflare/worker.js`).
 *
 * The `api/*` handlers are written for Vercel's Node.js runtime: they read
 * `req.query` and answer through `res.setHeader()` and `res.send()`. This
 * module maps a Fetch API request onto that small surface and turns the
 * handler's answer back into a Fetch API response, so the handlers run on
 * Workers unchanged.
 */

/** Upstream project; Vercel redirects `/` here (see `vercel.json`). */
export const ROOT_REDIRECT =
  "https://github.com/anuraghazra/github-readme-stats";

/**
 * robots.txt body. The Worker serves only SVG cards and JSON status, with no
 * human-facing pages, so every crawler is asked to stay out.
 */
export const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

/**
 * Route table mirroring Vercel's file-system routing of `api/`.
 * Keys are paths without a trailing slash; values name the handler module.
 */
const ROUTES = {
  "/api": "index",
  "/api/index": "index",
  "/api/pin": "pin",
  "/api/top-langs": "top-langs",
  "/api/wakatime": "wakatime",
  "/api/gist": "gist",
  "/api/status/up": "status/up",
  "/api/status/pat-info": "status/pat-info",
};

/**
 * Resolves a URL path to a handler name, ignoring one trailing slash and an
 * optional `.js` suffix the way Vercel does.
 *
 * @param {string} pathname URL path.
 * @returns {string | undefined} Handler name or undefined when no route matches.
 */
export const resolveRoute = (pathname) => {
  let path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  path = path.replace(/\.js$/, "");
  return Object.prototype.hasOwnProperty.call(ROUTES, path)
    ? ROUTES[/** @type {keyof typeof ROUTES} */ (path)]
    : undefined;
};

/**
 * Builds a Vercel-style `req.query` object: a key that appears once maps to
 * a string, a repeated key maps to an array of strings.
 *
 * @param {URLSearchParams} searchParams Query parameters.
 * @returns {Record<string, string | string[]>} Query object.
 */
export const toQuery = (searchParams) => {
  /** @type {Record<string, string | string[]>} */
  const query = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }
  return query;
};

/**
 * Creates a minimal Vercel-style response object that records headers and
 * the body passed to `send()`.
 *
 * @returns {{
 *   res: { setHeader: (name: string, value: string) => any, getHeader: (name: string) => string | null, status: (code: number) => any, send: (body: any) => any },
 *   toResponse: (method: string) => Response,
 * }} The response shim and a function that converts it into a Fetch response.
 */
export const createResponseShim = () => {
  const headers = new Headers();
  let statusCode = 200;
  /** @type {string | null} */
  let body = null;

  const res = {
    setHeader(/** @type {string} */ name, /** @type {string} */ value) {
      headers.set(name, String(value));
      return res;
    },
    getHeader(/** @type {string} */ name) {
      return headers.get(name);
    },
    status(/** @type {number} */ code) {
      statusCode = code;
      return res;
    },
    send(/** @type {any} */ value) {
      if (typeof value === "string") {
        body = value;
      } else if (value === undefined || value === null) {
        body = "";
      } else {
        // Objects, booleans and numbers are sent as JSON, as on Vercel.
        if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json; charset=utf-8");
        }
        body = JSON.stringify(value);
      }
      return res;
    },
  };

  const toResponse = (/** @type {string} */ method) =>
    new Response(method === "HEAD" ? null : (body ?? ""), {
      status: statusCode,
      headers,
    });

  return { res, toResponse };
};

/** Header that keeps the handler's own Cache-Control on a cached copy. */
export const ORIGIN_CACHE_CONTROL = "x-origin-cache-control";

/**
 * Returns how long the edge may keep a response, from the `s-maxage`
 * directive the handlers send (Vercel's CDN honored the same directive).
 *
 * @param {string | null} cacheControl Cache-Control header value.
 * @returns {number} Seconds; 0 means do not cache.
 */
export const edgeTtl = (cacheControl) => {
  if (!cacheControl || /no-store|no-cache|private/i.test(cacheControl)) {
    return 0;
  }
  const match = /s-maxage=(\d+)/i.exec(cacheControl);
  return match ? parseInt(match[1], 10) : 0;
};

/**
 * Returns how long the edge may keep serving a stale copy while it renders
 * a fresh one, from the `stale-while-revalidate` directive the handlers send
 * (Vercel's CDN honored the same directive).
 *
 * @param {string | null} cacheControl Cache-Control header value.
 * @returns {number} Seconds; 0 means no stale window.
 */
export const staleTtl = (cacheControl) => {
  if (!cacheControl) {
    return 0;
  }
  const match = /stale-while-revalidate=(\d+)/i.exec(cacheControl);
  return match ? parseInt(match[1], 10) : 0;
};
