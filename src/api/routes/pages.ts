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

  // The attendee's own pass, on their own phone, holding their own key.
  //
  // Distinct from /demo/attendee, which generates a wallet server-side and
  // signs on the attendee's behalf because it was built before Xaman was
  // configured. This page never touches a key: the attendee proves the wallet
  // with a Xaman sign-in and approves the badge in Xaman.
  servePage(app, "/attend", "attend.html", dir);
  servePage(app, "/attend/:eventId", "attend.html", dir);
}
