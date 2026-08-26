/**
 * The HTML page routes.
 *
 * Small surface, but it is the one every guest hits first, and two of its
 * behaviours are load-bearing and easy to regress:
 *
 *   1. `/` MUST serve something. It used to answer the generic JSON 404, which
 *      reads as a dead deployment to anyone who types the bare host — the pages
 *      underneath were all fine and it looked broken anyway.
 *   2. A page file that is missing from a build is a 503 NAMING THE FILE, never
 *      a 404. A 404 says "no such route" and sends an operator to look in the
 *      routing table instead of at the build.
 *
 * These run against a temp directory rather than src/api/public, so they assert
 * the routing and never the contents of the real pages.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAGES_DIR, registerPageRoutes } from "./routes/pages.js";

/** Every page file the routes can serve, and the routes that serve it. */
const PAGES: ReadonlyArray<{ file: string; routes: readonly string[] }> = [
  { file: "index.html", routes: ["/"] },
  { file: "admin.html", routes: ["/admin", "/admin/"] },
  { file: "register.html", routes: ["/register", "/register/700010"] },
  { file: "volunteer.html", routes: ["/volunteer"] },
  { file: "attend.html", routes: ["/attend", "/attend/700010"] },
];

let dir: string;
let app: FastifyInstance;

/** A marker per file, so a route serving the WRONG page is a failure. */
const marker = (file: string): string => `<!doctype html><title>${file}</title>`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poap-pages-"));
  for (const { file } of PAGES) writeFileSync(join(dir, file), marker(file), "utf8");
  app = Fastify({ logger: false });
  registerPageRoutes(app, { htmlDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the page routes", () => {
  it("serves every page at every route that claims it", async () => {
    for (const { file, routes } of PAGES) {
      for (const url of routes) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(200);
        expect(res.headers["content-type"], url).toContain("text/html");
        // Not just "some html" — the RIGHT html.
        expect(res.body, url).toBe(marker(file));
      }
    }
  });

  it("answers the bare host with the front door", async () => {
    // The regression this file exists for: `/` returning
    // {"error":{"code":"NOT_FOUND","message":"No route for GET /"}}.
    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(marker("index.html"));
    expect(res.body).not.toContain("NOT_FOUND");
  });

  it("503s a page missing from the build, and names the file", async () => {
    rmSync(join(dir, "index.html"));

    const res = await app.inject({ method: "GET", url: "/" });

    // 503, not 404: the route exists, the file does not, and only one of those
    // two messages sends an operator to the right place.
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("SERVICE_UNAVAILABLE");
    expect(res.json().error.message).toContain("index.html");
  });

  it("reads from disk per request, so an edit needs no restart", async () => {
    const before = await app.inject({ method: "GET", url: "/" });
    expect(before.body).toBe(marker("index.html"));

    writeFileSync(join(dir, "index.html"), "<!doctype html><title>edited</title>", "utf8");

    const after = await app.inject({ method: "GET", url: "/" });
    expect(after.body).toContain("edited");
  });

  it("does not claim routes it has no page for", async () => {
    for (const url of ["/nope", "/register/700010/extra", "/attendee"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("ships every page it registers", async () => {
    // The temp dir above proves the ROUTING. This proves the BUILD: a route
    // pointing at a file nobody wrote is a 503 in production and green here.
    const real = Fastify({ logger: false });
    registerPageRoutes(real);

    for (const { routes } of PAGES) {
      const url = routes[0] as string;
      const res = await real.inject({ method: "GET", url });
      expect(res.statusCode, `${url} (from ${PAGES_DIR})`).toBe(200);
    }
  });
});
