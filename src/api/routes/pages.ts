/**
 * Serves the product's HTML pages.
 *
 * Kept apart from the demo's page routes: those exist only when DEMO_ENABLED is
 * on and refuse to run on mainnet, while these are the product and must be
 * served in every environment.
 *
 * Each page is a single self-contained file with no build step, read from disk
 * per request so an edit shows up on reload without a restart. They are small
 * and the OS caches them; if that ever stops being true, cache on first read.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const HERE = dirname(fileURLToPath(import.meta.url));
/** src/api/routes -> src/api/public, and dist/api/routes -> dist/api/public. */
export const PAGES_DIR = resolve(HERE, "..", "public");

export interface PageRoutesOptions {
  /** Override for tests. */
  htmlDir?: string;
}

function readPage(dir: string, file: string): string | undefined {
  try {
    return readFileSync(join(dir, file), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The one stylesheet and the one script every page shares.
 *
 * The bar across the top of the product was copied into each page while there
 * were two of them. At six it stopped being a copy and started being six things
 * that drift, which is the opposite of what a shared bar is for. These are the
 * shared parts; the markup stays in each page because it is twelve semantic
 * lines and a nav that only exists once JavaScript has run is a worse trade.
 *
 * Same read-per-request as the pages, for the same reason.
 */
const ASSET_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function serveAsset(app: FastifyInstance, file: string, dir: string): void {
  const ext = file.slice(file.lastIndexOf("."));
  const type = ASSET_TYPES[ext] ?? "application/octet-stream";
  app.get(`/assets/${file}`, async (_request, reply) => {
    const body = readPage(dir, join("assets", file));
    if (body === undefined) {
      return reply.code(503).send({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: `The asset src/api/public/assets/${file} is not present in this build.`,
        },
      });
    }
    // No long cache: these are read per request like the pages, and a stale
    // bar served from a browser cache after a deploy is a support ticket.
    return reply
      .code(200)
      .type(type)
      .header("cache-control", "no-cache")
      .send(body);
  });
}

/**
 * A missing page is a 503 naming the file, never a crash and never a 404:
 * 404 would imply the route does not exist, sending an operator to look in the
 * wrong place. The only useful distinction is "that UI has not been built yet".
 */
function servePage(
  app: FastifyInstance,
  routePath: string,
  file: string,
  dir: string,
): void {
  app.get(routePath, async (_request, reply) => {
    const html = readPage(dir, file);
    if (html === undefined) {
      return reply.code(503).send({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: `The page src/api/public/${file} is not present in this build.`,
        },
      });
    }
    return reply.code(200).type("text/html; charset=utf-8").send(html);
  });
}

export function registerPageRoutes(
  app: FastifyInstance,
  options: PageRoutesOptions = {},
): void {
  const dir = options.htmlDir ?? PAGES_DIR;

  // Shared chrome, before the pages that reference it.
  serveAsset(app, "bar.css", dir);
  serveAsset(app, "bar.js", dir);

  // The front door is the public record: every event that has happened, with
  // its turnout, and a Register button on the ones still taking names.
  //
  // It used to be a hallway asking "which one are you?", which made a guest
  // answer a question before seeing anything. The list answers it instead —
  // somebody looking for the event they went to is already there, somebody
  // signing up has the button, and the bar across the top carries the two
  // staff doors.
  //
  // NOT the JSON 404 the root once answered, which read as a broken deployment
  // even when everything under it was fine. That is the regression pages.test
  // exists to catch.
  servePage(app, "/", "events.html", dir);

  // Admin. A single page that decides between the login form and the dashboard
  // by asking GET /admin/api/me — the server is the authority on whether a
  // session is live, never a flag the page keeps for itself.
  //
  // NOTE: these are page routes under /admin, NOT /admin/api. The admin API
  // guard covers the /admin/api prefix; serving the login HTML must stay
  // reachable without a session or nobody could ever log in.
  servePage(app, "/admin", "admin.html", dir);
  servePage(app, "/admin/", "admin.html", dir);

  // Public registration. The eventId is read from the path by the page itself.
  servePage(app, "/register", "register.html", dir);
  servePage(app, "/register/:eventId", "register.html", dir);

  // The volunteer desk, at a client-facing URL rather than under /demo.
  // The page itself requires a signed-in operator; see admin auth.
  servePage(app, "/volunteer", "volunteer.html", dir);

  // The attendee's own pass, on their own phone, holding their own key.
  //
  // Distinct from /demo/attendee, which generates a wallet server-side and
  // signs on the attendee's behalf because it was built before Xaman was
  // configured. This page never touches a key: the attendee proves the wallet
  // with a Xaman sign-in and approves the badge in Xaman.
  servePage(app, "/attend", "attend.html", dir);
  servePage(app, "/attend/:eventId", "attend.html", dir);

  // The same page as `/`, kept because it is the address people link to and
  // the one the bar's own Events tab points at.
  //
  // `/events` and not `/events/:something` — the parametric routes under this
  // prefix belong to the API (claims, roster, attendance), and a page route
  // that took a parameter here would sit alongside them confusingly.
  servePage(app, "/events", "events.html", dir);
  servePage(app, "/events/", "events.html", dir);

  // One event: its particulars, its turnout, and every badge it minted. The
  // parametric API routes under this prefix are all deeper — /roster, /claims,
  // /attendance — so a page at exactly two segments does not shadow them.
  servePage(app, "/events/:eventId", "event.html", dir);
}
