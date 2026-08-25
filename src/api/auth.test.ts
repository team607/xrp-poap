/**
 * Admin authentication tests.
 *
 * Everything here runs against a real fastify instance built by buildServer(),
 * driven with `inject`, and backed by an in-file SessionStore. No network, no
 * database, no clock mocking. The password hashing is real — scrypt at the
 * shipped parameters is ~100ms, so one hash is made in beforeAll and reused.
 *
 * The three things worth breaking a build over, and the reason each test below
 * exists:
 *
 *   1. A misconfigured deployment must never serve an open admin API.
 *   2. A wrong email and a wrong password must be indistinguishable.
 *   3. The password, the hash and the session secret must not appear in a
 *      response body or in a log line, ever.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { LightMyRequestResponse } from "fastify";
import { MockGateway } from "../../test/helpers/mock-gateway.js";
import type { AppConfig } from "../config.js";
import { ConfigError, XrplLayerError } from "../errors.js";
import type {
  AttendanceRecord,
  AttendanceRepository,
  ClaimRecord,
  ClaimRepository,
  EventId,
  SessionRecord,
  SessionStore,
  SponsorLedger,
  SponsorReservation,
  SponsorReserveInput,
} from "../types.js";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  csrfTokenFor,
  hashPassword,
  parseScryptHash,
  resolveAdminAuth,
  verifyAdminCredentials,
  verifyPassword,
} from "./auth.js";
import { buildLoggerOptions, type ApiDeps, type ChainOps } from "./deps.js";
import { buildServer } from "./server.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = "rwukQtEt5yj9QGTBSoLWuBvVpPh5nNPpN4";
const FAKE_SEED = "sEdV6Xn3bRq9J2wY4tK8mZpL1cH7dQa";

const ADMIN_EMAIL = "organiser@example.com";
const ADMIN_PASSWORD = "correct horse battery staple";
const SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** Built once: scrypt at the shipped parameters is ~100ms a go. */
let ADMIN_PASSWORD_HASH = "";

beforeAll(async () => {
  ADMIN_PASSWORD_HASH = await hashPassword(ADMIN_PASSWORD);
});

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    endpoint: "wss://clio.altnet.rippletest.net:51233",
    fallbackEndpoints: [],
    network: "testnet",
    issuerAddress: ISSUER,
    issuerSeed: FAKE_SEED,
    sponsor: { enabled: false, amountXrp: "1.5", dailyCapXrp: "50" },
    pinata: { gateway: "https://gateway.pinata.cloud" },
    xumm: {},
    demoEnabled: false,
    badgeImageUriMode: "https" as const,
    badgeMetadataUriMode: "https" as const,
    admin: { sessionTtlHours: 12 },
    api: { port: 0, host: "127.0.0.1", trustProxy: false, secureCookies: false },
    ...overrides,
  };
}

/** A config with the admin surface switched on. */
function adminConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return testConfig({
    admin: {
      email: ADMIN_EMAIL,
      passwordHash: ADMIN_PASSWORD_HASH,
      sessionSecret: SESSION_SECRET,
      sessionTtlHours: 12,
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fakes
//
// Only what the server needs to be constructible. The claim/attendance/sponsor
// fakes are throwaway: nothing in this file touches those routes.
// ---------------------------------------------------------------------------

const unusedRepo = {
  async insert(record: AttendanceRecord): Promise<AttendanceRecord> {
    return record;
  },
  async findByEventAndAddress(): Promise<AttendanceRecord | null> {
    return null;
  },
  async listByEvent(): Promise<AttendanceRecord[]> {
    return [];
  },
  async countByEvent(): Promise<number> {
    return 0;
  },
  async listByAddress(): Promise<AttendanceRecord[]> {
    return [];
  },
} satisfies AttendanceRepository;

const unusedClaims = {
  async open(): Promise<ClaimRecord | null> {
    return null;
  },
  async find(): Promise<ClaimRecord | null> {
    return null;
  },
  async attach(): Promise<void> {},
  async markClaimed(): Promise<void> {},
  async markAbandoned(): Promise<void> {},
  async listExpired(): Promise<ClaimRecord[]> {
    return [];
  },
  async delete(): Promise<void> {},
} satisfies ClaimRepository;

const unusedSponsorLedger = {
  async hasSponsored(): Promise<boolean> {
    return false;
  },
  async sponsoredTodayXrp(): Promise<string> {
    return "0";
  },
  async reserve(_input: SponsorReserveInput): Promise<SponsorReservation | null> {
    return null;
  },
  async confirm(): Promise<void> {},
  async release(): Promise<void> {},
} satisfies SponsorLedger;

const unusedChain: ChainOps = {
  async mint() {
    throw new XrplLayerError("TX_FAILED", "not used in these tests");
  },
  async createClaimOffer() {
    throw new XrplLayerError("TX_FAILED", "not used in these tests");
  },
  async accountExists() {
    return true;
  },
  async sponsorWallet() {
    throw new XrplLayerError("TX_FAILED", "not used in these tests");
  },
  async verifyClaim() {
    throw new XrplLayerError("TX_FAILED", "not used in these tests");
  },
  async getRoster(_gateway, eventId: EventId) {
    return {
      eventId,
      issuer: ISSUER,
      entries: [],
      minted: 0,
      claimed: 0,
      burned: 0,
      ownerUnknown: 0,
    };
  },
};

/**
 * An in-memory SessionStore, shaped like the Pg one another module is building.
 *
 * `get()` returns null for unknown, revoked and expired ids — the contract in
 * src/types.ts. `expireNext` forces the one case a correct store should never
 * produce, so the guard's own expiry check is exercised too.
 */
class FakeSessionStore implements SessionStore {
  readonly rows = new Map<string, SessionRecord>();
  /** Hand back an already-expired record on the next get(), whatever the store thinks. */
  leakExpired = false;
  private seq = 0;

  async create(email: string, ttlMs: number): Promise<SessionRecord> {
    this.seq += 1;
    const now = new Date();
    const record: SessionRecord = {
      id: `session-${this.seq}-${Math.random().toString(36).slice(2, 10)}`,
      email,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    };
    this.rows.set(record.id, record);
    return { ...record };
  }

  async get(id: string): Promise<SessionRecord | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    if (this.leakExpired) {
      return { ...row, expiresAt: new Date(Date.now() - 1000) };
    }
    if (row.expiresAt.getTime() <= Date.now()) return null;
    row.lastSeenAt = new Date();
    return { ...row };
  }

  async revoke(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async revokeAll(email: string): Promise<void> {
    for (const [id, row] of this.rows) if (row.email === email) this.rows.delete(id);
  }

  async purgeExpired(now = new Date()): Promise<number> {
    let purged = 0;
    for (const [id, row] of this.rows) {
      if (row.expiresAt.getTime() <= now.getTime()) {
        this.rows.delete(id);
        purged += 1;
      }
    }
    return purged;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  app: FastifyInstance;
  deps: ApiDeps;
  sessions: FakeSessionStore;
  lines: string[];
  log(): string;
}

function harness(
  options: { config?: AppConfig; deps?: Partial<ApiDeps>; captureLogs?: boolean } = {},
): Harness {
  const sessions = new FakeSessionStore();
  const lines: string[] = [];

  const deps: ApiDeps = {
    config: options.config ?? adminConfig(),
    gateway: new MockGateway({ issuerAddress: ISSUER }),
    attendance: unusedRepo,
    claims: unusedClaims,
    sponsorLedger: unusedSponsorLedger,
    sessions,
    chain: unusedChain,
    rateLimit: { enabled: false },
    // The logger that ships, pointed at an array — so what is asserted about
    // the log sink is the configuration that runs in production.
    ...(options.captureLogs
      ? {
          logger: {
            ...buildLoggerOptions("trace"),
            stream: {
              write(line: string) {
                lines.push(line);
              },
            },
          },
        }
      : {}),
    ...options.deps,
  };

  return { app: buildServer(deps), deps, sessions, lines, log: () => lines.join("") };
}

// ---------------------------------------------------------------------------
// Cookie plumbing
// ---------------------------------------------------------------------------

function setCookieHeaders(res: LightMyRequestResponse): string[] {
  const raw = res.headers["set-cookie"];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

/** The raw `name=value` pair, byte for byte, ready to replay as a Cookie header. */
function rawPair(res: LightMyRequestResponse, name: string): string | undefined {
  const header = setCookieHeaders(res).find((line) => line.startsWith(`${name}=`));
  return header?.split(";")[0];
}

function cookieValue(res: LightMyRequestResponse, name: string): string | undefined {
  const pair = rawPair(res, name);
  return pair === undefined ? undefined : pair.slice(name.length + 1);
}

/** Parsed attributes of one Set-Cookie, as fastify's inject reports them. */
function cookieAttrs(res: LightMyRequestResponse, name: string) {
  const found = res.cookies.find((c) => c.name === name);
  if (!found) throw new Error(`no ${name} cookie was set`);
  return found;
}

/** A cookie jar: everything the browser would send back. */
function jar(res: LightMyRequestResponse): string {
  return setCookieHeaders(res)
    .map((line) => line.split(";")[0])
    .filter((pair): pair is string => pair !== undefined && !pair.endsWith("="))
    .join("; ");
}

async function login(
  h: Harness,
  body: { email?: string; password?: string } = {},
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: "POST",
    url: "/admin/api/login",
    headers,
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, ...body },
  });
}

/** Log in and return everything a subsequent request needs. */
async function signedIn(h: Harness): Promise<{ cookie: string; csrf: string }> {
  const res = await login(h);
  expect(res.statusCode).toBe(200);
  const csrf = cookieValue(res, CSRF_COOKIE);
  expect(csrf).toBeTruthy();
  return { cookie: jar(res), csrf: csrf as string };
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

describe("hashPassword / verifyPassword", () => {
  it("round trips", async () => {
    expect(await verifyPassword(ADMIN_PASSWORD, ADMIN_PASSWORD_HASH)).toBe(true);
  });

  it("encodes the algorithm and every parameter, so they can be raised later", () => {
    expect(ADMIN_PASSWORD_HASH.startsWith("scrypt$N=32768,r=8,p=1$")).toBe(true);
    expect(ADMIN_PASSWORD_HASH.split("$")).toHaveLength(4);

    const parsed = parseScryptHash(ADMIN_PASSWORD_HASH);
    expect(parsed?.params).toEqual({ N: 32_768, r: 8, p: 1 });
    expect(parsed?.salt).toHaveLength(16);
    expect(parsed?.hash).toHaveLength(64);
  });

  it("salts randomly: the same password hashes to two different strings", async () => {
    const again = await hashPassword(ADMIN_PASSWORD);
    expect(again).not.toBe(ADMIN_PASSWORD_HASH);
    expect(await verifyPassword(ADMIN_PASSWORD, again)).toBe(true);
  });

  it("refuses to mint a hash for a password under 12 characters", async () => {
    await expect(hashPassword("short")).rejects.toBeInstanceOf(XrplLayerError);
  });

  it("returns false — never throws — for a wrong password", async () => {
    expect(await verifyPassword("not the password", ADMIN_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword("", ADMIN_PASSWORD_HASH)).toBe(false);
    // One byte off, same length: the comparison is not a prefix match.
    expect(await verifyPassword(`${ADMIN_PASSWORD.slice(0, -1)}X`, ADMIN_PASSWORD_HASH)).toBe(false);
  });

  it.each([
    ["an empty string", ""],
    ["a truncated hash", ADMIN_PASSWORD_HASH.slice(0, 20)],
    ["a hash missing its salt", "scrypt$N=32768,r=8,p=1$$abcd"],
    ["a hash with no parameters", "scrypt$$abcd$abcd"],
    ["an unknown algorithm", "argon2id$m=65536,t=3,p=4$c2FsdA$aGFzaA"],
    ["an unknown parameter", "scrypt$N=32768,r=8,p=1,q=7$c2FsdA$aGFzaA"],
    ["a non-numeric parameter", "scrypt$N=lots,r=8,p=1$c2FsdA$aGFzaA"],
    ["an N that is not a power of two", "scrypt$N=32767,r=8,p=1$c2FsdA$aGFzaA"],
    ["an absurd N", "scrypt$N=1073741824,r=8,p=1$c2FsdA$aGFzaA"],
    ["a plaintext password pasted into the wrong variable", "correct horse battery staple"],
    ["garbage", "$$$$$$"],
  ])("returns false and does not throw for %s", async (_label, stored) => {
    await expect(verifyPassword(ADMIN_PASSWORD, stored)).resolves.toBe(false);
    expect(parseScryptHash(stored)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyAdminCredentials
// ---------------------------------------------------------------------------

describe("verifyAdminCredentials", () => {
  it("accepts the configured credentials", async () => {
    const identity = await verifyAdminCredentials(adminConfig(), ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(identity).toEqual({ email: ADMIN_EMAIL });
  });

  it("compares the email case- and whitespace-insensitively", async () => {
    const identity = await verifyAdminCredentials(
      adminConfig(),
      `  ${ADMIN_EMAIL.toUpperCase()} `,
      ADMIN_PASSWORD,
    );
    expect(identity).toEqual({ email: ADMIN_EMAIL });
  });

  it("rejects a wrong password and a wrong email alike", async () => {
    expect(await verifyAdminCredentials(adminConfig(), ADMIN_EMAIL, "wrong")).toBeNull();
    expect(await verifyAdminCredentials(adminConfig(), "someone@else.test", ADMIN_PASSWORD)).toBeNull();
  });

  it("returns null when no admin is configured", async () => {
    expect(await verifyAdminCredentials(testConfig(), ADMIN_EMAIL, ADMIN_PASSWORD)).toBeNull();
  });

  /**
   * The timing channel. A wrong email must not be cheaper than a wrong
   * password, or the endpoint answers "is this the admin's address?".
   *
   * Asserted as a floor rather than an equality: scrypt is ~100ms and skipping
   * it is under a millisecond, so anything in the same order of magnitude
   * proves the hash ran. An equality assertion here would be a flaky test
   * pretending to be a security control.
   */
  it("spends the same scrypt on a wrong email as on a wrong password", async () => {
    const config = adminConfig();

    const t0 = performance.now();
    await verifyAdminCredentials(config, ADMIN_EMAIL, "wrong password entirely");
    const wrongPassword = performance.now() - t0;

    const t1 = performance.now();
    await verifyAdminCredentials(config, "nobody@example.com", "wrong password entirely");
    const wrongEmail = performance.now() - t1;

    expect(wrongEmail).toBeGreaterThan(wrongPassword * 0.25);
  });
});

// ---------------------------------------------------------------------------
// Startup safety
// ---------------------------------------------------------------------------

describe("startup safety", () => {
  it("disables the admin surface when nothing is configured", () => {
    const state = resolveAdminAuth(testConfig());
    expect(state.enabled).toBe(false);
  });

  it("enables it when all three are configured", () => {
    const state = resolveAdminAuth(adminConfig());
    expect(state).toMatchObject({ enabled: true, email: ADMIN_EMAIL, sessionTtlMs: 12 * 3_600_000 });
  });

  it.each([
    ["ADMIN_EMAIL missing", { passwordHash: "x", sessionSecret: SESSION_SECRET }],
    ["ADMIN_PASSWORD_HASH missing", { email: ADMIN_EMAIL, sessionSecret: SESSION_SECRET }],
    ["SESSION_SECRET missing", { email: ADMIN_EMAIL, passwordHash: "x" }],
  ])("refuses to boot when the config is half-set (%s)", (_label, admin) => {
    const config = testConfig({ admin: { ...admin, sessionTtlHours: 12 } });
    expect(() => resolveAdminAuth(config)).toThrow(ConfigError);
    // And the same failure takes the whole server down, rather than a request
    // discovering it later.
    expect(() => harness({ config })).toThrow(ConfigError);
  });

  it("refuses a SESSION_SECRET shorter than 32 characters", () => {
    const config = adminConfig({
      admin: {
        email: ADMIN_EMAIL,
        passwordHash: ADMIN_PASSWORD_HASH,
        sessionSecret: "a".repeat(31),
        sessionTtlHours: 12,
      },
    });
    expect(() => resolveAdminAuth(config)).toThrow(/at least 32/);
  });

  it("refuses a plaintext password pasted into ADMIN_PASSWORD_HASH", () => {
    const config = adminConfig({
      admin: {
        email: ADMIN_EMAIL,
        passwordHash: ADMIN_PASSWORD,
        sessionSecret: SESSION_SECRET,
        sessionTtlHours: 12,
      },
    });
    expect(() => resolveAdminAuth(config)).toThrow(/not a hash/);
  });

  it("refuses an ADMIN_EMAIL that is not an email, and a nonsense TTL", () => {
    const base = {
      passwordHash: ADMIN_PASSWORD_HASH,
      sessionSecret: SESSION_SECRET,
      sessionTtlHours: 12,
    };
    expect(() =>
      resolveAdminAuth(adminConfig({ admin: { ...base, email: "organiser" } })),
    ).toThrow(ConfigError);
    expect(() =>
      resolveAdminAuth(adminConfig({ admin: { ...base, email: ADMIN_EMAIL, sessionTtlHours: 0 } })),
    ).toThrow(ConfigError);
  });

  it("refuses to serve an admin surface with no session store", () => {
    expect(() => harness({ deps: { sessions: undefined } })).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// The admin surface, switched off
// ---------------------------------------------------------------------------

describe("admin config absent", () => {
  it("does not serve the admin API — 503, never 200", async () => {
    const h = harness({ config: testConfig() });

    for (const [method, url] of [
      ["GET", "/admin/api/me"],
      ["POST", "/admin/api/login"],
      ["POST", "/admin/api/logout"],
      ["GET", "/admin/api/events"],
      ["POST", "/admin/api/events"],
      ["GET", "/admin/api"],
    ] as const) {
      const res = await h.app.inject({
        method,
        url,
        payload: method === "POST" ? { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      expect(res.json().error.code).toBe("ADMIN_DISABLED");
    }
  });

  /**
   * The guard is a prefix hook on the root instance, not a preHandler on the
   * routes in this change. That is the whole design: a route registered by some
   * other module — the registration API, an event editor written next month —
   * is covered without knowing this file exists.
   */
  it("503s an admin route registered by another module", async () => {
    const h = harness({ config: testConfig() });
    h.app.get("/admin/api/registrations", async () => ({ leaked: "everything" }));

    const res = await h.app.inject({ method: "GET", url: "/admin/api/registrations" });

    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("leaked");
  });

  it("leaves the attendee-facing API alone", async () => {
    const h = harness({ config: testConfig() });
    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("says so once, loudly, at boot", async () => {
    const h = harness({ config: testConfig(), captureLogs: true });
    await h.app.ready();

    expect(h.log()).toContain("ADMIN SURFACE DISABLED");
    const shouting = h.lines.filter((line) => line.includes("ADMIN SURFACE DISABLED"));
    expect(shouting).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

describe("POST /admin/api/login", () => {
  it("signs in and returns the email", async () => {
    const h = harness();
    const res = await login(h);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: ADMIN_EMAIL });
    expect(h.sessions.rows.size).toBe(1);
  });

  it("sets an httpOnly, signed, lax, path-scoped session cookie", async () => {
    const h = harness();
    const res = await login(h);

    const session = cookieAttrs(res, SESSION_COOKIE);
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite?.toLowerCase()).toBe("lax");
    expect(session.path).toBe("/");
    expect(session.maxAge).toBe(12 * 3600);

    // Signed: the cookie is the session id plus a signature, and the raw id on
    // its own is not what travels.
    const [storedId] = [...h.sessions.rows.keys()];
    const raw = decodeURIComponent(cookieValue(res, SESSION_COOKIE) ?? "");
    expect(storedId).toBeTruthy();
    expect(raw).not.toBe(storedId);
    expect(raw.startsWith(`${storedId}.`)).toBe(true);
  });

  it("sets a CSRF cookie that JS can read", async () => {
    const h = harness();
    const res = await login(h);

    const csrf = cookieAttrs(res, CSRF_COOKIE);
    expect(csrf.httpOnly).toBeFalsy();
    expect(csrf.value).toBeTruthy();

    const [storedId] = [...h.sessions.rows.keys()];
    expect(csrf.value).toBe(csrfTokenFor(storedId as string, SESSION_SECRET));
  });

  it.each([true, false])("follows config.api.secureCookies (%s) on both cookies", async (secure) => {
    const h = harness({ config: adminConfig({ api: { port: 0, host: "127.0.0.1", trustProxy: false, secureCookies: secure } }) });
    const res = await login(h);

    expect(cookieAttrs(res, SESSION_COOKIE).secure ?? false).toBe(secure);
    expect(cookieAttrs(res, CSRF_COOKIE).secure ?? false).toBe(secure);
  });

  it("answers a wrong email exactly as it answers a wrong password", async () => {
    const h = harness();

    const wrongPassword = await login(h, { password: "nope nope nope" });
    const wrongEmail = await login(h, { email: "someone@else.test", password: "nope nope nope" });
    const wrongEmailRightPassword = await login(h, { email: "someone@else.test" });

    for (const res of [wrongPassword, wrongEmail, wrongEmailRightPassword]) {
      expect(res.statusCode).toBe(401);
      expect(res.headers["content-type"]).toBe(wrongPassword.headers["content-type"]);
      expect(res.body).toBe(wrongPassword.body);
      expect(setCookieHeaders(res)).toHaveLength(0);
    }

    // Nothing in the body names the account, or says which half was wrong.
    const body = wrongEmail.body.toLowerCase();
    expect(body).not.toContain("email address");
    expect(body).not.toContain("unknown");
    expect(body).not.toContain("no such");
    expect(body).not.toContain(ADMIN_EMAIL);
    expect(h.sessions.rows.size).toBe(0);
  });

  it("rotates the session id, and kills the one the request arrived with", async () => {
    const h = harness();

    const first = await login(h);
    const firstJar = jar(first);
    const [firstId] = [...h.sessions.rows.keys()];

    const second = await login(h, {}, { cookie: firstJar });
    const secondId = [...h.sessions.rows.keys()][0];

    expect(second.statusCode).toBe(200);
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    // The old session is gone from the store, not merely overwritten in the jar.
    expect(h.sessions.rows.size).toBe(1);
    expect(h.sessions.rows.has(firstId as string)).toBe(false);

    const withOldCookie = await h.app.inject({
      method: "GET",
      url: "/admin/api/me",
      headers: { cookie: firstJar },
    });
    expect(withOldCookie.statusCode).toBe(401);
  });

  /**
   * The limiter is off in every other test here (`rateLimit.enabled: false`),
   * which is exactly why these two exist: an untested rate limit on a password
   * endpoint is a claim, not a control.
   */
  it("rate limits by source IP", async () => {
    const h = harness({
      deps: {
        rateLimit: {
          enabled: true,
          global: { max: 1000, timeWindow: "1 minute" },
          login: { max: 2, timeWindow: "1 minute" },
        },
      },
    });

    const attempt = () => login(h, { password: "wrong every time" });

    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);

    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    // And a correct password does not buy a way past it.
    expect((await login(h)).statusCode).toBe(429);
  });

  it("rate limits by email too, so rotating source addresses does not help", async () => {
    const h = harness({
      deps: {
        rateLimit: {
          enabled: true,
          global: { max: 1000, timeWindow: "1 minute" },
          // Effectively unlimited per IP, so the only bucket left is the email.
          login: { max: 1000, timeWindow: "1 minute" },
        },
      },
    });

    // 21 attempts from 21 different addresses, against the 20-per-15-minutes
    // email bucket. Concurrent so the suite does not pay for 21 serial scrypts.
    const responses = await Promise.all(
      Array.from({ length: 21 }, (_unused, i) =>
        h.app.inject({
          method: "POST",
          url: "/admin/api/login",
          remoteAddress: `203.0.113.${i + 1}`,
          payload: { email: ADMIN_EMAIL, password: "wrong every time" },
        }),
      ),
    );

    const statuses = responses.map((res) => res.statusCode);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(20);
  });

  it("rejects a malformed body with a 400, without hashing anything", async () => {
    const h = harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/api/login",
      payload: { email: ADMIN_EMAIL },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
  });
});

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe("requireAdmin / the /admin/api guard", () => {
  it("401s with no cookie at all", async () => {
    const h = harness();
    const res = await h.app.inject({ method: "GET", url: "/admin/api/me" });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("401s a tampered signature without ever asking the session store", async () => {
    const h = harness();
    const res0 = await login(h);
    const pair = rawPair(res0, SESSION_COOKIE);
    expect(pair).toBeTruthy();

    // Flip the last character of the signature. The session id in front of it
    // is untouched and real — only the signature stops adding up.
    const last = (pair as string).slice(-1);
    const tampered = `${(pair as string).slice(0, -1)}${last === "A" ? "B" : "A"}`;

    let lookups = 0;
    const realGet = h.sessions.get.bind(h.sessions);
    h.sessions.get = async (id: string) => {
      lookups += 1;
      return realGet(id);
    };

    const res = await h.app.inject({
      method: "GET",
      url: "/admin/api/me",
      headers: { cookie: tampered },
    });

    expect(res.statusCode).toBe(401);
    expect(lookups).toBe(0);
  });

  it("401s a session the store does not know", async () => {
    const h = harness();
    const { cookie } = await signedIn(h);

    h.sessions.rows.clear();

    const res = await h.app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it("401s a session the store hands back expired", async () => {
    const h = harness();
    const { cookie } = await signedIn(h);

    h.sessions.leakExpired = true;

    const res = await h.app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it("lets a valid session through", async () => {
    const h = harness();
    const { cookie } = await signedIn(h);

    const res = await h.app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: ADMIN_EMAIL });
  });

  it("covers an admin route registered by another module", async () => {
    const h = harness();
    h.app.get("/admin/api/registrations", async () => ({ rows: [] }));

    const anonymous = await h.app.inject({ method: "GET", url: "/admin/api/registrations" });
    expect(anonymous.statusCode).toBe(401);

    const { cookie } = await signedIn(h);
    const authenticated = await h.app.inject({
      method: "GET",
      url: "/admin/api/registrations",
      headers: { cookie },
    });
    expect(authenticated.statusCode).toBe(200);
  });

  it("cannot be dodged with a doubled slash or a query string", async () => {
    const h = harness();
    for (const url of ["//admin/api/me", "/admin/api/me?cache=0"]) {
      const res = await h.app.inject({ method: "GET", url });
      expect([401, 404], url).toContain(res.statusCode);
      expect(res.statusCode, url).not.toBe(200);
    }
  });

  it("does not touch the attendee-facing API", async () => {
    const h = harness();
    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

describe("CSRF (double submit)", () => {
  it("403s a non-GET admin request with no header", async () => {
    const h = harness();
    const { cookie } = await signedIn(h);

    const res = await h.app.inject({ method: "POST", url: "/admin/api/logout", headers: { cookie } });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("403s a mismatched header", async () => {
    const h = harness();
    const { cookie, csrf } = await signedIn(h);

    const res = await h.app.inject({
      method: "POST",
      url: "/admin/api/logout",
      headers: { cookie, [CSRF_HEADER]: `${csrf.slice(0, -1)}x` },
    });

    expect(res.statusCode).toBe(403);
  });

  it("403s a CSRF token minted for someone else's session", async () => {
    const h = harness();
    const { cookie } = await signedIn(h);
    const other = csrfTokenFor("session-belonging-to-nobody", SESSION_SECRET);

    const res = await h.app.inject({
      method: "POST",
      url: "/admin/api/logout",
      headers: { cookie, [CSRF_HEADER]: other },
    });

    expect(res.statusCode).toBe(403);
  });

  it("accepts a matching header", async () => {
    const h = harness();
    const { cookie, csrf } = await signedIn(h);

    const res = await h.app.inject({
      method: "POST",
      url: "/admin/api/logout",
      headers: { cookie, [CSRF_HEADER]: csrf },
    });

    expect(res.statusCode).toBe(200);
  });

  it("exempts GET", async () => {
    const h = harness();
    const { cookie } = await signedIn(h);

    const res = await h.app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it("covers a write route registered by another module", async () => {
    const h = harness();
    h.app.post("/admin/api/events", async () => ({ created: true }));
    const { cookie, csrf } = await signedIn(h);

    const without = await h.app.inject({
      method: "POST",
      url: "/admin/api/events",
      headers: { cookie },
      payload: {},
    });
    expect(without.statusCode).toBe(403);

    const with_ = await h.app.inject({
      method: "POST",
      url: "/admin/api/events",
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: {},
    });
    expect(with_.statusCode).toBe(200);
  });

  it("is not required on login, which has no token yet", async () => {
    const h = harness();
    const res = await login(h);
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

describe("POST /admin/api/logout", () => {
  it("revokes the session: the same cookie stops working", async () => {
    const h = harness();
    const { cookie, csrf } = await signedIn(h);

    const before = await h.app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } });
    expect(before.statusCode).toBe(200);

    const out = await h.app.inject({
      method: "POST",
      url: "/admin/api/logout",
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(out.statusCode).toBe(200);
    expect(h.sessions.rows.size).toBe(0);

    const after = await h.app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("clears both cookies with the attributes they were set with", async () => {
    const h = harness();
    const { cookie, csrf } = await signedIn(h);

    const out = await h.app.inject({
      method: "POST",
      url: "/admin/api/logout",
      headers: { cookie, [CSRF_HEADER]: csrf },
    });

    for (const name of [SESSION_COOKIE, CSRF_COOKIE]) {
      const cleared = cookieAttrs(out, name);
      expect(cleared.value).toBe("");
      expect(cleared.path).toBe("/");
    }
  });

  it("needs a session of its own", async () => {
    const h = harness();
    const res = await h.app.inject({ method: "POST", url: "/admin/api/logout" });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/api/me
// ---------------------------------------------------------------------------

describe("GET /admin/api/me", () => {
  it("re-issues the CSRF cookie so a UI that lost it recovers", async () => {
    const h = harness();
    const { cookie, csrf } = await signedIn(h);

    const res = await h.app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(cookieValue(res, CSRF_COOKIE)).toBe(csrf);
    expect(setCookieHeaders(res).some((line) => line.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Nothing secret leaves the process
// ---------------------------------------------------------------------------

describe("secrets", () => {
  it("never puts the password, the hash or the session secret in a response", async () => {
    const h = harness();

    const responses = [
      await login(h),
      await login(h, { password: "wrong one" }),
      await h.app.inject({ method: "GET", url: "/admin/api/me" }),
      await h.app.inject({ method: "GET", url: "/health" }),
    ];

    const { cookie, csrf } = await signedIn(h);
    responses.push(
      await h.app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } }),
      await h.app.inject({
        method: "POST",
        url: "/admin/api/logout",
        headers: { cookie, [CSRF_HEADER]: csrf },
      }),
    );

    for (const res of responses) {
      const whole = res.body + JSON.stringify(res.headers);
      expect(whole).not.toContain(ADMIN_PASSWORD);
      expect(whole).not.toContain(ADMIN_PASSWORD_HASH);
      expect(whole).not.toContain(SESSION_SECRET);
      expect(whole).not.toContain(FAKE_SEED);
    }
  });

  it("never logs the password, the hash or the session secret", async () => {
    const h = harness({ captureLogs: true });
    await h.app.ready();

    await login(h);
    await login(h, { password: ADMIN_PASSWORD.toUpperCase() });
    await login(h, { email: ADMIN_PASSWORD, password: ADMIN_PASSWORD });
    const { cookie, csrf } = await signedIn(h);
    await h.app.inject({
      method: "POST",
      url: "/admin/api/logout",
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    await h.app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } });

    const captured = h.log();
    expect(captured.length).toBeGreaterThan(0);
    expect(captured).not.toContain(ADMIN_PASSWORD);
    expect(captured).not.toContain(ADMIN_PASSWORD_HASH);
    expect(captured).not.toContain(SESSION_SECRET);
    expect(captured).not.toContain(FAKE_SEED);
    // Nor the cookie that would let a log reader become the admin.
    expect(captured).not.toContain(cookie);
    expect(captured).not.toContain(csrf);
  });

  it("warns when secure cookies are off somewhere that is not localhost", async () => {
    const h = harness({
      captureLogs: true,
      config: adminConfig({
        api: { port: 0, host: "0.0.0.0", trustProxy: true, secureCookies: false },
      }),
    });
    await h.app.ready();

    expect(h.log()).toContain("SECURE_COOKIES IS FALSE");
  });

  it("says nothing about cookies when it really is localhost", async () => {
    const h = harness({ captureLogs: true });
    await h.app.ready();
    expect(h.log()).not.toContain("SECURE_COOKIES IS FALSE");
  });
});
