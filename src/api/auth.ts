/**
 * Admin authentication: one operator account, a password, and an opaque
 * session cookie.
 *
 * The shape is deliberately small. There is no users table, no signup, no
 * password reset and no second account — the credentials come from the
 * environment (`ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`) and a
 * second operator is a feature, not a config change. Shipping half a user
 * system is worse than shipping one credential that is obviously one
 * credential.
 *
 * Four decisions carry the security of this file:
 *
 *   1. THE PASSWORD IS NEVER STORED. `ADMIN_PASSWORD_HASH` holds a scrypt hash
 *      in a self-describing format (see ENCODED FORM below) so the work factor
 *      can be raised later without invalidating hashes made today.
 *   2. THE SESSION IS OPAQUE AND REVOCABLE. The cookie carries a random id
 *      issued by a `SessionStore`, signed with `SESSION_SECRET`. Not a JWT:
 *      logout has to actually log you out, and a leaked cookie has to be
 *      killable before it expires.
 *   3. A WRONG EMAIL COSTS EXACTLY AS MUCH AS A WRONG PASSWORD.
 *      `verifyAdminCredentials()` runs the scrypt either way. Without that, the
 *      login endpoint answers "does this email exist?" in the timing channel,
 *      and with one account that question is most of the secret.
 *   4. A MISCONFIGURED DEPLOY NEVER SERVES AN OPEN ADMIN API. See
 *      `resolveAdminAuth()` — nothing configured switches the surface OFF (503,
 *      loudly), and something half-configured refuses to boot.
 *
 * ENCODED FORM
 *
 *     scrypt$N=32768,r=8,p=1$<salt base64url>$<hash base64url>
 *
 * The algorithm and every parameter travel with the hash, so raising N is a
 * one-line change here plus a re-run of `npm run admin:hash` when convenient —
 * old hashes keep verifying at their own parameters in the meantime.
 */
import cookie from "@fastify/cookie";
import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { ConfigError, ValidationError } from "../errors.js";
import type { AdminIdentity, SessionRecord } from "../types.js";
import type { ApiDeps } from "./deps.js";
import type { ApiErrorBody } from "./http-errors.js";

/**
 * `promisify()` resolves to the first of node's overloads, which is the
 * three-argument one. Named explicitly so the options bag — where `maxmem`
 * lives, and without which our own parameters are rejected — type checks.
 */
const scryptAsync = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

// ---------------------------------------------------------------------------
// Names and constants
// ---------------------------------------------------------------------------

/**
 * Session cookie. Named for the product and the surface it opens, not `sid` or
 * `session` — a cookie jar with three unrelated `session` cookies in it is how
 * you end up debugging the wrong one.
 */
export const SESSION_COOKIE = "poap_admin";

/** CSRF cookie. Readable by JS on purpose — see the CSRF section below. */
export const CSRF_COOKIE = "poap_csrf";

/** The header the admin UI echoes the CSRF token back in. */
export const CSRF_HEADER = "x-csrf-token";

/** Everything under here is guarded. `/admin` itself (the HTML) is not. */
export const ADMIN_API_PREFIX = "/admin/api";

/** The one path that must open without a session. */
export const LOGIN_PATH = `${ADMIN_API_PREFIX}/login`;

/**
 * Shorter than this and the scrypt parameters are doing all the work. Twelve
 * is not a strong password on its own; it is the floor below which a hash is
 * decoration. Enforced by `hashPassword()`, so `npm run admin:hash` cannot mint
 * one that is weaker.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * `SESSION_SECRET` floor, in characters. 32 hex characters is 128 bits, which
 * is the point below which forging a cookie signature stops being absurd.
 * `crypto.randomBytes(32).toString("hex")` gives 64 — use that.
 */
export const MIN_SESSION_SECRET_LENGTH = 32;

/** Methods that do not change state and therefore skip the CSRF check. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export interface ScryptParams {
  /** CPU/memory cost. A power of two. */
  N: number;
  /** Block size. */
  r: number;
  /** Parallelisation. */
  p: number;
}

/**
 * Today's parameters. N=32768, r=8, p=1 is ~32MB and ~100ms on a laptop, which
 * is the usual "interactive login" point on the curve. Raise N (never lower
 * it); the encoded form carries the parameters, so old hashes keep working.
 */
export const SCRYPT_PARAMS: ScryptParams = { N: 32_768, r: 8, p: 1 };

const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * Node's default `maxmem` is exactly 32MB, and N=32768,r=8 needs exactly 32MB
 * plus change — so the default rejects our own parameters with "memory limit
 * exceeded". Give scrypt room for a couple of future bumps of N.
 */
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/** Ceilings on parameters read out of a STORED hash, so a bad one cannot hang. */
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;
const MAX_KEY_BYTES = 256;

export interface ParsedScryptHash {
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
}

function derive(password: string, salt: Buffer, params: ScryptParams, keylen: number): Promise<Buffer> {
  // NFKC so a password typed on a phone keyboard and the same password typed on
  // a laptop are the same bytes. Unicode normalisation is not optional for a
  // passphrase people will type at a desk.
  return scryptAsync(password.normalize("NFKC"), salt, keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * scrypt the password with a fresh random salt and encode everything needed to
 * check it later. Refuses a password that is too short: a hash cannot rescue a
 * six-character password, and this is the only place that mints them.
 */
export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== "string" || plain.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(
      "INVALID_INPUT",
      `An admin password must be at least ${MIN_PASSWORD_LENGTH} characters. ` +
        "This is the only account on the system and it fronts the whole admin API.",
      { minLength: MIN_PASSWORD_LENGTH },
    );
  }

  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(plain, salt, SCRYPT_PARAMS, KEY_BYTES);
  return encodeScryptHash({ params: SCRYPT_PARAMS, salt, hash });
}

export function encodeScryptHash(parsed: ParsedScryptHash): string {
  const { N, r, p } = parsed.params;
  return [
    "scrypt",
    `N=${N},r=${r},p=${p}`,
    parsed.salt.toString("base64url"),
    parsed.hash.toString("base64url"),
  ].join("$");
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

/**
 * Parse the encoded form. Returns null for ANYTHING it does not fully
 * understand — a truncated string, a different algorithm, a parameter it does
 * not know, a parameter out of range. Never throws: the two callers are a
 * password check that must not turn a bad stored hash into a 500, and a boot
 * check that wants a plain yes/no.
 *
 * base64url on the way out, but decoding is done with "base64", which Node
 * accepts for both alphabets — so a hash produced by an older build that used
 * standard base64 still verifies.
 */
export function parseScryptHash(encoded: string): ParsedScryptHash | null {
  if (typeof encoded !== "string") return null;

  const parts = encoded.split("$");
  if (parts.length !== 4) return null;

  const [algorithm, paramString, saltPart, hashPart] = parts;
  if (algorithm !== "scrypt") return null;
  if (!paramString || !saltPart || !hashPart) return null;

  let N = 0;
  let r = 0;
  let p = 0;
  for (const pair of paramString.split(",")) {
    const [key, rawValue] = pair.split("=");
    if (key === undefined || rawValue === undefined) return null;
    const value = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(value) || String(value) !== rawValue) return null;
    // An unrecognised key is a hash from a scheme this build does not
    // implement. Guessing at it is how you verify a password against the wrong
    // KDF, so: no.
    if (key === "N") N = value;
    else if (key === "r") r = value;
    else if (key === "p") p = value;
    else return null;
  }

  if (!isPowerOfTwo(N) || N > MAX_N) return null;
  if (!Number.isInteger(r) || r < 1 || r > MAX_R) return null;
  if (!Number.isInteger(p) || p < 1 || p > MAX_P) return null;

  const salt = Buffer.from(saltPart, "base64");
  const hash = Buffer.from(hashPart, "base64");
  if (salt.length === 0 || hash.length === 0 || hash.length > MAX_KEY_BYTES) return null;

  return { params: { N, r, p }, salt, hash };
}

/**
 * A well-formed hash of nothing in particular, used to spend the same scrypt
 * time on a login whose email did not match. Built rather than hard-coded so it
 * always carries the CURRENT parameters — a constant would silently stop
 * matching the real work the moment N is raised, and reopen the timing channel.
 */
const DUMMY_HASH = encodeScryptHash({
  params: SCRYPT_PARAMS,
  salt: Buffer.alloc(SALT_BYTES),
  hash: Buffer.alloc(KEY_BYTES),
});

/**
 * Recompute and compare in constant time.
 *
 * NEVER THROWS. A malformed, truncated or empty stored hash is `false`, not a
 * 500: the caller is a login endpoint, and the difference between "no" and
 * "the server broke" is a fact about the deployment an attacker should not be
 * handed. (`resolveAdminAuth()` refuses to boot on a hash it cannot parse, so
 * in practice this path only sees a hash mangled after startup.)
 */
export async function verifyPassword(plain: string, encoded: string): Promise<boolean> {
  const parsed = parseScryptHash(encoded);
  if (!parsed) return false;
  if (typeof plain !== "string") return false;

  try {
    const candidate = await derive(plain, parsed.salt, parsed.params, parsed.hash.length);
    // Lengths are equal by construction — `derive` was asked for exactly
    // `parsed.hash.length` bytes — but timingSafeEqual throws on a mismatch, so
    // check rather than trust.
    if (candidate.length !== parsed.hash.length) return false;
    return timingSafeEqual(candidate, parsed.hash);
  } catch {
    return false;
  }
}

/** Case and surrounding whitespace are not part of an email address. */
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The credential check.
 *
 * THE SCRYPT ALWAYS RUNS. A wrong email must cost the same as a wrong password
 * or the endpoint becomes an email oracle: with a single account, "which
 * address is the admin" is most of what an attacker wants to learn, and a
 * 100ms difference answers it over a handful of requests. When the email does
 * not match we still hash the submitted password — against the real stored hash
 * when there is one, otherwise against `DUMMY_HASH`, which carries the same
 * parameters and therefore the same cost.
 *
 * The email comparison itself is not constant-time. It does not need to be: it
 * is compared after the expensive step, its length is public, and an operator's
 * email address is not the secret. The password is.
 */
export async function verifyAdminCredentials(
  config: AppConfig,
  email: unknown,
  password: unknown,
): Promise<AdminIdentity | null> {
  const submittedEmail = typeof email === "string" ? normalizeEmail(email) : "";
  const submittedPassword = typeof password === "string" ? password : "";

  const configuredEmail = config.admin.email;
  const configuredHash = config.admin.passwordHash;

  if (!configuredEmail || !configuredHash) {
    // Not configured, so nothing can match — but still pay the cost, so this
    // deployment does not answer "is an admin configured here?" in the timing.
    await verifyPassword(submittedPassword, DUMMY_HASH);
    return null;
  }

  const emailMatches = submittedEmail === normalizeEmail(configuredEmail);
  // Deliberately NOT short-circuited on emailMatches.
  const passwordMatches = await verifyPassword(submittedPassword, configuredHash);

  return emailMatches && passwordMatches ? { email: configuredEmail } : null;
}

// ---------------------------------------------------------------------------
// Startup safety
// ---------------------------------------------------------------------------

export interface AdminAuthEnabled {
  enabled: true;
  /** Signs the session cookie and derives CSRF tokens. Never leaves this process. */
  sessionSecret: string;
  sessionTtlMs: number;
  /** As configured, for the log line. The comparison is case-insensitive. */
  email: string;
}

export interface AdminAuthDisabled {
  enabled: false;
  /** Why, in one sentence, for the log line and the 503 body. */
  reason: string;
}

export type AdminAuthState = AdminAuthEnabled | AdminAuthDisabled;

const MAX_SESSION_TTL_HOURS = 24 * 30;

/**
 * Decide whether there is an admin surface at all, and refuse the in-between.
 *
 * THE RULE, and the reason this function exists: a deployment that is missing
 * its admin credentials must never end up serving an admin API that anyone can
 * call. There are exactly two outcomes here and neither of them is "open":
 *
 *   - NOTHING CONFIGURED -> DISABLED. No `ADMIN_EMAIL`, no
 *     `ADMIN_PASSWORD_HASH`, no `SESSION_SECRET` reads as "this deployment did
 *     not ask for an admin console". The routes are not registered, one loud
 *     line says so at boot, and every path under `/admin/api` answers 503 —
 *     including any route another module registers there, because the guard is
 *     a prefix hook on the root instance rather than a property of these
 *     routes. The attendee-facing API keeps running, which matters: an event is
 *     in progress and the badge flow does not depend on the console.
 *   - ANYTHING CONFIGURED, BUT WRONG -> REFUSE TO BOOT. One or two of the three
 *     variables set, a `SESSION_SECRET` too short to be worth signing with, a
 *     `ADMIN_PASSWORD_HASH` that is not a hash (a plaintext password pasted
 *     into the wrong variable is the realistic version of this) — all of them
 *     throw. The operator asked for an admin surface and got it wrong; silently
 *     disabling it would hide the mistake until the morning of the event, and
 *     silently accepting it is not on the table.
 *
 * Pure and exported so the decision can be tested without a server.
 */
export function resolveAdminAuth(config: AppConfig): AdminAuthState {
  const email = config.admin.email?.trim();
  const passwordHash = config.admin.passwordHash?.trim();
  const sessionSecret = config.admin.sessionSecret;

  const present = [
    ["ADMIN_EMAIL", email],
    ["ADMIN_PASSWORD_HASH", passwordHash],
    ["SESSION_SECRET", sessionSecret],
  ] as const;

  const missing = present.filter(([, value]) => !value).map(([key]) => key);

  if (missing.length === present.length) {
    return {
      enabled: false,
      reason:
        "ADMIN_EMAIL, ADMIN_PASSWORD_HASH and SESSION_SECRET are unset, so there is no admin " +
        "account to log in as.",
    };
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `The admin surface is partially configured: ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} missing. Refusing to start rather than ` +
        "guessing whether you wanted an admin API. Set all three (see `npm run admin:hash`), " +
        "or unset them all to run without an admin console.",
      { missing },
    );
  }

  // Non-null after the two guards above; narrow for the type checker.
  if (!email || !passwordHash || !sessionSecret) {
    throw new ConfigError("Admin credentials could not be read.", {});
  }

  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new ConfigError(
      `SESSION_SECRET is ${sessionSecret.length} characters; it must be at least ` +
        `${MIN_SESSION_SECRET_LENGTH}. It is the only thing standing between a forged cookie and ` +
        "the admin API. Generate one with `crypto.randomBytes(32).toString(\"hex\")` " +
        "(or `openssl rand -hex 32`).",
      { minLength: MIN_SESSION_SECRET_LENGTH },
    );
  }

  if (!parseScryptHash(passwordHash)) {
    throw new ConfigError(
      "ADMIN_PASSWORD_HASH is not a hash this build can read. It must look like " +
        "`scrypt$N=32768,r=8,p=1$<salt>$<hash>` — if you pasted the password itself in there, " +
        "run `npm run admin:hash` and paste what it prints. Refusing to start: every login " +
        "would fail and the reason would not be obvious.",
      {},
    );
  }

  if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw new ConfigError(
      `ADMIN_EMAIL does not look like an email address. It is the login name, so a typo here is ` +
        "a login nobody can perform.",
      {},
    );
  }

  const ttlHours = config.admin.sessionTtlHours;
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > MAX_SESSION_TTL_HOURS) {
    throw new ConfigError(
      `SESSION_TTL_HOURS must be between 1 and ${MAX_SESSION_TTL_HOURS}, got ${ttlHours}.`,
      { sessionTtlHours: ttlHours },
    );
  }

  return {
    enabled: true,
    sessionSecret,
    sessionTtlMs: Math.round(ttlHours * 3_600_000),
    email,
  };
}

/** Loopback hosts. Anything else is a deployment, whatever the operator calls it. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * `SECURE_COOKIES=false` is correct on plain-http localhost and catastrophic
 * anywhere else — the session cookie then travels in clear text on every
 * request, and anyone on the path can replay it. It cannot be inferred at
 * runtime (this process cannot see whether an ingress terminated TLS in front
 * of it), so it is config, and the best this can do is notice the combinations
 * that are almost certainly wrong and say so.
 */
function warnIfCookiesAreNotSecure(app: FastifyInstance, config: AppConfig): void {
  if (config.api.secureCookies) return;

  const reasons: string[] = [];
  if (!LOOPBACK_HOSTS.has(config.api.host)) reasons.push(`HOST=${config.api.host} is not loopback`);
  if (config.api.trustProxy !== false) reasons.push("TRUST_PROXY is set, so there is a proxy in front");
  if (config.network === "mainnet") reasons.push("XRPL_NETWORK=mainnet");

  if (reasons.length === 0) return;

  app.log.warn(
    `[admin] SECURE_COOKIES IS FALSE AND THIS DOES NOT LOOK LIKE LOCALHOST (${reasons.join("; ")}). ` +
      "The admin session cookie will be sent over plain HTTP and anyone on the network path can " +
      "copy it and become the admin. Set SECURE_COOKIES=true once you are behind HTTPS.",
  );
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

interface CookieOptions {
  httpOnly: boolean;
  sameSite: "lax";
  path: string;
  secure: boolean;
  maxAge: number;
  signed?: boolean;
}

/**
 * The session cookie.
 *
 * `httpOnly` so script cannot read it, `sameSite: "lax"` so it does not ride
 * along on a cross-site POST, `path: "/"` because the admin HTML and the admin
 * API do not have to share a prefix forever, and `secure` from config —
 * hardcoding it either way breaks one of the two deployments this app has (a
 * Secure cookie is simply never sent over http, and the symptom is a login that
 * appears to do nothing at all).
 */
export function sessionCookieOptions(config: AppConfig, ttlMs: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: config.api.secureCookies,
    maxAge: Math.floor(ttlMs / 1000),
    signed: true,
  };
}

/**
 * The CSRF cookie. Same flags EXCEPT `httpOnly`, which is off on purpose: the
 * admin UI has to read this value out of `document.cookie` to echo it back in
 * the `x-csrf-token` header. It is not a credential — see below.
 */
export function csrfCookieOptions(config: AppConfig, ttlMs: number): CookieOptions {
  return {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    secure: config.api.secureCookies,
    maxAge: Math.floor(ttlMs / 1000),
  };
}

// ---------------------------------------------------------------------------
// CSRF
//
// Double submit: a `poap_csrf` cookie the admin UI can read, echoed back in an
// `x-csrf-token` header on every request that changes something. No header, or
// a header that does not match, is a 403.
//
// WHY SAMESITE=LAX IS NOT ENOUGH ON ITS OWN. It is most of the protection on
// this deployment today and none of it on some plausible tomorrow:
//
//   - It is enforced by the BROWSER, not by us. Every request that reaches this
//     process is a request some client decided to send: an old browser, an
//     in-app webview, a native client or a proxy that does not implement
//     SameSite hands the cookie over anyway. A server-side check is a fact
//     about the request; SameSite is a hope about the client.
//   - LAX IS SAME-SITE, NOT SAME-ORIGIN. Once this is deployed under a real
//     domain, every sibling subdomain is "same site" for cookie purposes. An
//     XSS or a takeover on any `*.example.com` — a marketing page, a status
//     page, something nobody is watching — can post to the admin API with the
//     session cookie attached, and Lax will not blink.
//   - Lax exempts top-level GET navigation. Anything state-changing that ever
//     becomes reachable by GET (a convenience link, a redirect) loses the
//     protection entirely.
//   - The day the console is embedded anywhere, `SameSite=None` becomes
//     necessary and Lax's protection is gone in one config change.
//
// WHY THE COOKIE IS NOT WHAT WE COMPARE AGAINST. Naive double submit compares
// the header to the cookie, which fails against exactly the attacker in the
// second bullet: a same-site subdomain can WRITE cookies on the parent domain,
// so it can set both halves and match itself. So the expected token here is
// derived — HMAC(SESSION_SECRET, session id) — and the header is compared
// against that derivation. An attacker who cannot read the session id and does
// not have the secret cannot produce it, and injecting a `poap_csrf` cookie
// buys them nothing. The cookie remains as the delivery mechanism, which is all
// it ever was.
// ---------------------------------------------------------------------------

/**
 * The CSRF token for one session. Deterministic, so it never has to be stored
 * next to the session (`SessionStore` has no field for it) and can be re-issued
 * to a UI that lost its cookie. Rotates with the session id for free.
 */
export function csrfTokenFor(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionId}`).digest("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Request decoration
// ---------------------------------------------------------------------------

declare module "fastify" {
  interface FastifyRequest {
    /** The logged-in operator, or null. Set on every request by the guard. */
    admin: AdminIdentity | null;
    /** The session behind `admin`. Needed to revoke it, and to derive CSRF. */
    adminSession: SessionRecord | null;
  }
}

/**
 * Error bodies, in the same `{ error: { code, message } }` shape as the rest of
 * the API. Built here rather than through `sendError()` because these codes
 * (`UNAUTHORIZED`, `FORBIDDEN`, `ADMIN_DISABLED`) are not in `ApiErrorCode` and
 * src/errors.ts is not this change's file to edit — see the summary. The
 * messages are constants, so there is nothing to scrub.
 */
export function sendAuthError(
  reply: FastifyReply,
  status: number,
  code: "UNAUTHORIZED" | "FORBIDDEN" | "ADMIN_DISABLED",
  message: string,
): FastifyReply {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.code(status).send(body);
}

const UNAUTHORIZED_MESSAGE = "Not signed in. POST /admin/api/login first.";

/**
 * preHandler for admin routes. The prefix guard below already covers everything
 * under `/admin/api`, so this is for a route that lives somewhere else and
 * still wants an operator behind it — and it is cheap insurance if the prefix
 * ever moves.
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  if (request.admin) return undefined;
  return sendAuthError(reply, 401, "UNAUTHORIZED", UNAUTHORIZED_MESSAGE);
}

/** Strip the query string and collapse `//`, so the prefix test cannot be dodged. */
export function pathnameOf(url: string): string {
  const withoutQuery = url.split("?")[0] ?? "";
  return withoutQuery.replace(/\/{2,}/g, "/");
}

export function isAdminApiPath(url: string): boolean {
  const path = pathnameOf(url);
  return path === ADMIN_API_PREFIX || path.startsWith(`${ADMIN_API_PREFIX}/`);
}

/** Trailing slashes are the same route to fastify; treat them the same here. */
function isLoginPath(path: string): boolean {
  return path === LOGIN_PATH || path === `${LOGIN_PATH}/`;
}

// ---------------------------------------------------------------------------
// Session lookup
// ---------------------------------------------------------------------------

/**
 * Read the session cookie off the request, if there is a valid one.
 *
 * The cookie header is parsed HERE rather than read from `request.cookies`.
 * @fastify/cookie populates `request.cookies` from its own onRequest hook, and
 * hook order is registration order: this guard is added with `addHook()`, which
 * takes effect immediately, while the plugin's hook is added later during boot.
 * `app.parseCookie()` is a decorator, so it is there regardless of ordering.
 */
async function readSession(
  app: FastifyInstance,
  deps: ApiDeps,
  request: FastifyRequest,
): Promise<SessionRecord | null> {
  const header = request.headers.cookie;
  if (!header) return null;

  const raw = app.parseCookie(header)[SESSION_COOKIE];
  if (!raw) return null;

  // A tampered value fails here, before anything touches the session store.
  const unsigned = app.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;

  const sessions = deps.sessions;
  if (!sessions) return null;

  const record = await sessions.get(unsigned.value);
  if (!record) return null;

  // The store is expected to enforce this; a second look costs nothing and
  // covers a store whose clock or query drifted.
  if (new Date(record.expiresAt).getTime() <= Date.now()) return null;

  return record;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Wire admin authentication onto an instance and report what it decided.
 *
 * MUST be called on the ROOT instance, and before the admin routes are
 * registered. The guard is an `onRequest` hook keyed on the URL prefix, not a
 * per-route preHandler, and that is the whole point: any route that any module
 * registers under `/admin/api` is covered, including ones written after this
 * file. A route cannot forget to ask for authentication, and a deployment with
 * no credentials cannot serve one.
 *
 * Synchronous on purpose — `buildServer()` is synchronous, and fastify defers
 * `register()` until boot anyway.
 */
export function registerAdminAuth(app: FastifyInstance, deps: ApiDeps): AdminAuthState {
  // Always decorated, even when the surface is off, so nothing has to guard a
  // read of `request.admin`.
  app.decorateRequest("admin", null);
  app.decorateRequest("adminSession", null);

  const state = resolveAdminAuth(deps.config);

  if (!state.enabled) {
    app.log.warn(
      `[admin] ADMIN SURFACE DISABLED — ${state.reason} Every request under ${ADMIN_API_PREFIX} ` +
        "will answer 503. Nothing there is being served without a login. Configure ADMIN_EMAIL, " +
        "ADMIN_PASSWORD_HASH (npm run admin:hash) and SESSION_SECRET to switch it on.",
    );

    const refuse = async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
      sendAuthError(
        reply,
        503,
        "ADMIN_DISABLED",
        "The admin API is disabled on this deployment because no admin credentials are " +
          "configured. It is switched off rather than left open.",
      );

    // Two layers, because they cover different things. The hook catches admin
    // routes some other module registered — it runs before their handler, so
    // they cannot be reached unauthenticated. The wildcard routes catch paths
    // where no route exists at all, so the answer is a deliberate 503 rather
    // than a 404 that reads like "not deployed yet".
    app.addHook("onRequest", async (request, reply) => {
      if (!isAdminApiPath(request.url)) return undefined;
      return refuse(request, reply);
    });
    app.all(ADMIN_API_PREFIX, refuse);
    app.all(`${ADMIN_API_PREFIX}/*`, refuse);

    return state;
  }

  if (!deps.sessions) {
    throw new ConfigError(
      "Admin credentials are configured but no SessionStore was supplied to the API. " +
        "Refusing to start: sessions cannot be issued, and an admin surface that cannot " +
        "authenticate must not be served.",
      {},
    );
  }

  warnIfCookiesAreNotSecure(app, deps.config);

  // The secret goes to the cookie signer and nowhere else.
  app.register(cookie, { secret: state.sessionSecret, hook: "onRequest" });

  app.addHook("onRequest", async (request, reply) => {
    if (!isAdminApiPath(request.url)) return undefined;

    const session = await readSession(app, deps, request);
    request.adminSession = session;
    request.admin = session ? { email: session.email } : null;

    // Login is the one door that opens without a session. It has no CSRF check
    // either: there is no token to have yet, and with a single account "log the
    // victim in as themselves" is not an attack. SameSite=Lax covers the
    // cross-site POST case for browsers that implement it.
    if (isLoginPath(pathnameOf(request.url))) return undefined;

    if (!session) return sendAuthError(reply, 401, "UNAUTHORIZED", UNAUTHORIZED_MESSAGE);

    if (!SAFE_METHODS.has(request.method)) {
      const supplied = request.headers[CSRF_HEADER];
      const token = typeof supplied === "string" ? supplied : "";
      const expected = csrfTokenFor(session.id, state.sessionSecret);
      if (!token || !constantTimeEquals(token, expected)) {
        return sendAuthError(
          reply,
          403,
          "FORBIDDEN",
          `This request needs a matching ${CSRF_HEADER} header. Read the ${CSRF_COOKIE} cookie ` +
            "and send its value back in that header on every non-GET admin request.",
        );
      }
    }

    return undefined;
  });

  return state;
}

// ---------------------------------------------------------------------------
// Issue and clear — used by the login and logout routes
// ---------------------------------------------------------------------------

/**
 * Create a session and put both cookies on the reply.
 *
 * Always a NEW session id. Nothing from the incoming request is reused, which
 * is the fix for session fixation: an attacker who can plant a cookie in the
 * victim's browser before they log in must not end up holding a cookie that is
 * valid afterwards. The caller revokes whatever the request arrived with.
 */
export async function issueSession(
  reply: FastifyReply,
  deps: ApiDeps,
  state: AdminAuthEnabled,
  email: string,
): Promise<SessionRecord> {
  const sessions = deps.sessions;
  if (!sessions) {
    throw new ConfigError("No SessionStore is configured; cannot issue an admin session.", {});
  }

  const session = await sessions.create(email, state.sessionTtlMs);

  reply.setCookie(SESSION_COOKIE, session.id, sessionCookieOptions(deps.config, state.sessionTtlMs));
  reply.setCookie(
    CSRF_COOKIE,
    csrfTokenFor(session.id, state.sessionSecret),
    csrfCookieOptions(deps.config, state.sessionTtlMs),
  );

  return session;
}

/** Re-send the CSRF cookie for an existing session. Cheap, deterministic. */
export function refreshCsrfCookie(
  reply: FastifyReply,
  deps: ApiDeps,
  state: AdminAuthEnabled,
  session: SessionRecord,
): void {
  reply.setCookie(
    CSRF_COOKIE,
    csrfTokenFor(session.id, state.sessionSecret),
    csrfCookieOptions(deps.config, state.sessionTtlMs),
  );
}

/**
 * Drop both cookies. The attributes have to match the ones they were set with
 * or the browser keeps the originals and the user stays "logged in" against a
 * session that no longer exists.
 */
export function clearSessionCookies(reply: FastifyReply, config: AppConfig): void {
  const base = { path: "/", sameSite: "lax" as const, secure: config.api.secureCookies };
  reply.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true });
  reply.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
}
