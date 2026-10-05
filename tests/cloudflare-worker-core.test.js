/**
 * @jest-environment node
 */
import { describe, expect, it } from "@jest/globals";
import {
  ROBOTS_TXT,
  createResponseShim,
  edgeTtl,
  resolveRoute,
  staleTtl,
  toQuery,
} from "../cloudflare/worker-core.js";

describe("cloudflare worker core", () => {
  it("resolves the Vercel api routes", () => {
    expect(resolveRoute("/api")).toBe("index");
    expect(resolveRoute("/api/")).toBe("index");
    expect(resolveRoute("/api/pin")).toBe("pin");
    expect(resolveRoute("/api/top-langs.js")).toBe("top-langs");
    expect(resolveRoute("/api/status/pat-info")).toBe("status/pat-info");
    expect(resolveRoute("/api/unknown")).toBeUndefined();
    expect(resolveRoute("/constructor")).toBeUndefined();
  });

  it("builds a Vercel-style query object", () => {
    const query = toQuery(new URLSearchParams("username=a&hide=x&hide=y"));
    expect(query).toEqual({ username: "a", hide: ["x", "y"] });
  });

  it("converts strings and JSON bodies into a Response", async () => {
    const svg = createResponseShim();
    svg.res.setHeader("Content-Type", "image/svg+xml");
    svg.res.send("<svg/>");
    const svgResponse = svg.toResponse("GET");
    expect(svgResponse.status).toBe(200);
    expect(svgResponse.headers.get("content-type")).toBe("image/svg+xml");
    expect(await svgResponse.text()).toBe("<svg/>");

    const json = createResponseShim();
    json.res.send({ up: true });
    const jsonResponse = json.toResponse("GET");
    expect(jsonResponse.headers.get("content-type")).toContain(
      "application/json",
    );
    expect(await jsonResponse.json()).toEqual({ up: true });

    const head = createResponseShim();
    head.res.send("body");
    expect(await head.toResponse("HEAD").text()).toBe("");
  });

  it("reads the edge TTL from s-maxage", () => {
    expect(
      edgeTtl("max-age=86400, s-maxage=86400, stale-while-revalidate=86400"),
    ).toBe(86400);
    expect(edgeTtl("max-age=0, s-maxage=300")).toBe(300);
    expect(edgeTtl("no-cache, no-store, must-revalidate, max-age=0")).toBe(0);
    expect(edgeTtl(null)).toBe(0);
  });

  it("reads the stale-while-revalidate window", () => {
    expect(
      staleTtl("max-age=86400, s-maxage=86400, stale-while-revalidate=86400"),
    ).toBe(86400);
    expect(staleTtl("max-age=0, s-maxage=300")).toBe(0);
    expect(staleTtl(null)).toBe(0);
  });

  it("asks every crawler to stay out in robots.txt", () => {
    expect(ROBOTS_TXT).toBe("User-agent: *\nDisallow: /\n");
    expect(resolveRoute("/robots.txt")).toBeUndefined();
  });
});
