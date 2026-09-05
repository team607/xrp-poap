/**
 * THE PRODUCTION EVENT DESK — `/admin/api/desk/*`.
 *
 * These two routes exist because the desk used to run on `/demo/lookup` and
 * `/demo/sponsor`, which are registered only when `DEMO_ENABLED` is set and
 * which refuse to run on mainnet by design. So the regressions this file is
 * really about are not the happy paths:
 *
 *   1. NEITHER ROUTE MAY DEPEND ON THE DEMO. Every harness below builds an
 *      ApiDeps with no `demo` key at all — that is the whole point of the
 *      promotion, and `parity` at the bottom is the one exception, where the
 *      two answers are compared field for field.
 *   2. NEITHER MAY BE REACHED WITHOUT A SESSION. One of them spends the
 *      issuer's XRP and the other returns somebody's name.
 *   3. THE EVENT IS ASKED FOR, NEVER GUESSED. A missing `eventId` is a 400.
 *   4. THE BADGE PREVIEW POINTS AT A ROUTE THAT EXISTS ON MAINNET.
 *
 * fastify inject against hand-made fakes. No network: the balance comes from a
 * MockGateway answering `account_info`, which is the real `getAccountBalanceXrp`
 * running against a queued response rather than a stub of it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { Wallet } from "xrpl";
import { describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import { MockGateway, rippledError } from "../../test/helpers/mock-gateway.js";
import type { AppConfig } from "../config.js";
import { SponsorshipDeniedError, XrplLayerError } from "../errors.js";
import { sponsorWallet } from "../xrpl/sponsor.js";
import type {
  AttendanceRecord,
  AttendanceRepository,
  BadgeUriResolver,
  ClaimRecord,
  ClaimRepository,
  EventId,
  RegistrationRecord,
  RegistrationRepository,
  SponsorLedger,
  SponsorReservation,
  SponsorReserveInput,
} from "../types.js";
import { DemoState, type DemoChainOps, type DemoOptions } from "./demo-state.js";
import type { ApiDeps, ChainOps } from "./deps.js";
import { registerErrorHandler } from "./http-errors.js";
import { registerDemoRoutes } from "./routes/demo.js";
import { registerDeskRoutes } from "./routes/desk.js";
import { type AdminGuard } from "./routes/events.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = "rwukQtEt5yj9QGTBSoLWuBvVpPh5nNPpN4";
const ATTENDEE = "rwPy1pJd3RcHrEaqKk1yUiEGCqz8wewJZm";
const WALK_UP = "ra6pcMuGFgwSefKt4GPy6UCeEXkn2KtaNS";

const NFTOKEN_ID = "000800008685A6D01DEDD0C4365B0928256424853B9842F30A379442FF969F9D";
const OFFER_ID = "8685A6D01DEDD0C4365B0928256424853B9842F30A379442FF969F9DD0D3AABC";
const ACCEPT_TX = "B4068EC978F85028EFF92C1D9D48C249A5243E31EE517344378D33413E25EEBD";
const PAY_TX = "C31F96F645E7BDFDE9D28B2612A8C9442C4CB2DA3B05A5F8EA32F2A1BE2F32B7";

/** Two real events. Nothing here is a demo taxon. */
const CONFERENCE = 4242;
const WORKSHOP = 4243;

const NOT_AN_ADDRESS = "https://example.com/scan-me";

/** The header the injected admin guard accepts. Not a real credential. */
const ADMIN_HEADER = "x-test-admin";
const asAdmin = { [ADMIN_HEADER]: "yes" } as const;

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    endpoint: "wss://xrplcluster.com",
    fallbackEndpoints: [],
    // MAINNET, deliberately: this is the deployment the demo routes refuse to
    // run on, and the whole reason these two exist.
    network: "mainnet",
    issuerAddress: ISSUER,
    issuerSeed: "sEdV6Xn3bRq9J2wY4tK8mZpL1cH7dQa",
    sponsor: { enabled: true, amountXrp: "1.5", dailyCapXrp: "50" },
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

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Anything these routes must not touch. Reaching for one fails the test. */
function unused<T extends object>(label: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      return () => {
        throw new XrplLayerError(
          "CONFIG_INVALID",
          `${label}.${String(prop)}() should not be reachable from the desk routes`,
        );
      };
    },
  });
}

class FakeClaimRepository implements ClaimRepository {
  readonly rows: ClaimRecord[] = [];
  private seq = 0;

  async open(input: { eventId: EventId; address: string; expiresAt?: Date }): Promise<ClaimRecord | null> {
    this.seq += 1;
    const row: ClaimRecord = {
      id: `claim-${this.seq}`,
      eventId: input.eventId,
      address: input.address,
      nftokenId: null,
      offerId: null,
      status: "pending",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: input.expiresAt ?? null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async find(eventId: EventId, address: string): Promise<ClaimRecord | null> {
    const row = this.rows.find((r) => r.eventId === eventId && r.address === address);
    return row ? { ...row } : null;
  }

  async attach(id: string, patch: { nftokenId?: string; offerId?: string }): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    if (patch.nftokenId !== undefined) row.nftokenId = patch.nftokenId;
    if (patch.offerId !== undefined) row.offerId = patch.offerId;
  }

  /** What POST /events/:eventId/claims leaves behind, without running it. */
  async seed(
    eventId: EventId,
    address: string,
    patch: { nftokenId?: string; offerId?: string; status?: ClaimRecord["status"] } = {},
  ): Promise<void> {
    const row = await this.open({ eventId, address });
    if (!row) return;
    await this.attach(row.id, patch);
    if (patch.status) {
      const stored = this.rows.find((r) => r.id === row.id);
      if (stored) stored.status = patch.status;
    }
  }

  async markClaimed(_id: string): Promise<void> {}
  async markAbandoned(_id: string): Promise<void> {}
  async listExpired(_now: Date, _limit?: number): Promise<ClaimRecord[]> {
    return [];
  }
  async delete(_id: string): Promise<void> {}
}

class FakeAttendanceRepository implements AttendanceRepository {
  readonly rows: AttendanceRecord[] = [];

  async insert(record: AttendanceRecord): Promise<AttendanceRecord> {
    const stored: AttendanceRecord = { ...record, id: String(this.rows.length + 1) };
    this.rows.push(stored);
    return stored;
  }

  async findByEventAndAddress(eventId: EventId, address: string): Promise<AttendanceRecord | null> {
    return this.rows.find((r) => r.eventId === eventId && r.address === address) ?? null;
  }

  async listByEvent(_eventId: EventId): Promise<AttendanceRecord[]> {
    return [];
  }
  async countByEvent(_eventId: EventId): Promise<number> {
    return 0;
  }
  async listByAddress(_address: string): Promise<AttendanceRecord[]> {
    return [];
  }
}

class FakeRegistrationRepository implements RegistrationRepository {
  readonly rows: RegistrationRecord[] = [];
  /** Set to make every read explode, the way a dead table would. */
  broken = false;

  seed(row: Omit<RegistrationRecord, "id"> & { id?: string }): RegistrationRecord {
    const stored: RegistrationRecord = { id: row.id ?? `reg-${this.rows.length + 1}`, ...row };
    this.rows.push(stored);
    return stored;
  }

  async create(input: Omit<RegistrationRecord, "id" | "registeredAt" | "checkedInAt">) {
    return this.seed({ ...input, registeredAt: new Date("2026-08-01T09:00:00.000Z") });
  }

  async findByAddress(eventId: EventId, address: string): Promise<RegistrationRecord | null> {
    if (this.broken) throw new Error("registrations table is unavailable");
    return this.rows.find((r) => r.eventId === eventId && r.address === address) ?? null;
  }

  async findById(id: string): Promise<RegistrationRecord | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async listByEvent(_eventId: EventId): Promise<RegistrationRecord[]> {
    return [];
  }
  async countByEvent(_eventId: EventId): Promise<{ total: number; checkedIn: number }> {
    return { total: this.rows.length, checkedIn: 0 };
  }
  async markCheckedIn(id: string, at?: Date): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.checkedInAt = at ?? new Date();
  }
}

/**
 * A sponsor ledger that records what it was asked and answers how the test
 * says. The REAL sponsorWallet() drives it, so the reserve-before-pay order and
 * the denial mapping below are the shipped ones, not a re-implementation.
 */
class RecordingSponsorLedger implements SponsorLedger {
  readonly reserves: SponsorReserveInput[] = [];
  readonly confirms: Array<{ id: string; txHash: string }> = [];
  readonly releases: string[] = [];

  /** null means "refused" — the cap, or a duplicate. */
  grant: SponsorReservation | null = {
    id: "reservation-1",
    eventId: CONFERENCE,
    address: ATTENDEE,
    amountXrp: "1.5",
  };
  duplicate = false;
  spentTodayXrp = "0";

  async hasSponsored(_eventId: EventId, _address: string): Promise<boolean> {
    return this.duplicate;
  }
  async sponsoredTodayXrp(): Promise<string> {
    return this.spentTodayXrp;
  }
  async reserve(input: SponsorReserveInput): Promise<SponsorReservation | null> {
    this.reserves.push(input);
    return this.grant;
  }
  async confirm(reservationId: string, txHash: string): Promise<void> {
    this.confirms.push({ id: reservationId, txHash });
  }
  async release(reservationId: string): Promise<void> {
    this.releases.push(reservationId);
  }
}

/**
 * The injected admin check. Three lines, no session store, no cookie signing —
 * the point is to assert what these routes do when the guard says no, not to
 * re-test src/api/auth.ts.
 */
const fakeRequireAdmin: AdminGuard = (request, reply) => {
  if (request.headers[ADMIN_HEADER] === "yes") return undefined;
  return reply
    .code(401)
    .send({ error: { code: "UNAUTHORIZED", message: "Not signed in. POST /admin/api/login first." } });
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  app: FastifyInstance;
  deps: ApiDeps;
  gateway: MockGateway;
  claims: FakeClaimRepository;
  attendance: FakeAttendanceRepository;
  registrations: FakeRegistrationRepository;
  sponsorLedger: RecordingSponsorLedger;
  /** Addresses the fake ledger knows about, in XRP. Absent means unactivated. */
  balances: Map<string, string>;
}

function xrpToDropsString(xrp: string): string {
  const [whole = "0", frac = ""] = xrp.split(".");
  return String(BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6)));
}

function makeDeps(
  options: {
    config?: Partial<AppConfig>;
    chain?: Partial<ChainOps>;
    deps?: Partial<ApiDeps>;
    badgeUris?: ApiDeps["badgeUris"];
    /** Leave the registration store out entirely. */
    withoutRegistrations?: boolean;
  } = {},
) {
  const claims = new FakeClaimRepository();
  const attendance = new FakeAttendanceRepository();
  const registrations = new FakeRegistrationRepository();
  const sponsorLedger = new RecordingSponsorLedger();
  const balances = new Map<string, string>([[ISSUER, "999.99"]]);

  // The real getAccountBalanceXrp runs against this: one queued handler that
  // answers account_info the way a node would, or refuses the way one does for
  // an address that has never been funded.
  const gateway = new MockGateway({ network: "mainnet", issuerAddress: ISSUER }).onRequest(
    "account_info",
    (payload: Record<string, unknown>) => {
      const known = balances.get(String(payload.account));
      if (known === undefined) return rippledError("actNotFound");
      return { result: { account_data: { Balance: xrpToDropsString(known) } } };
    },
  );

  const deps: ApiDeps = {
    config: testConfig(options.config),
    gateway,
    attendance,
    claims,
    sponsorLedger,
    chain: { ...unused<ChainOps>("chain"), ...options.chain },
    requireAdmin: fakeRequireAdmin,
    rateLimit: { enabled: false },
    ...(options.withoutRegistrations ? {} : { registrations }),
    ...(options.badgeUris ? { badgeUris: options.badgeUris } : {}),
    ...options.deps,
  };

  // THE POINT OF THE WHOLE FILE. Nothing about the demo harness is wired here.
  expect(deps.demo).toBeUndefined();

  return { deps, gateway, claims, attendance, registrations, sponsorLedger, balances };
}

/**
 * Just the desk routes on a bare instance, with the same validator compiler and
 * error handler buildServer() installs.
 *
 * Deliberately NOT buildServer(): that also installs the `/admin/api` prefix
 * guard from src/api/auth.ts, which with no admin credentials configured
 * answers 503 for the whole surface before a handler is reached. That layer has
 * its own tests; what is asserted here is the routes.
 */
function harness(options: Parameters<typeof makeDeps>[0] = {}): Harness {
  const built = makeDeps(options);

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(({ schema }) => (data) => {
    const result = (schema as ZodType).safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  });
  registerErrorHandler(app);
  registerDeskRoutes(app, built.deps);

  return { app, ...built };
}

const scan = (address: string, eventId?: number): string =>
  `/admin/api/desk/attendees/${encodeURIComponent(address)}` +
  (eventId === undefined ? "" : `?eventId=${eventId}`);

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe("the desk is behind a session", () => {
  it("401s every route with no admin, and touches nothing on the way", async () => {
    const h = harness();

    const calls = [
      { method: "GET" as const, url: "/admin/api/desk/state" },
      { method: "GET" as const, url: scan(ATTENDEE, CONFERENCE) },
      {
        method: "POST" as const,
        url: "/admin/api/desk/sponsor",
        payload: { address: ATTENDEE, eventId: CONFERENCE },
      },
      {
        method: "POST" as const,
        url: "/admin/api/desk/reconcile",
        payload: { address: ATTENDEE, eventId: CONFERENCE },
      },
    ];

    for (const call of calls) {
      const res = await h.app.inject(call);
      expect(res.statusCode, call.url).toBe(401);
      expect(res.json().error.code, call.url).toBe("UNAUTHORIZED");
    }

    // Refused before anything was read, asked of the ledger, or spent.
    expect(h.gateway.requests).toHaveLength(0);
    expect(h.gateway.submits).toHaveLength(0);
    expect(h.sponsorLedger.reserves).toHaveLength(0);
  });

  it("refuses a scan before it will say who an address belongs to", async () => {
    const h = harness();
    h.registrations.seed({
      eventId: CONFERENCE,
      address: ATTENDEE,
      addressProof: "xaman_signin",
      displayName: "Inderdeep Khanna",
    });

    const res = await h.app.inject({ method: "GET", url: scan(ATTENDEE, CONFERENCE) });

    expect(res.statusCode).toBe(401);
    // Personal data is the other reason this route is behind the login.
    expect(res.body).not.toContain("Inderdeep");
  });
});

// ---------------------------------------------------------------------------
// GET /admin/api/desk/state
// ---------------------------------------------------------------------------

describe("GET /admin/api/desk/state", () => {
  it("reports the ledger, the node and what is left in the badge fund", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "GET",
      url: "/admin/api/desk/state",
      headers: asAdmin,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      network: "mainnet",
      endpoint: "wss://xrplcluster.com",
      issuer: { address: ISSUER, balanceXrp: "999.99", activated: true },
      sponsor: { amountXrp: "1.5" },
    });
  });

  it("never names an event, so a desk cannot inherit one it did not choose", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "GET",
      url: "/admin/api/desk/state",
      headers: asAdmin,
    });

    // The demo's /demo/state carried an eventId and that is exactly how a
    // volunteer ends up issuing badges against the wrong taxon all evening.
    expect(Object.keys(res.json())).not.toContain("eventId");
    expect(res.body).not.toContain(String(CONFERENCE));
  });

  it("opens on an unfunded issuer instead of refusing to load", async () => {
    const h = harness();
    // account_info answers actNotFound for anything not in `balances`.
    h.balances.delete(ISSUER);

    const res = await h.app.inject({
      method: "GET",
      url: "/admin/api/desk/state",
      headers: asAdmin,
    });

    // A desk that will not open because the fund is empty cannot tell anyone
    // the fund is empty. 200, with the bad news in the body.
    expect(res.statusCode).toBe(200);
    expect(res.json().issuer).toEqual({ address: ISSUER, balanceXrp: "0", activated: false });
  });

  it("keeps the issuer seed off the wire", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "GET",
      url: "/admin/api/desk/state",
      headers: asAdmin,
    });

    expect(res.body).not.toContain("sEd");
    expect(res.body).not.toContain(h.deps.config.issuerSeed ?? "never");
  });
});

// ---------------------------------------------------------------------------
// GET /admin/api/desk/attendees/:address
// ---------------------------------------------------------------------------

describe("the desk offers a top-up whenever the badge cannot land", () => {
  /**
   * `needsSponsorship` used to mean `!activated`. It now means "this wallet
   * cannot receive a badge", which is a strictly larger set: accepting an NFT
   * creates an NFTokenPage and that locks owner reserve, so an account holding
   * less than base + 0.2 refuses the accept while looking perfectly healthy.
   */
  it("says a dust wallet needs funding, and by how much", async () => {
    const h = harness();
    h.balances.set(ATTENDEE, "1");     // real account, 0.2 XRP short

    const res = await h.app.inject({
      method: "GET",
      url: scan(ATTENDEE, CONFERENCE),
      headers: asAdmin,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      activated: true,
      balanceXrp: "1",
      needsSponsorship: true,
      reserveShortfallXrp: "0.2",
    });
  });

  it("stops asking the moment the balance is enough", async () => {
    const h = harness();
    h.balances.set(ATTENDEE, "1.2");   // exactly base + one owner reserve

    const res = await h.app.inject({
      method: "GET",
      url: scan(ATTENDEE, CONFERENCE),
      headers: asAdmin,
    });

    expect(res.json()).toMatchObject({
      activated: true,
      needsSponsorship: false,
      reserveShortfallXrp: "0",
    });
  });
});

describe("GET /admin/api/desk/attendees/:address", () => {
  it("says an unactivated wallet needs sponsorship, and by how much", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "GET",
      url: scan(ATTENDEE, CONFERENCE),
      headers: asAdmin,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      address: ATTENDEE,
      valid: true,
      eventId: CONFERENCE,
      activated: false,
      balanceXrp: "0",
      needsSponsorship: true,
      // 1 XRP account reserve + 0.2 owner reserve for the NFTokenPage.
      reserveShortfallXrp: "1.2",
      // What the sponsor would actually send, from the real SponsorConfig.
      sponsorAmountXrp: "1.5",
      claim: null,
      attended: false,
      alreadyHasBadge: false,
      registration: null,
    });
  });

  it("stops asking for sponsorship once the wallet exists", async () => {
    const h = harness();
    h.balances.set(ATTENDEE, "1.5");

    const res = await h.app.inject({
      method: "GET",
      url: scan(ATTENDEE, CONFERENCE),
      headers: asAdmin,
    });

    expect(res.json()).toMatchObject({
      activated: true,
      balanceXrp: "1.5",
      needsSponsorship: false,
      reserveShortfallXrp: "0",
    });
  });

  it("publishes exactly the fields the desk page reads", async () => {
    const h = harness();
    h.balances.set(ATTENDEE, "1.5");

    const res = await h.app.inject({
      method: "GET",
      url: scan(ATTENDEE, CONFERENCE),
      headers: asAdmin,
    });

    // `attendedTxHash` is the one conditional key: present only with a badge.
    expect(Object.keys(res.json()).sort()).toEqual([
      "activated",
      "address",
      "alreadyHasBadge",
      "art",
      "attended",
      "balanceXrp",
      "claim",
      "eventId",
      "needsSponsorship",
      "registration",
      "reserveShortfallXrp",
      "sponsorAmountXrp",
      "valid",
    ]);
  });

  it("names a registered attendee, and calls a walk-up a walk-up", async () => {
    const h = harness();
    h.registrations.seed({
      eventId: CONFERENCE,
      address: ATTENDEE,
      addressProof: "xaman_signin",
      displayName: "Inderdeep Khanna",
      email: "somebody@example.com",
      registeredAt: new Date("2026-08-01T09:00:00.000Z"),
      checkedInAt: null,
    });

    const known = await h.app.inject({
      method: "GET",
      url: scan(ATTENDEE, CONFERENCE),
      headers: asAdmin,
    });
    expect(known.json().registration).toEqual({
      displayName: "Inderdeep Khanna",
      addressProof: "xaman_signin",
      registeredAt: "2026-08-01T09:00:00.000Z",
      checkedInAt: null,
    });
    // The desk needs a name to check against a face. It does not need an email,
    // and this projection has no field for one.
    expect(known.body).not.toContain("somebody@example.com");

    const walkUp = await h.app.inject({
      method: "GET",
      url: scan(WALK_UP, CONFERENCE),
      headers: asAdmin,
    });
    // A normal case at a door, not an error.
    expect(walkUp.statusCode).toBe(200);
    expect(walkUp.json().registration).toBeNull();
  });

  it("keeps working when there is no registration store, or it is broken", async () => {
    const none = harness({ withoutRegistrations: true });
    const noneRes = await none.app.inject({
      method: "GET",
      url: scan(ATTENDEE, CONFERENCE),
      headers: asAdmin,
    });
    expect(noneRes.statusCode).toBe(200);
    expect(noneRes.json().registration).toBeNull();

    const broken = harness();
    broken.registrations.broken = true;
    const brokenRes = await broken.app.inject({
      method: "GET",
      url: scan(ATTENDEE, CONFERENCE),
      headers: asAdmin,
    });
    // A desk must keep issuing badges when the registrations table does not.
    expect(brokenRes.statusCode).toBe(200);
    expect(brokenRes.json().registration).toBeNull();
    expect(brokenRes.json().valid).toBe(true);
  });

  it("answers 200 with valid:false for anything that is not an address", async () => {
    const h = harness();

    for (const scanned of [NOT_AN_ADDRESS, "  ", "rNotAnAddress", ISSUER.slice(0, -1)]) {
      const res = await h.app.inject({
        method: "GET",
        url: scan(scanned, CONFERENCE),
        headers: asAdmin,
      });

      // 200, not 400: a mis-scan is a thing to render, not a broken app.
      expect(res.statusCode, scanned).toBe(200);
      expect(res.json().valid, scanned).toBe(false);
      expect(res.json().alreadyHasBadge, scanned).toBe(false);
      // No address means no badge art. A previewUrl built from a mis-scan would
      // point at a 400 and the page would render it as a broken image.
      expect(res.json().art, scanned).toBeNull();
      expect(res.json().registration, scanned).toBeNull();
      // Still the event the desk asked about, never a guess.
      expect(res.json().eventId, scanned).toBe(CONFERENCE);
    }

    // Nothing was asked of the ledger on the way to that answer.
    expect(h.gateway.requests).toHaveLength(0);
  });

  it("400s a missing eventId rather than defaulting to one", async () => {
    const h = harness();

    for (const url of [scan(ATTENDEE), `${scan(ATTENDEE)}?eventId=`, `${scan(ATTENDEE)}?eventId=%20`]) {
      const res = await h.app.inject({ method: "GET", url, headers: asAdmin });

      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code, url).toBe("INVALID_INPUT");
      expect(res.json().error.message, url).toContain("eventId is required");
    }

    // A refusal, not a lookup against something it made up.
    expect(h.gateway.requests).toHaveLength(0);
  });

  it("400s an eventId that is not a legal taxon", async () => {
    const h = harness();

    for (const raw of ["tomorrow", "-1", "2147483648", "4.5"]) {
      const res = await h.app.inject({
        method: "GET",
        url: `${scan(ATTENDEE)}?eventId=${encodeURIComponent(raw)}`,
        headers: asAdmin,
      });

      expect(res.statusCode, raw).toBe(400);
      expect(res.json().error.code, raw).toBe("INVALID_TAXON");
    }
  });

  it("resolves the claim and the attendance against the eventId in the QUERY", async () => {
    const h = harness();
    h.balances.set(ATTENDEE, "1.5");

    // The same person, two events. They collected the conference badge last
    // night; this morning they are at the workshop desk with an open offer.
    await h.attendance.insert({
      eventId: CONFERENCE,
      address: ATTENDEE,
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
      txHash: ACCEPT_TX,
      ledgerIndex: 4_242_000,
    });
    await h.claims.seed(WORKSHOP, ATTENDEE, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });

    const conference = (
      await h.app.inject({ method: "GET", url: scan(ATTENDEE, CONFERENCE), headers: asAdmin })
    ).json();
    const workshop = (
      await h.app.inject({ method: "GET", url: scan(ATTENDEE, WORKSHOP), headers: asAdmin })
    ).json();

    expect(conference).toMatchObject({
      eventId: CONFERENCE,
      attended: true,
      attendedTxHash: ACCEPT_TX,
      alreadyHasBadge: true,
      claim: null,
    });

    expect(workshop).toMatchObject({
      eventId: WORKSHOP,
      attended: false,
      // A pending claim is NOT a badge: the offer is open and the attendee has
      // not signed, so the volunteer may still press issue.
      alreadyHasBadge: false,
      claim: { status: "pending", nftokenId: NFTOKEN_ID, offerId: OFFER_ID },
    });
    expect(workshop.attendedTxHash).toBeUndefined();
  });

  it("calls a claimed claim a badge even before the attendance row lands", async () => {
    const h = harness();
    h.balances.set(ATTENDEE, "1.5");
    await h.claims.seed(CONFERENCE, ATTENDEE, {
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
      status: "claimed",
    });

    const res = await h.app.inject({
      method: "GET",
      url: scan(ATTENDEE, CONFERENCE),
      headers: asAdmin,
    });

    expect(res.json().alreadyHasBadge).toBe(true);
    expect(res.json().attended).toBe(false);
  });

  it("previews the badge from /badge, which exists on mainnet, never /demo/art", async () => {
    const h = harness();

    for (const eventId of [CONFERENCE, WORKSHOP]) {
      const res = await h.app.inject({
        method: "GET",
        url: scan(ATTENDEE, eventId),
        headers: asAdmin,
      });

      // registerBadgeRoutes serves this on every deployment. /demo/art is
      // registered only when DEMO_ENABLED is set on a non-mainnet network, so a
      // desk pointed at it shows a broken image at a real event.
      expect(res.json().art.previewUrl).toBe(`/badge/${eventId}/${ATTENDEE}.png`);
      expect(res.body).not.toContain("/demo/");
    }
  });

  it("surfaces the pinned URIs when the attendee is in the manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xrpl-desk-manifest-"));
    const path = join(dir, "badge-manifest.json");
    const imageUri = "ipfs://bafybeigdyrartimagecid/badge.svg";
    const metadataUri = "ipfs://bafybeigdyrartmetacid/badge.json";

    try {
      const resolver: BadgeUriResolver & { manifestPathFor: (eventId: EventId) => string } = {
        manifestPathFor: () => path,
        resolve: async () => {
          throw new Error("reading badge art links must never pin anything");
        },
      };
      const h = harness({ badgeUris: resolver });
      writeFileSync(
        path,
        JSON.stringify({
          eventId: CONFERENCE,
          createdAt: "2026-01-01T00:00:00.000Z",
          entries: { [ATTENDEE]: { imageUri, metadataUri, pinnedAt: "2026-01-01T00:00:00.000Z" } },
        }),
        "utf8",
      );

      const res = await h.app.inject({
        method: "GET",
        url: scan(ATTENDEE, CONFERENCE),
        headers: asAdmin,
      });

      expect(res.json().art).toEqual({
        previewUrl: `/badge/${CONFERENCE}/${ATTENDEE}.png`,
        imageUri,
        metadataUri,
        gatewayUrl: "https://gateway.pinata.cloud/ipfs/bafybeigdyrartimagecid/badge.svg",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still renders a preview when there is no manifest at all", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "GET",
      url: scan(ATTENDEE, CONFERENCE),
      headers: asAdmin,
    });

    // The manifest is a cache. Losing it costs the two ipfs links and nothing
    // else — a self-hosted mainnet deployment never writes one.
    expect(res.json().art).toEqual({ previewUrl: `/badge/${CONFERENCE}/${ATTENDEE}.png` });
  });

  it("lets a real ledger failure fail, rather than reporting 'not activated'", async () => {
    const h = harness();
    // One handler, replaced: the node is up but refusing.
    const gateway = new MockGateway({ issuerAddress: ISSUER }).onRequest(
      "account_info",
      rippledError("tooBusy"),
    );
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(({ schema }) => (data) => {
      const result = (schema as ZodType).safeParse(data);
      return result.success ? { value: result.data } : { error: result.error };
    });
    registerErrorHandler(app);
    registerDeskRoutes(app, { ...h.deps, gateway });

    const res = await app.inject({ method: "GET", url: scan(ATTENDEE, CONFERENCE), headers: asAdmin });

    // Only actNotFound means "unactivated". Reporting a busy node that way
    // would send the volunteer to press Sponsor and spend 1.5 XRP to find out.
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("INTERNAL");
    expect(res.json().activated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /admin/api/desk/sponsor
// ---------------------------------------------------------------------------

describe("POST /admin/api/desk/sponsor", () => {
  const sponsor = (app: FastifyInstance, body: Record<string, unknown>, headers = asAdmin) =>
    app.inject({ method: "POST", url: "/admin/api/desk/sponsor", payload: body, headers });

  it("hands the REAL sponsorWallet the real config and the real ledger", async () => {
    const spy = vi.fn<ChainOps["sponsorWallet"]>(async (_gateway, input) => ({
      sponsored: true,
      alreadyActivated: false,
      address: input.address,
      amountXrp: "1.5",
      txHash: PAY_TX,
      ledgerIndex: 4_242_002,
    }));
    const h = harness({ chain: { sponsorWallet: spy } });

    const res = await sponsor(h.app, { address: ATTENDEE, eventId: CONFERENCE });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sponsored: true,
      alreadyActivated: false,
      amountXrp: "1.5",
      txHash: PAY_TX,
    });

    // The guards are only real if the real ledger is passed: without it there
    // is no duplicate check and no daily cap, and this is the one route a
    // person can press that moves the issuer's XRP on purpose.
    const call = spy.mock.calls[0]?.[1];
    expect(call?.address).toBe(ATTENDEE);
    expect(call?.eventId).toBe(CONFERENCE);
    expect(call?.config).toBe(h.deps.config.sponsor);
    expect(call?.ledger).toBe(h.deps.sponsorLedger);
  });

  it("books the reservation before the Payment, end to end", async () => {
    // The REAL sponsorWallet this time, not a spy: what is under test is that
    // the two-phase reserve genuinely runs when the route is called.
    const h = harness({ chain: { sponsorWallet } });
    h.gateway.onSubmit("Payment", { hash: PAY_TX, ledgerIndex: 4_242_002 });

    const res = await sponsor(h.app, { address: ATTENDEE, eventId: CONFERENCE });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sponsored: true,
      alreadyActivated: false,
      amountXrp: "1.5",
      txHash: PAY_TX,
    });

    // Reserved with the configured amount AND the configured cap — the cap is
    // enforced inside the reservation, so passing it is what makes it real.
    expect(h.sponsorLedger.reserves).toEqual([
      { eventId: CONFERENCE, address: ATTENDEE, amountXrp: "1.5", dailyCapXrp: "50" },
    ]);
    expect(h.sponsorLedger.confirms).toEqual([{ id: "reservation-1", txHash: PAY_TX }]);
    expect(h.sponsorLedger.releases).toEqual([]);

    // 1.5 XRP, in drops, from the issuer to the attendee.
    expect(h.gateway.lastSubmit("Payment")).toMatchObject({
      Account: ISSUER,
      Destination: ATTENDEE,
      Amount: "1500000",
    });
  });

  it("reports an already-activated wallet without spending anything", async () => {
    const h = harness({ chain: { sponsorWallet } });
    h.balances.set(ATTENDEE, "25");

    const res = await sponsor(h.app, { address: ATTENDEE, eventId: CONFERENCE });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sponsored: false, alreadyActivated: true });
    expect(h.gateway.submits).toHaveLength(0);
    expect(h.sponsorLedger.reserves).toHaveLength(0);
  });

  it("403s a refusal, with the kind the page needs, for every kind that is one", async () => {
    for (const kind of ["duplicate", "disabled", "already_activated"] as const) {
      const h = harness({
        chain: {
          sponsorWallet: async () => {
            throw new SponsorshipDeniedError(`refused: ${kind}`, kind, { address: ATTENDEE });
          },
        },
      });

      const res = await sponsor(h.app, { address: ATTENDEE, eventId: CONFERENCE });

      expect(res.statusCode, kind).toBe(403);
      expect(res.json().error.code, kind).toBe("SPONSORSHIP_DENIED");
      expect(res.json().error.details.kind, kind).toBe(kind);
    }
  });

  it("429s the daily cap, because tomorrow it may pass", async () => {
    const h = harness({ chain: { sponsorWallet } });
    // The reservation is refused and this address holds no slot, which is what
    // the real sponsorWallet reads as "the cap would be exceeded".
    h.sponsorLedger.grant = null;
    h.sponsorLedger.duplicate = false;
    h.sponsorLedger.spentTodayXrp = "49";

    const res = await sponsor(h.app, { address: ATTENDEE, eventId: CONFERENCE });

    // A throttle, not a refusal — and never a generic 500, or the volunteer
    // learns nothing from watching the cap work.
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("SPONSORSHIP_DENIED");
    expect(res.json().error.details).toMatchObject({
      kind: "daily_cap",
      spentTodayXrp: "49",
      dailyCapXrp: "50",
    });
    // Refused BEFORE the money moved. That is the whole point of the ordering.
    expect(h.gateway.submits).toHaveLength(0);
  });

  it("403s a second sponsorship for the same address on the same event", async () => {
    const h = harness({ chain: { sponsorWallet } });
    h.sponsorLedger.grant = null;
    h.sponsorLedger.duplicate = true;

    const res = await sponsor(h.app, { address: ATTENDEE, eventId: CONFERENCE });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.details).toMatchObject({ kind: "duplicate" });
    expect(h.gateway.submits).toHaveLength(0);
  });

  it("403s when sponsorship is switched off, without a ledger round trip", async () => {
    const h = harness({
      chain: { sponsorWallet },
      config: { sponsor: { enabled: false, amountXrp: "1.5", dailyCapXrp: "50" } },
    });

    const res = await sponsor(h.app, { address: ATTENDEE, eventId: CONFERENCE });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.details).toMatchObject({ kind: "disabled" });
    expect(h.gateway.requests).toHaveLength(0);
  });

  it("400s an address or an event id that is not one", async () => {
    const h = harness();

    for (const payload of [
      { address: NOT_AN_ADDRESS, eventId: CONFERENCE },
      { address: ATTENDEE },
      { address: ATTENDEE, eventId: 2_147_483_648 },
      {},
    ]) {
      const res = await sponsor(h.app, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// The promotion itself
// ---------------------------------------------------------------------------

describe("the desk does not depend on the demo", () => {
  it("serves both routes, fully, with `demo` absent from the deps entirely", async () => {
    // THE REGRESSION THAT MATTERS. Not "the routes are registered" — both of
    // them answer for real, all the way to a Payment, with nothing demo-shaped
    // anywhere in the deps.
    const h = harness({ chain: { sponsorWallet } });
    expect(h.deps.demo).toBeUndefined();
    h.gateway.onSubmit("Payment", { hash: PAY_TX, ledgerIndex: 4_242_002 });

    const lookup = await h.app.inject({
      method: "GET",
      url: scan(ATTENDEE, CONFERENCE),
      headers: asAdmin,
    });
    const spend = await h.app.inject({
      method: "POST",
      url: "/admin/api/desk/sponsor",
      payload: { address: ATTENDEE, eventId: CONFERENCE },
      headers: asAdmin,
    });

    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({ valid: true, eventId: CONFERENCE, needsSponsorship: true });
    expect(spend.statusCode).toBe(200);
    expect(spend.json()).toMatchObject({ sponsored: true, txHash: PAY_TX });
  });

  it("runs on mainnet, which is what /demo/lookup refuses to do", async () => {
    const h = harness({ config: { network: "mainnet" } });
    h.balances.set(ATTENDEE, "1.5");

    const res = await h.app.inject({
      method: "GET",
      url: scan(ATTENDEE, CONFERENCE),
      headers: asAdmin,
    });

    expect(h.deps.config.network).toBe("mainnet");
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parity with the demo routes it replaces
//
// The volunteer page reads these fields one by one, so drift between the two is
// silent. Both are registered on one instance here — the demo needs a
// non-mainnet network, so this is the one harness in the file that is testnet.
// ---------------------------------------------------------------------------

function parityHarness() {
  const built = makeDeps({ config: { network: "testnet" } });
  const state = new DemoState();

  const ops: DemoChainOps = {
    fundWallet: async () => ({ wallet: Wallet.generate(), balanceXrp: "100" }),
    // The same numbers the desk reads off the MockGateway, so a difference in
    // the two bodies is a difference in the code and never in the fixture.
    getAccountBalanceXrp: async (gateway, address) => {
      const { getAccountBalanceXrp } = await import("../xrpl/sponsor.js");
      return getAccountBalanceXrp(gateway, address);
    },
    acceptOfferAs: async () => ({ txHash: ACCEPT_TX, ledgerIndex: 1 }),
    burn: async () => {
      throw new Error("not used");
    },
  };

  const demo: DemoOptions = {
    enabled: true,
    ops,
    state,
    htmlDir: join(tmpdir(), "xrpl-desk-pages-that-do-not-exist"),
  };
  const deps: ApiDeps = { ...built.deps, demo };

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(({ schema }) => (data) => {
    const result = (schema as ZodType).safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  });
  registerErrorHandler(app);
  registerDeskRoutes(app, deps);
  registerDemoRoutes(app, deps);

  return { ...built, app, deps, state };
}

describe("the desk answers exactly what /demo/lookup answered", () => {
  it("field for field, for a registered attendee with an open claim", async () => {
    const h = parityHarness();
    h.balances.set(ATTENDEE, "1.5");
    h.registrations.seed({
      eventId: CONFERENCE,
      address: ATTENDEE,
      addressProof: "xaman_signin",
      displayName: "Inderdeep Khanna",
      registeredAt: new Date("2026-08-01T09:00:00.000Z"),
      checkedInAt: new Date("2026-08-02T10:30:00.000Z"),
    });
    await h.claims.seed(CONFERENCE, ATTENDEE, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });

    const demo = (
      await h.app.inject({
        method: "GET",
        url: `/demo/lookup?address=${ATTENDEE}&eventId=${CONFERENCE}`,
      })
    ).json();
    const desk = (
      await h.app.inject({ method: "GET", url: scan(ATTENDEE, CONFERENCE), headers: asAdmin })
    ).json();

    expect(Object.keys(desk).sort()).toEqual(Object.keys(demo).sort());

    // ONE deliberate difference: the preview URL. /demo/art is demo-only and
    // would 404 on mainnet; /badge/... is served on every deployment.
    expect(demo.art.previewUrl).toBe(`/demo/art?address=${ATTENDEE}&eventId=${CONFERENCE}`);
    expect(desk.art.previewUrl).toBe(`/badge/${CONFERENCE}/${ATTENDEE}.png`);

    const { art: demoArt, ...demoRest } = demo;
    const { art: deskArt, ...deskRest } = desk;
    expect(deskRest).toEqual(demoRest);
    const { previewUrl: _demoPreview, ...demoLinks } = demoArt;
    const { previewUrl: _deskPreview, ...deskLinks } = deskArt;
    expect(deskLinks).toEqual(demoLinks);
  });

  it("field for field, for an attendee who already has a badge", async () => {
    const h = parityHarness();
    h.balances.set(ATTENDEE, "1.5");
    await h.attendance.insert({
      eventId: CONFERENCE,
      address: ATTENDEE,
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
      txHash: ACCEPT_TX,
      ledgerIndex: 4_242_000,
    });

    const demo = (
      await h.app.inject({
        method: "GET",
        url: `/demo/lookup?address=${ATTENDEE}&eventId=${CONFERENCE}`,
      })
    ).json();
    const desk = (
      await h.app.inject({ method: "GET", url: scan(ATTENDEE, CONFERENCE), headers: asAdmin })
    ).json();

    expect(Object.keys(desk).sort()).toEqual(Object.keys(demo).sort());
    expect(desk.attendedTxHash).toBe(demo.attendedTxHash);
    expect(desk.alreadyHasBadge).toBe(true);
    expect(demo.alreadyHasBadge).toBe(true);
  });

  it("field for field for a mis-scan, and answers about the event that was asked", async () => {
    const h = parityHarness();

    const demo = (
      await h.app.inject({
        method: "GET",
        url: `/demo/lookup?address=${encodeURIComponent(NOT_AN_ADDRESS)}&eventId=${CONFERENCE}`,
      })
    ).json();
    const desk = (
      await h.app.inject({ method: "GET", url: scan(NOT_AN_ADDRESS, CONFERENCE), headers: asAdmin })
    ).json();

    expect(Object.keys(desk).sort()).toEqual(Object.keys(demo).sort());
    expect(desk.valid).toBe(false);
    expect(desk.art).toBeNull();
    // The one improvement: /demo/lookup reports its OWN event id on this branch
    // whatever it was asked about. The desk answers about the event the desk is
    // working, which is the bug class this whole promotion is about.
    expect(demo.eventId).toBe(h.state.eventId);
    expect(desk.eventId).toBe(CONFERENCE);
  });

  it("and both sponsor routes give the same body for the same outcome", async () => {
    const spy = vi.fn<ChainOps["sponsorWallet"]>(async (_gateway, input) => ({
      sponsored: true,
      alreadyActivated: false,
      address: input.address,
      amountXrp: "1.5",
      txHash: PAY_TX,
    }));
    const h = parityHarness();
    // Both routes call deps.chain.sponsorWallet; swap it in for both at once.
    h.deps.chain.sponsorWallet = spy;

    const demo = await h.app.inject({
      method: "POST",
      url: "/demo/sponsor",
      payload: { address: ATTENDEE, eventId: CONFERENCE },
    });
    const desk = await h.app.inject({
      method: "POST",
      url: "/admin/api/desk/sponsor",
      payload: { address: ATTENDEE, eventId: CONFERENCE },
      headers: asAdmin,
    });

    expect(desk.statusCode).toBe(demo.statusCode);
    expect(desk.json()).toEqual(demo.json());
    // Same config, same ledger, from both routes.
    for (const call of spy.mock.calls) {
      expect(call[1].config).toBe(h.deps.config.sponsor);
      expect(call[1].ledger).toBe(h.deps.sponsorLedger);
    }
  });
});

// ---------------------------------------------------------------------------
// Reconcile — noticing an accept the browser never saw
// ---------------------------------------------------------------------------

/**
 * THE BUG THIS ROUTE IS FOR, measured on testnet: two attendees accepted their
 * badge in Xaman, both badges landed, and both claim rows sat `pending`
 * forever because the desk's only way of noticing is to ask Xaman about a
 * payload id that lives in one browser tab. Reload, hand over the desk, or
 * press "Watch for them to accept" on a card built from a lookup, and there is
 * no id to ask about. The ledger knew the whole time; nothing was reading it.
 */
describe("POST /admin/api/desk/reconcile", () => {
  const reconcile = (h: Harness, address = ATTENDEE, eventId: number = CONFERENCE) =>
    h.app.inject({
      method: "POST",
      url: "/admin/api/desk/reconcile",
      payload: { address, eventId },
      headers: asAdmin,
    });

  /** A verifyClaim that passes, with the chain's own view of what moved. */
  const verifies = (over: Record<string, unknown> = {}) =>
    vi.fn(async () => ({
      attended: true,
      status: "attended",
      checks: {
        transactionFound: true,
        isAcceptOffer: true,
        submittedByAddress: true,
        succeeded: true,
        issuerAndTaxonMatch: true,
      },
      nftokenId: NFTOKEN_ID,
      sellOfferId: OFFER_ID,
      ledgerIndex: 90_210,
      ...over,
    })) as unknown as ChainOps["verifyClaim"];

  const offerGone = (h: Harness) =>
    h.gateway.onRequest("ledger_entry", rippledError("entryNotFound"));

  const acceptInHistory = (h: Harness, over: Record<string, unknown> = {}) =>
    h.gateway.onRequest("account_tx", {
      result: {
        transactions: [
          {
            tx: { TransactionType: "NFTokenAcceptOffer", NFTokenSellOffer: OFFER_ID },
            meta: { TransactionResult: "tesSUCCESS" },
            hash: ACCEPT_TX,
            ...over,
          },
        ],
      },
    });

  it("records the attendance the desk never saw, and marks them arrived", async () => {
    const verifyClaim = verifies();
    const h = harness({ chain: { verifyClaim } });
    await h.claims.seed(CONFERENCE, ATTENDEE, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });
    const reg = h.registrations.seed({
      eventId: CONFERENCE,
      address: ATTENDEE,
      addressProof: "xaman_signin",
      displayName: "Priya Raman",
      email: null,
      signinPayloadUuid: null,
      registeredAt: new Date("2026-08-01T09:00:00.000Z"),
      checkedInAt: null,
    });
    offerGone(h);
    acceptInHistory(h);

    const res = await reconcile(h);
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.reconciled).toBe(true);
    expect(body.txHash).toBe(ACCEPT_TX);
    expect(h.attendance.rows).toHaveLength(1);
    expect(h.attendance.rows[0]?.txHash).toBe(ACCEPT_TX);

    // Every one of the five checks still ran. This route discovers a hash; it
    // does not get to decide what the hash means.
    expect(verifyClaim).toHaveBeenCalledWith(
      h.gateway,
      expect.objectContaining({ address: ATTENDEE, eventId: CONFERENCE, txHash: ACCEPT_TX }),
    );

    // Accepting a badge at the desk IS turning up.
    expect(h.registrations.rows.find((r) => r.id === reg.id)?.checkedInAt).toBeInstanceOf(Date);
  });

  it("says 'not yet' and reads no history while the offer is still open", async () => {
    // The common answer during a poll. An account_tx per attendee per three
    // seconds is what makes the cheap probe worth having.
    const h = harness({ chain: { verifyClaim: vi.fn() as unknown as ChainOps["verifyClaim"] } });
    await h.claims.seed(CONFERENCE, ATTENDEE, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });
    h.gateway.onRequest("ledger_entry", {
      result: { index: OFFER_ID, node: { LedgerEntryType: "NFTokenOffer" } },
    });

    const body = (await reconcile(h)).json();

    expect(body).toMatchObject({ reconciled: false, reason: "offer-open" });
    expect(h.gateway.requests.filter((r) => r.command === "account_tx")).toHaveLength(0);
    expect(h.attendance.rows).toHaveLength(0);
  });

  it("touches the ledger at all only when there is an open claim", async () => {
    const h = harness({ chain: { verifyClaim: vi.fn() as unknown as ChainOps["verifyClaim"] } });

    const body = (await reconcile(h)).json();

    expect(body).toMatchObject({ reconciled: false, reason: "no-open-claim" });
    expect(h.gateway.requests).toHaveLength(0);
  });

  it("reports an offer that is gone with no accept behind it", async () => {
    // Cancelled, expired, or a node that has not caught up. All three are
    // answered by asking again, and none of them is an attendance.
    const h = harness({ chain: { verifyClaim: vi.fn() as unknown as ChainOps["verifyClaim"] } });
    await h.claims.seed(CONFERENCE, ATTENDEE, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });
    offerGone(h);
    h.gateway.onRequest("account_tx", { result: { transactions: [] } });

    expect((await reconcile(h)).json()).toMatchObject({
      reconciled: false,
      reason: "accept-not-found",
    });
    expect(h.attendance.rows).toHaveLength(0);
  });

  it("does not re-record somebody who is already indexed", async () => {
    const verifyClaim = verifies();
    const h = harness({ chain: { verifyClaim } });
    await h.attendance.insert({
      eventId: CONFERENCE,
      address: ATTENDEE,
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
      txHash: ACCEPT_TX,
      ledgerIndex: 90_210,
    });

    expect((await reconcile(h)).json()).toMatchObject({
      reconciled: false,
      reason: "already-recorded",
      attended: true,
      txHash: ACCEPT_TX,
    });
    expect(verifyClaim).not.toHaveBeenCalled();
    expect(h.gateway.requests).toHaveLength(0);
    expect(h.attendance.rows).toHaveLength(1);
  });

  it("writes nothing when the ledger disagrees, and says so at 200", async () => {
    // A 200 because "the chain says no" is a thing the desk renders, not a
    // thing it retries.
    const verifyClaim = verifies({
      attended: false,
      status: "not_attended",
      failedCheck: "submittedByAddress",
      reason: "someone else signed it",
    });
    const h = harness({ chain: { verifyClaim } });
    await h.claims.seed(CONFERENCE, ATTENDEE, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });
    offerGone(h);
    acceptInHistory(h);

    const body = (await reconcile(h)).json();

    expect(body.reconciled).toBe(false);
    expect(body.reason).toBe("verification-failed");
    expect(body.verification.failedCheck).toBe("submittedByAddress");
    expect(h.attendance.rows).toHaveLength(0);
  });

  it("calls a node that has not caught up 'not visible yet', not a disagreement", async () => {
    // Same 422 the confirm route returns, and the desk must read it the same
    // way: keep waiting. A red card here would be shown to a volunteer for a
    // badge that lands four seconds later.
    const verifyClaim = verifies({
      attended: false,
      status: "not_attended",
      failedCheck: "succeeded",
      notYet: true,
      reason: "succeeded but its ledger is not validated yet",
    });
    const h = harness({ chain: { verifyClaim } });
    await h.claims.seed(CONFERENCE, ATTENDEE, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });
    offerGone(h);
    acceptInHistory(h);

    expect((await reconcile(h)).json()).toMatchObject({
      reconciled: false,
      reason: "not-visible-yet",
    });
    expect(h.attendance.rows).toHaveLength(0);
  });

  it("will not reconcile one event's claim against another event", async () => {
    const verifyClaim = verifies();
    const h = harness({ chain: { verifyClaim } });
    await h.claims.seed(CONFERENCE, ATTENDEE, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });

    expect((await reconcile(h, ATTENDEE, WORKSHOP)).json()).toMatchObject({
      reason: "no-open-claim",
    });
    expect(verifyClaim).not.toHaveBeenCalled();
  });
});
