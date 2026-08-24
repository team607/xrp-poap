/**
 * The three routes behind the admin console's login screen.
 *
 *   POST /admin/api/login   email + password  -> session cookie + CSRF cookie
 *   POST /admin/api/logout  revoke the session, drop both cookies
 *   GET  /admin/api/me      who am I (the UI's "show the login screen?" call)
 *
 * The guard that protects every OTHER admin route is not here — it is a prefix
 * hook installed by `registerAdminAuth()` in src/api/auth.ts, so a route added
 * later cannot forget to ask for it. These three are the exceptions it knows
 * about: `login` is exempt because there is nothing to authenticate with yet,
 * and the other two are ordinary guarded routes that happen to be about the
 * session itself.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ConfigError } from "../../errors.js";
import {
  clearSessionCookies,
  issueSession,
  refreshCsrfCookie,
  sendAuthError,
  verifyAdminCredentials,
  type AdminAuthEnabled,
} from "../auth.js";
import type { ApiDeps } from "../deps.js";
import { sendError } from "../http-errors.js";

/**
 * THIS ROUTE IS A PASSWORD ORACLE, so it gets the claim route's treatment: its
 * own bucket, tighter than the global one, in two dimensions.
 *
 *   - PER IP, 5 attempts per 5 minutes. A human who has forgotten which of two
 *     passwords it was needs three tries; a script needs thousands. Five is
 *     comfortably above the first and nowhere near the second.
 *   - PER EMAIL, 20 per 15 minutes, deliberately LOOSER. This bucket exists to
 *     put a ceiling on a distributed attack that rotates source addresses, and
 *     it has to be loose on purpose: anyone can name the admin's email, so a
 *     tight limit here is a lockout button an attacker can press from anywhere.
 *     The IP bucket stops the single attacker; this one stops the botnet from
 *     getting more than a handful of guesses an hour in total, while still
 *     leaving the real operator room to log in from a phone at the door.
 *
 * With one account and a >= 12 character password, 20 guesses per 15 minutes is
 * not a threat. It is also worth remembering what the limit is NOT: scrypt at
 * these parameters is ~100ms of CPU per attempt, which is its own throttle.
 */
const LOGIN_IP_RATE_LIMIT = { max: 5, timeWindow: "5 minutes" } as const;
const LOGIN_EMAIL_RATE_LIMIT = { max: 20, timeWindow: "15 minutes" } as const;

/**
 * Deliberately says nothing. Not "no such user", not "wrong password for that
 * user", not a different status code for the two. With a single account, "is
 * this the admin's address?" is most of what an attacker wants to learn, and
 * the answer must not be in the body, the status, or (see
 * `verifyAdminCredentials`) the response time.
 */
const GENERIC_LOGIN_FAILURE = "Invalid email or password.";

const loginBodySchema = z.object({
  email: z.string().min(1).max(320),
  /**
   * Not validated beyond a length bound on purpose: a shape rule here would
   * reject a correct password typed by someone whose password predates the
   * rule, and it tells an attacker about the password policy for free. The
   * upper bound is a cheap guard against wasting scrypt on a megabyte of body.
   */
  password: z.string().min(1).max(1024),
});

type LoginBody = z.infer<typeof loginBodySchema>;

/** The rate-limit bucket for one submitted email, independent of source IP. */
function emailRateLimitKey(request: FastifyRequest): string {
  const body = request.body as { email?: unknown } | undefined;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "unknown";
  return `admin-login-email:${email}`;
}

export function registerAdminAuthRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
  state: AdminAuthEnabled,
): void {
  const sessions = deps.sessions;
  if (!sessions) {
    throw new ConfigError(
      "Admin auth routes were registered without a SessionStore. Refusing to serve a login " +
        "endpoint that cannot issue a session.",
      {},
    );
  }

  const rateLimit =
    deps.rateLimit?.enabled === false ? false : (deps.rateLimit?.login ?? LOGIN_IP_RATE_LIMIT);

  /**
   * The second bucket. `createRateLimit` rather than a second route-level
   * config because the plugin marks a request as rate-limited once and skips
   * the second hook — same reason, same shape as the claim route's
   * address-keyed limiter. Absent when the plugin is not registered at all.
   */
  const emailLimiter =
    rateLimit === false || typeof app.createRateLimit !== "function"
      ? undefined
      : app.createRateLimit({ ...LOGIN_EMAIL_RATE_LIMIT, keyGenerator: emailRateLimitKey });

  const enforceEmailLimit = emailLimiter
    ? async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
        const outcome = await emailLimiter(request);
        if (outcome.isAllowed || !outcome.isExceeded) return undefined;
        reply.header("retry-after", String(outcome.ttlInSeconds));
        return sendError(
          reply,
          429,
          "RATE_LIMITED",
          `Too many sign-in attempts. Retry in ${outcome.ttlInSeconds}s.`,
        );
      }
    : undefined;

  /**
   * POST /admin/api/login — 200 with `{ email }`, or 401 with nothing useful.
   *
   * On success the session id is BRAND NEW and whatever the request arrived
   * with is revoked. That is the session fixation fix: a cookie an attacker
   * planted in the operator's browser beforehand must not survive the login
   * that gives it privileges.
   */
  app.post<{ Body: LoginBody }>(
    "/admin/api/login",
    {
      schema: { body: loginBodySchema },
      config: { rateLimit },
      ...(enforceEmailLimit ? { preHandler: enforceEmailLimit } : {}),
    },
    async (request, reply) => {
      const { email, password } = request.body;

      const identity = await verifyAdminCredentials(deps.config, email, password);

      if (!identity) {
        // The submitted email is NOT logged. People type their password into
        // the wrong box, and a log line is a much longer-lived place for it to
        // sit than a form field.
        request.log.warn({ ip: request.ip }, "admin login failed");
        return sendAuthError(reply, 401, "UNAUTHORIZED", GENERIC_LOGIN_FAILURE);
      }

      // Revoke anything the browser turned up with, valid or not, before
      // issuing the new one. Best effort: a store that cannot revoke must not
      // block a legitimate login, and the old id is about to be replaced in the
      // cookie jar anyway.
      const presented = request.adminSession;
      if (presented) {
        try {
          await sessions.revoke(presented.id);
        } catch (err) {
          request.log.warn({ err }, "could not revoke the session presented at login");
        }
      }

      await issueSession(reply, deps, state, identity.email);

      request.log.info({ email: identity.email }, "admin signed in");

      return reply.code(200).send({ email: identity.email });
    },
  );

  /**
   * POST /admin/api/logout — revoke, then clear. 200 either way.
   *
   * Reached only with a valid session and a valid CSRF header (the prefix guard
   * enforces both), so "logged out" here means the session id is dead in the
   * store, not merely that a cookie was dropped.
   */
  app.post("/admin/api/logout", async (request, reply) => {
    const session = request.adminSession;

    if (session) {
      await sessions.revoke(session.id);
      request.log.info({ email: session.email }, "admin signed out");
    }

    clearSessionCookies(reply, deps.config);
    return reply.code(200).send({ ok: true });
  });

  /**
   * GET /admin/api/me — `{ email }` when signed in, 401 when not.
   *
   * The UI calls this on load to decide between the console and the login
   * screen, so the 401 is a normal answer here rather than a failure.
   *
   * It also re-issues the CSRF cookie. That cookie is derived from the session
   * id, so re-sending it is free and idempotent, and it means a UI that lost it
   * (cleared cookies, a jar that dropped the non-httpOnly one) recovers on the
   * next page load instead of 403-ing every write until someone logs in again.
   */
  app.get("/admin/api/me", async (request, reply) => {
    const admin = request.admin;
    const session = request.adminSession;

    if (!admin || !session) {
      return sendAuthError(reply, 401, "UNAUTHORIZED", "Not signed in.");
    }

    refreshCsrfCookie(reply, deps, state, session);
    return reply.code(200).send({ email: admin.email });
  });
}
