/**
 * The thin HTTP surface (brief 8 step 5).
 *
 * Thin is the point: routes validate, delegate to the library, and shape a
 * response. No transaction is built here, nothing is decided here, and there is
 * no module-level state — buildServer() takes an ApiDeps and returns an app, so
 * the whole server can be stood up in a test with fakes.
 */
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { ZodType } from "zod";
import { loadConfig } from "../config.js";
import { registerAdminAuth } from "./auth.js";
import { buildDeps, type ApiDeps } from "./deps.js";
import { registerErrorHandler } from "./http-errors.js";
import { registerAdminAuthRoutes } from "./routes/admin-auth.js";
import { registerAttendanceRoute } from "./routes/attendance.js";
import { registerClaimRoutes } from "./routes/claims.js";
import { registerDemoRoutes } from "./routes/demo.js";
import { registerPageRoutes } from "./routes/pages.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerRegistrationRoutes } from "./routes/registrations.js";
import { registerRosterRoute } from "./routes/roster.js";
import { registerVerifyRoute } from "./routes/verify.js";
import { registerXamanWebhookRoute } from "./routes/xaman-webhook.js";

/**
 * Every attendee-facing route is public and unauthenticated, so the global
 * bucket is the only thing standing between a script and the ledger read quota.
 * Two routes set their own, tighter, limits: POST /events/:eventId/claims,
 * which spends money, and POST /admin/api/login, which answers questions about
 * a password. Everything under /admin/api needs a session — see auth.ts.
 */
const GLOBAL_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

export function buildServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    // Off unless the deployment says otherwise. `request.ip` is the key the
    // claim limiter is sized on, so getting this wrong is not cosmetic: trust
    // the header with no proxy in front and a caller picks their own bucket;
    // distrust it behind an ingress and every attendee shares one.
    trustProxy: deps.trustProxy ?? false,
  });

  // zod validates every params/body/querystring schema. Returning the parsed
  // value lets fastify hand the handler coerced, typed input; returning the
  // ZodError lands in the error handler as a 400 BAD_REQUEST with the issues.
  app.setValidatorCompiler(({ schema }) => (data) => {
    const result = (schema as ZodType).safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  });

  registerErrorHandler(app);

  // Product pages. Outside the rate-limited scope: a static file read should
  // not consume an attendee's claim budget.
  registerPageRoutes(app);

  /**
   * ADMIN AUTHENTICATION, BEFORE ANY ROUTE.
   *
   * On the root instance and first, because the guard it installs is an
   * `onRequest` hook keyed on the `/admin/api` prefix rather than a preHandler
   * on these routes. Every admin route — including ones registered by other
   * modules, later — is behind it, and a deployment with no credentials serves
   * 503 there rather than an open API. `registerAdminAuth()` throws when the
   * credentials are half-configured, so buildServer() fails rather than a
   * request discovering it later. See src/api/auth.ts.
   */
  const adminAuth = registerAdminAuth(app, deps);

  /**
   * GET /health — 200, always, with no ledger call. A health check that needs a
   * working WebSocket connection to a public Clio server tells you about the
   * public Clio server, not about this process.
   */
  app.get("/health", async (_request, reply) =>
    reply.code(200).send({
      status: "ok",
      network: deps.config.network,
      issuer: deps.config.issuerAddress,
      xamanConfigured: Boolean(deps.config.xumm.apiKey && deps.config.xumm.apiSecret),
      time: new Date().toISOString(),
    }),
  );

  // Everything else lives inside a scope so the rate limiter is registered
  // before the routes it must cover. /health is deliberately outside it: a
  // monitor must never be the request that gets a 429.
  app.register(async (scope) => {
    if (deps.rateLimit?.enabled !== false) {
      await scope.register(rateLimit, {
        global: true,
        ...(deps.rateLimit?.global ?? GLOBAL_RATE_LIMIT),
      });
    }

    registerClaimRoutes(scope, deps);
    registerAttendanceRoute(scope, deps);
    registerRosterRoute(scope, deps);
    registerVerifyRoute(scope, deps);
    registerXamanWebhookRoute(scope, deps);

    // Also inside the scope: the two registration routes that call Xaman are
    // unauthenticated and set their own limits, which needs the plugin here.
    // Both no-op when their repositories are absent from the deps.
    registerEventRoutes(scope, deps);
    registerRegistrationRoutes(scope, deps);

    // Inside the rate-limited scope on purpose: POST /admin/api/login is a
    // password oracle and takes the claim route's treatment, which needs the
    // plugin registered in the same scope. Registered only when there is an
    // admin account to log in to — the prefix guard above answers 503 for the
    // whole surface when there is not.
    if (adminAuth.enabled) registerAdminAuthRoutes(scope, deps, adminAuth);
  });

  /**
   * The TESTNET-ONLY demo harness, and only when the composition root turned it
   * on. `deps.demo` absent — the default — means these routes do not exist at
   * all, so an unknown /demo 404s like any other path.
   *
   * Called synchronously and OUTSIDE the rate-limited scope, both deliberately:
   * registerDemoRoutes() throws a ConfigError here if the demo is paired with
   * mainnet, so buildServer() itself fails rather than a request doing so
   * later; and the demo page polls /demo/state, which must not eat the global
   * 120/min bucket the actual claim depends on. It runs its own mainnet check
   * per request regardless.
   */
  if (deps.demo?.enabled) registerDemoRoutes(app, deps);

  return app;
}

/** Entrypoint for `npm start`. Wires real dependencies and listens. */
export async function start(): Promise<FastifyInstance> {
  const config = loadConfig();
  const { deps, close } = await buildDeps(config);
  const app = buildServer(deps);

  app.addHook("onClose", async () => {
    await close();
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }

  await app.listen({ port: config.api.port, host: config.api.host });
  return app;
}

/** Guarded: importing this module (tests, tooling) must not open a socket. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  start().catch((err: unknown) => {
    // Never console.log the config: it holds the issuer seed.
    console.error("[api] failed to start:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
