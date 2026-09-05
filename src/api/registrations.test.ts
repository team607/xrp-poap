/**
 * Registration and event HTTP tests.
 *
 * One rule is worth more than the rest of this file put together: THE ADDRESS
 * COMES FROM THE RESOLVED SIGN-IN AND NOWHERE ELSE. Several tests below attack
 * it directly — a body carrying a different address, an unsigned payload, a
 * declined one, a replayed one.
 *
 * Everything is hand-built fakes. Nothing here imports src/db, so the tests say
 * what these routes do rather than what a repository happens to do, and they
 * keep working while that layer is being written next door. The admin guard is
 * injected for the same reason: what is asserted about `/admin/api/events` must
 * not depend on cookies, scrypt or CSRF.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { MockGateway } from "../../test/helpers/mock-gateway.js";
import type { AppConfig } from "../config.js";
import { NotFoundError, XrplLayerError } from "../errors.js";
import type {
  EventId,
  EventRecord,
  EventRepository,
  EventStatus,
  RegistrationRecord,
  RegistrationRepository,
} from "../types.js";
import {
  NullSignInService,
  type SignInHandles,
  type SignInRequestParams,
  type SignInResolution,
  type SignInService,
} from "../xaman/signin.js";
import type { ApiDeps, ChainOps } from "./deps.js";
import { registerErrorHandler } from "./http-errors.js";
import { registerEventRoutes, type AdminGuard } from "./routes/events.js";
import { registerRegistrationRoutes } from "./routes/registrations.js";
import { buildServer } from "./server.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = "rwukQtEt5yj9QGTBSoLWuBvVpPh5nNPpN4";
/** The wallet that actually signs. Everything must end up registered to this. */
const ATTENDEE = "rwPy1pJd3RcHrEaqKk1yUiEGCqz8wewJZm";
/** Somebody else's wallet, used as the address a request body tries to sneak in. */
const OTHER = "ra6pcMuGFgwSefKt4GPy6UCeEXkn2KtaNS";

const OPEN_EVENT = 4242;
const DRAFT_EVENT = 4243;
const LIVE_EVENT = 4244;
const CLOSED_EVENT = 4245;

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const UUID_C = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const NOW = new Date("2026-08-01T09:00:00.000Z");

const HANDLES: SignInHandles = {
  uuid: UUID_A,
  qrPng: "https://xumm.app/sign/1111_q.png",
  deeplink: "https://xumm.app/sign/1111",
  websocket: "wss://xumm.app/sign/1111",
  expiresAt: "2026-08-01T09:10:00.000Z",
};

/** The header the injected admin guard below accepts. Not a real credential. */
const ADMIN_HEADER = "x-test-admin";
const asAdmin = { [ADMIN_HEADER]: "yes" } as const;

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    endpoint: "wss://clio.altnet.rippletest.net:51233",
    fallbackEndpoints: [],
    network: "testnet",
    issuerAddress: ISSUER,
    issuerSeed: "sEdV6Xn3bRq9J2wY4tK8mZpL1cH7dQa",
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

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Anything these routes are not supposed to touch. Reaching for one fails the
 * test loudly rather than quietly returning undefined — the same rule
 * MockGateway follows.
 */
function unused<T extends object>(label: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      return () => {
        throw new XrplLayerError(
          "CONFIG_INVALID",
          `${label}.${String(prop)}() should not be reachable from the registration routes`,
        );
      };
    },
  });
}

class FakeEventRepository implements EventRepository {
  readonly rows = new Map<EventId, EventRecord>();
  /** Stands in for "this taxon already has badges on the ledger". */
  readonly withBadges = new Set<EventId>();

  seed(eventId: EventId, status: EventStatus, overrides: Partial<EventRecord> = {}): EventRecord {
    const row: EventRecord = {
      eventId,
      name: `Event ${eventId}`,
      description: null,
      eventDate: `2026-09-0${(eventId % 9) + 1}`,
      venue: null,
      metadataUri: `ipfs://event-${eventId}/meta.json`,
      status,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
    this.rows.set(eventId, row);
    return row;
  }

  async create(input: Omit<EventRecord, "createdAt" | "updatedAt">): Promise<EventRecord> {
    if (this.rows.has(input.eventId)) {
      throw new XrplLayerError("DUPLICATE_CLAIM", `Event ${input.eventId} already exists`, {
        eventId: input.eventId,
      });
    }
    const row: EventRecord = { ...input, createdAt: NOW, updatedAt: NOW };
    this.rows.set(input.eventId, row);
    return { ...row };
  }

  async update(
    eventId: EventId,
    patch: Partial<Omit<EventRecord, "eventId" | "createdAt" | "updatedAt">>,
  ): Promise<EventRecord> {
    const row = this.rows.get(eventId);
    if (!row) throw new NotFoundError(`No event ${eventId}`, { eventId });
    const next: EventRecord = { ...row, ...patch, updatedAt: NOW };
    this.rows.set(eventId, next);
    return { ...next };
  }

  async find(eventId: EventId): Promise<EventRecord | null> {
    const row = this.rows.get(eventId);
    return row ? { ...row } : null;
  }

  async list(opts?: {
    status?: EventStatus;
    limit?: number;
    offset?: number;
  }): Promise<EventRecord[]> {
    const all = [...this.rows.values()]
      .filter((row) => (opts?.status ? row.status === opts.status : true))
      .sort((a, b) => a.eventId - b.eventId);
    const offset = opts?.offset ?? 0;
    return all.slice(offset, offset + (opts?.limit ?? 50)).map((row) => ({ ...row }));
  }

  async hasBadges(eventId: EventId): Promise<boolean> {
    return this.withBadges.has(eventId);
  }
}

class FakeRegistrationRepository implements RegistrationRepository {
  readonly rows: RegistrationRecord[] = [];
  readonly createInputs: Array<Omit<RegistrationRecord, "id" | "registeredAt" | "checkedInAt">> = [];
  /** Set to make the next create() blow up, for the "did the slot get released" path. */
  failNextCreate?: Error;
  private seq = 0;

  async create(
    input: Omit<RegistrationRecord, "id" | "registeredAt" | "checkedInAt">,
  ): Promise<RegistrationRecord> {
    this.createInputs.push(input);

    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = undefined as Error | undefined;
      throw err;
    }

    // Stands in for UNIQUE (event_id, address).
    if (this.rows.some((r) => r.eventId === input.eventId && r.address === input.address)) {
      throw new XrplLayerError(
        "DUPLICATE_CLAIM",
        `${input.address} is already registered for event ${input.eventId}`,
        { eventId: input.eventId, address: input.address },
      );
    }

    this.seq += 1;
    const row: RegistrationRecord = {
      ...input,
      id: `reg-${this.seq}`,
      registeredAt: NOW,
      checkedInAt: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async findByAddress(eventId: EventId, address: string): Promise<RegistrationRecord | null> {
    const row = this.rows.find((r) => r.eventId === eventId && r.address === address);
    return row ? { ...row } : null;
  }

  async findById(id: string): Promise<RegistrationRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async listByEvent(
    eventId: EventId,
    opts?: { limit?: number; offset?: number; checkedIn?: boolean },
  ): Promise<RegistrationRecord[]> {
    const all = this.rows
      .filter((r) => r.eventId === eventId)
      .filter((r) =>
        opts?.checkedIn === undefined ? true : Boolean(r.checkedInAt) === opts.checkedIn,
      );
    const offset = opts?.offset ?? 0;
    return all.slice(offset, offset + (opts?.limit ?? 50)).map((r) => ({ ...r }));
  }

  async countByEvent(eventId: EventId): Promise<{ total: number; checkedIn: number }> {
    const rows = this.rows.filter((r) => r.eventId === eventId);
    return { total: rows.length, checkedIn: rows.filter((r) => r.checkedInAt).length };
  }

  async markCheckedIn(id: string, at?: Date): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.checkedInAt = at ?? NOW;
  }
}

/** A SignInService whose answers are scripted per uuid. */
class FakeSignInService implements SignInService {
  readonly created: SignInRequestParams[] = [];
  readonly resolved: string[] = [];
  private readonly outcomes = new Map<string, SignInResolution | Error>();
  handles: SignInHandles = HANDLES;
  createError?: Error;

  async create(params: SignInRequestParams): Promise<SignInHandles> {
    this.created.push(params);
    if (this.createError) throw this.createError;
    return this.handles;
  }

  async resolve(uuid: string): Promise<SignInResolution> {
    this.resolved.push(uuid);
    const outcome = this.outcomes.get(uuid);
    if (!outcome) throw new NotFoundError(`No Xaman sign-in payload ${uuid}`, { uuid });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  signed(uuid: string, account: string): this {
    this.outcomes.set(uuid, { resolved: true, signed: true, account, rejected: false });
    return this;
  }

  pending(uuid: string): this {
    this.outcomes.set(uuid, { resolved: false, signed: false, rejected: false });
    return this;
  }

  declined(uuid: string): this {
    this.outcomes.set(uuid, { resolved: true, signed: false, rejected: true });
    return this;
  }

  throws(uuid: string, err: Error): this {
    this.outcomes.set(uuid, err);
    return this;
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
  events: FakeEventRepository;
  registrations: FakeRegistrationRepository;
  signIn: FakeSignInService;
}

function makeDeps(options: { deps?: Partial<ApiDeps>; config?: Partial<AppConfig> } = {}): {
  deps: ApiDeps;
  events: FakeEventRepository;
  registrations: FakeRegistrationRepository;
  signIn: FakeSignInService;
} {
  const events = new FakeEventRepository();
  const registrations = new FakeRegistrationRepository();
  const signIn = new FakeSignInService();

  events.seed(OPEN_EVENT, "open", { name: "XRPL Meetup" });
  events.seed(DRAFT_EVENT, "draft", { name: "Secret Offsite" });
  events.seed(LIVE_EVENT, "live", { name: "Hack Day" });
  events.seed(CLOSED_EVENT, "closed", { name: "Last Year" });

  const deps: ApiDeps = {
    config: testConfig(options.config),
    gateway: new MockGateway({ issuerAddress: ISSUER }),
    attendance: unused("attendance"),
    claims: unused("claims"),
    sponsorLedger: unused("sponsorLedger"),
    chain: unused<ChainOps>("chain"),
    events,
    registrations,
    signIn,
    requireAdmin: fakeRequireAdmin,
    rateLimit: { enabled: false },
    ...options.deps,
  };

  return { deps, events, registrations, signIn };
}

/**
 * Just these two route modules on a bare instance, with the same validator
 * compiler and error handler buildServer() installs.
 *
 * Deliberately NOT buildServer(): that also installs the `/admin/api` prefix
 * guard from src/api/auth.ts, which would answer every admin request here
 * before it reached the handler under test. buildServer() gets its own test at
 * the bottom, which is where the two layers meeting is the subject.
 */
function harness(options: Parameters<typeof makeDeps>[0] = {}): Harness {
  const { deps, events, registrations, signIn } = makeDeps(options);

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(({ schema }) => (data) => {
    const result = (schema as ZodType).safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  });
  registerErrorHandler(app);
  registerEventRoutes(app, deps);
  registerRegistrationRoutes(app, deps);

  return { app, deps, events, registrations, signIn };
}

// ---------------------------------------------------------------------------
// Public event reads
// ---------------------------------------------------------------------------

describe("GET /api/events", () => {
  it("lists open and live events", async () => {
    const { app } = harness();

    const res = await app.inject({ method: "GET", url: "/api/events" });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.events.map((e: { eventId: number }) => e.eventId).sort()).toEqual([
      OPEN_EVENT,
      LIVE_EVENT,
    ]);
  });

  it("never lists a draft", async () => {
    const { app } = harness();

    const res = await app.inject({ method: "GET", url: "/api/events" });

    expect(JSON.stringify(res.json())).not.toContain("Secret Offsite");
    expect(res.json().events.some((e: { status: string }) => e.status === "draft")).toBe(false);
  });

  it("publishes a fixed projection rather than the row", async () => {
    const { app } = harness();

    const res = await app.inject({ method: "GET", url: "/api/events" });
    const [first] = res.json().events;

    expect(Object.keys(first).sort()).toEqual([
      "description",
      "eventDate",
      "eventId",
      "metadataUri",
      "name",
      "status",
      "venue",
    ]);
  });

  it("pages", async () => {
    const { app } = harness();

    const res = await app.inject({ method: "GET", url: "/api/events?limit=1&offset=1" });
    const body = res.json();

    expect(body.events).toHaveLength(1);
    expect(body).toMatchObject({ limit: 1, offset: 1 });
  });
});

describe("GET /api/events/:eventId", () => {
  it("returns an open event", async () => {
    const { app } = harness();

    const res = await app.inject({ method: "GET", url: `/api/events/${OPEN_EVENT}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().event).toMatchObject({ eventId: OPEN_EVENT, name: "XRPL Meetup" });
  });

  it("404s a draft with the same answer it gives an id that never existed", async () => {
    const { app } = harness();

    const draft = await app.inject({ method: "GET", url: `/api/events/${DRAFT_EVENT}` });
    const missing = await app.inject({ method: "GET", url: "/api/events/999" });

    expect(draft.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(draft.json().error.code).toBe(missing.json().error.code);
    expect(JSON.stringify(draft.json())).not.toContain("Secret Offsite");
  });

  it("still resolves a closed event, for someone holding last year's link", async () => {
    const { app } = harness();

    const res = await app.inject({ method: "GET", url: `/api/events/${CLOSED_EVENT}` });

    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Admin writes
// ---------------------------------------------------------------------------

describe("admin event routes", () => {
  it("401s every one of them without auth", async () => {
    const { app, events } = harness();

    const calls = [
      app.inject({ method: "GET", url: "/admin/api/events" }),
      app.inject({ method: "POST", url: "/admin/api/events", payload: { eventId: 7, name: "x" } }),
      app.inject({ method: "PATCH", url: `/admin/api/events/${OPEN_EVENT}`, payload: { name: "x" } }),
      app.inject({ method: "GET", url: `/admin/api/events/${OPEN_EVENT}/registrations` }),
    ];

    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(401);
    }
    // The guard runs before the handler: nothing was created and nothing renamed.
    expect(events.rows.has(7)).toBe(false);
    expect(events.rows.get(OPEN_EVENT)?.name).toBe("XRPL Meetup");
  });

  it("lists everything, drafts included, once authenticated", async () => {
    const { app } = harness();

    const res = await app.inject({ method: "GET", url: "/admin/api/events", headers: asAdmin });

    expect(res.statusCode).toBe(200);
    expect(res.json().events).toHaveLength(4);
  });

  it("creates a draft by default", async () => {
    const { app, events } = harness();

    const res = await app.inject({
      method: "POST",
      url: "/admin/api/events",
      headers: asAdmin,
      payload: { eventId: 900, name: "New Thing", venue: "A room" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().event).toMatchObject({ eventId: 900, name: "New Thing", status: "draft" });
    expect(events.rows.get(900)?.status).toBe("draft");
  });

  it("refuses an event id that is not a taxon", async () => {
    const { app } = harness();

    for (const eventId of [2_147_483_648, -1, 1.5, "4242", true, null]) {
      const res = await app.inject({
        method: "POST",
        url: "/admin/api/events",
        headers: asAdmin,
        payload: { eventId, name: "Nope" },
      });
      expect(res.statusCode, `eventId ${String(eventId)}`).toBe(400);
    }
  });

  it("refuses to reuse a taxon that is already an event", async () => {
    const { app } = harness();

    const res = await app.inject({
      method: "POST",
      url: "/admin/api/events",
      headers: asAdmin,
      payload: { eventId: OPEN_EVENT, name: "Collision" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("NFTokenTaxon");
  });

  it("updates the editable fields", async () => {
    const { app, events } = harness();

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/api/events/${OPEN_EVENT}`,
      headers: asAdmin,
      payload: { name: "XRPL Meetup (moved)", venue: "Room 2", status: "live" },
    });

    expect(res.statusCode).toBe(200);
    expect(events.rows.get(OPEN_EVENT)).toMatchObject({
      name: "XRPL Meetup (moved)",
      venue: "Room 2",
      status: "live",
    });
  });

  it("refuses to change the event id", async () => {
    const { app, events } = harness();

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/api/events/${OPEN_EVENT}`,
      headers: asAdmin,
      payload: { eventId: 9999, name: "Renumbered" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("NFTokenTaxon");
    expect(events.rows.has(9999)).toBe(false);
    expect(events.rows.get(OPEN_EVENT)?.name).toBe("XRPL Meetup");
  });

  it("refuses an empty patch and unknown fields", async () => {
    const { app } = harness();

    const empty = await app.inject({
      method: "PATCH",
      url: `/admin/api/events/${OPEN_EVENT}`,
      headers: asAdmin,
      payload: {},
    });
    const unknown = await app.inject({
      method: "PATCH",
      url: `/admin/api/events/${OPEN_EVENT}`,
      headers: asAdmin,
      payload: { taxon: 12 },
    });

    expect(empty.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
  });

  it("404s a patch to an event that does not exist", async () => {
    const { app } = harness();

    const res = await app.inject({
      method: "PATCH",
      url: "/admin/api/events/998",
      headers: asAdmin,
      payload: { name: "Ghost" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("lets metadataUri change while no badge points at it", async () => {
    const { app, events } = harness();

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/api/events/${OPEN_EVENT}`,
      headers: asAdmin,
      payload: { metadataUri: "ipfs://new/meta.json" },
    });

    expect(res.statusCode).toBe(200);
    expect(events.rows.get(OPEN_EVENT)?.metadataUri).toBe("ipfs://new/meta.json");
  });

  it("refuses a metadataUri change once badges exist, and says why", async () => {
    const { app, events } = harness();
    events.withBadges.add(OPEN_EVENT);

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/api/events/${OPEN_EVENT}`,
      headers: asAdmin,
      payload: { metadataUri: "ipfs://new/meta.json" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/immutable/i);
    expect(res.json().error.details).toMatchObject({ reason: "badges_already_minted" });
    // And nothing moved.
    expect(events.rows.get(OPEN_EVENT)?.metadataUri).toBe(`ipfs://event-${OPEN_EVENT}/meta.json`);
  });

  it("still allows the other fields once badges exist", async () => {
    const { app, events } = harness();
    events.withBadges.add(OPEN_EVENT);

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/api/events/${OPEN_EVENT}`,
      headers: asAdmin,
      payload: { venue: "Room 3", metadataUri: `ipfs://event-${OPEN_EVENT}/meta.json` },
    });

    // The URI is in the patch but unchanged, so there is nothing to refuse.
    expect(res.statusCode).toBe(200);
    expect(events.rows.get(OPEN_EVENT)?.venue).toBe("Room 3");
  });
});

describe("GET /admin/api/events/:eventId/registrations", () => {
  it("returns the page with total and checkedIn", async () => {
    const { app, registrations } = harness();
    await registrations.create({ eventId: OPEN_EVENT, address: ATTENDEE, addressProof: "xaman_signin" });
    await registrations.create({ eventId: OPEN_EVENT, address: OTHER, addressProof: "xaman_signin" });
    await registrations.markCheckedIn("reg-2");

    const res = await app.inject({
      method: "GET",
      url: `/admin/api/events/${OPEN_EVENT}/registrations`,
      headers: asAdmin,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ eventId: OPEN_EVENT, total: 2, checkedIn: 1 });
    expect(res.json().registrations).toHaveLength(2);
  });

  it("filters on checkedIn", async () => {
    const { app, registrations } = harness();
    await registrations.create({ eventId: OPEN_EVENT, address: ATTENDEE, addressProof: "xaman_signin" });
    await registrations.create({ eventId: OPEN_EVENT, address: OTHER, addressProof: "xaman_signin" });
    await registrations.markCheckedIn("reg-2");

    const res = await app.inject({
      method: "GET",
      url: `/admin/api/events/${OPEN_EVENT}/registrations?checkedIn=false`,
      headers: asAdmin,
    });

    expect(res.json().registrations).toHaveLength(1);
    expect(res.json().registrations[0].address).toBe(ATTENDEE);
  });

  it("404s an event that does not exist", async () => {
    const { app } = harness();

    const res = await app.inject({
      method: "GET",
      url: "/admin/api/events/997/registrations",
      headers: asAdmin,
    });

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Starting the proof
// ---------------------------------------------------------------------------

describe("POST /api/events/:eventId/registrations/signin", () => {
  it("hands back the QR code, the deeplink and the websocket", async () => {
    const { app, signIn } = harness();

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations/signin`,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(HANDLES);
    expect(signIn.created).toEqual([{ eventId: OPEN_EVENT }]);
  });

  it("passes a return url through", async () => {
    const { app, signIn } = harness();

    await app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations/signin`,
      payload: { returnUrl: { web: "https://poap.test/r" } },
    });

    expect(signIn.created[0]).toEqual({
      eventId: OPEN_EVENT,
      returnUrl: { web: "https://poap.test/r" },
    });
  });

  it("works for a live event, because walk-ups are the point", async () => {
    const { app } = harness();

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${LIVE_EVENT}/registrations/signin`,
    });

    expect(res.statusCode).toBe(201);
  });

  it("404s a draft event and never calls Xaman for it", async () => {
    const { app, signIn } = harness();

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${DRAFT_EVENT}/registrations/signin`,
    });

    expect(res.statusCode).toBe(404);
    expect(signIn.created).toHaveLength(0);
  });

  it("404s a closed event and an event that does not exist", async () => {
    const { app } = harness();

    const closed = await app.inject({
      method: "POST",
      url: `/api/events/${CLOSED_EVENT}/registrations/signin`,
    });
    const missing = await app.inject({ method: "POST", url: "/api/events/996/registrations/signin" });

    expect(closed.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
  });
});

describe("GET /api/registrations/signin/:uuid", () => {
  it("reports a pending payload with no address", async () => {
    const { app, signIn } = harness();
    signIn.pending(UUID_A);

    const res = await app.inject({ method: "GET", url: `/api/registrations/signin/${UUID_A}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ uuid: UUID_A, resolved: false, signed: false, rejected: false });
    expect(res.json().address).toBeUndefined();
  });

  it("reports a declined payload with no address", async () => {
    const { app, signIn } = harness();
    signIn.declined(UUID_A);

    const res = await app.inject({ method: "GET", url: `/api/registrations/signin/${UUID_A}` });

    expect(res.json()).toEqual({ uuid: UUID_A, resolved: true, signed: false, rejected: true });
    expect(res.json().address).toBeUndefined();
  });

  it("reports the address once it is signed", async () => {
    const { app, signIn } = harness();
    signIn.signed(UUID_A, ATTENDEE);

    const res = await app.inject({ method: "GET", url: `/api/registrations/signin/${UUID_A}` });

    expect(res.json()).toMatchObject({ signed: true, address: ATTENDEE });
  });

  it("400s something that is not a uuid, without asking Xaman", async () => {
    const { app, signIn } = harness();

    const res = await app.inject({ method: "GET", url: "/api/registrations/signin/not-a-uuid" });

    expect(res.statusCode).toBe(400);
    expect(signIn.resolved).toHaveLength(0);
  });

  it("404s a payload Xaman has never heard of", async () => {
    const { app } = harness();

    const res = await app.inject({ method: "GET", url: `/api/registrations/signin/${UUID_C}` });

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Finishing the proof — the address rule
// ---------------------------------------------------------------------------

/**
 * A complete registration body.
 *
 * displayName and email are required, and almost none of these tests are about
 * that — they are about replay, proof, and what the store ends up holding. The
 * override wins, so a test that IS about a bad field still says so inline.
 */
const regBody = (over: Record<string, unknown> = {}) => ({
  signinUuid: UUID_A,
  displayName: "Ada",
  email: "ada@example.com",
  ...over,
});

describe("POST /api/events/:eventId/registrations", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
    h.signIn.signed(UUID_A, ATTENDEE);
  });

  it("registers the address that signed, with the proof recorded", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_A, displayName: "Ada", email: "ada@example.com" }),
    });

    expect(res.statusCode).toBe(201);
    expect(h.registrations.rows).toHaveLength(1);
    expect(h.registrations.rows[0]).toMatchObject({
      eventId: OPEN_EVENT,
      address: ATTENDEE,
      addressProof: "xaman_signin",
      signinPayloadUuid: UUID_A,
      displayName: "Ada",
      email: "ada@example.com",
    });
  });

  it("IGNORES an address in the request body and uses the one that signed", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      // OTHER is a perfectly valid classic address. It is simply not the one
      // that approved the payload, so it must not appear anywhere.
      payload: regBody({ signinUuid: UUID_A, address: OTHER, displayName: "Mallory" }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().registration.address).toBe(ATTENDEE);
    expect(h.registrations.createInputs[0]?.address).toBe(ATTENDEE);
    expect(JSON.stringify(h.registrations.rows)).not.toContain(OTHER);
  });

  it("refuses a payload that has not been signed yet", async () => {
    h.signIn.pending(UUID_B);

    const res = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_B, address: OTHER }),
    });

    expect(res.statusCode).toBe(400);
    expect(h.registrations.rows).toHaveLength(0);
  });

  it("refuses a payload that was declined", async () => {
    h.signIn.declined(UUID_B);

    const res = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_B }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/declined or expired/i);
    expect(h.registrations.rows).toHaveLength(0);
  });

  it("stores nothing when the resolved account is not a valid address", async () => {
    // What XummSignInService.resolve() does with rubbish from the Xaman API.
    h.signIn.throws(
      UUID_B,
      new XrplLayerError("INVALID_ADDRESS", 'account "rNOTANADDRESS" is not a valid XRPL classic address'),
    );

    const res = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_B }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ADDRESS");
    expect(h.registrations.rows).toHaveLength(0);
  });

  it("refuses a replayed sign-in", async () => {
    const first = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_A, displayName: "Ada" }),
    });
    // A signed payload stays signed, so Xaman would happily answer again.
    const replay = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_A, displayName: "Mallory", email: "mallory@example.com" }),
    });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.message).toMatch(/already been used/i);
    expect(h.registrations.rows).toHaveLength(1);
    // The replay did not overwrite either field with Mallory's.
    expect(h.registrations.rows[0]).toMatchObject({
      displayName: "Ada",
      email: "ada@example.com",
    });
  });

  it("refuses a replay across events too", async () => {
    await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_A }),
    });

    const elsewhere = await h.app.inject({
      method: "POST",
      url: `/api/events/${LIVE_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_A }),
    });

    expect(elsewhere.statusCode).toBe(409);
    expect(h.registrations.rows).toHaveLength(1);
  });

  it("catches a replay that survived a restart, using the stored uuid", async () => {
    // The in-process ticket book is empty here — this is the row itself saying
    // which proof it was created from.
    await h.registrations.create({
      eventId: OPEN_EVENT,
      address: ATTENDEE,
      addressProof: "xaman_signin",
      signinPayloadUuid: UUID_A,
    });

    const res = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_A }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/already been used/i);
  });

  it("409s a genuine re-registration with the record they already have", async () => {
    await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_A, displayName: "Ada", email: "ada@example.com" }),
    });

    // Same person, same wallet, a NEW sign-in: they lost the confirmation link
    // and went round again. Not an error, and not a second row.
    h.signIn.signed(UUID_B, ATTENDEE);
    const again = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_B }),
    });

    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("DUPLICATE_CLAIM");
    expect(again.json().registration).toMatchObject({ id: "reg-1", address: ATTENDEE });
    // Still no email in an attendee-facing body.
    expect(JSON.stringify(again.json())).not.toContain("ada@example.com");
    expect(h.registrations.rows).toHaveLength(1);
  });

  it("hands the sign-in back when the write failed, so nobody has to sign twice", async () => {
    h.registrations.failNextCreate = new XrplLayerError("CONNECTION_FAILED", "database is on fire");

    const failed = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_A }),
    });
    const retry = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_A }),
    });

    expect(failed.statusCode).toBe(502);
    expect(retry.statusCode).toBe(201);
    expect(h.registrations.rows).toHaveLength(1);
  });

  it("cannot be used against a draft event", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/events/${DRAFT_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_A }),
    });

    expect(res.statusCode).toBe(404);
    expect(h.registrations.rows).toHaveLength(0);
    // Not even resolved: there is nothing to register against.
    expect(h.signIn.resolved).toHaveLength(0);
  });

  it("validates the optional fields", async () => {
    const badEmail = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_A, email: "not-an-email" }),
    });
    const longName = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_A, displayName: "A".repeat(121) }),
    });
    const badUuid = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: "nope" }),
    });

    expect(badEmail.statusCode).toBe(400);
    expect(longName.statusCode).toBe(400);
    expect(badUuid.statusCode).toBe(400);
    expect(h.registrations.rows).toHaveLength(0);
  });

  it("refuses a registration with no name", async () => {
    // A door cannot be worked off a list of wallet addresses, so the name is
    // required. The email is not — see the test below.
    const res = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: { signinUuid: UUID_A },
    });

    expect(res.statusCode).toBe(400);
    expect(h.registrations.rows).toHaveLength(0);
  });

  it("registers with a name and no email", async () => {
    // Mandatory for one release (migration 008), optional again as of 009:
    // asking for an address costs registrations at a door, and nothing about
    // the badge depends on reaching anyone afterwards.
    const res = await h.app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: { signinUuid: UUID_A, displayName: "Ada" },
    });

    expect(res.statusCode).toBe(201);
    expect(h.registrations.rows).toHaveLength(1);
    expect(h.registrations.rows[0]).toMatchObject({ displayName: "Ada" });
    expect(h.registrations.rows[0]?.email ?? null).toBeNull();
  });

  it("still refuses a name that is only whitespace, and a malformed email", async () => {
    for (const partial of [
      { signinUuid: UUID_A, displayName: "   ", email: "ada@example.com" },
      { signinUuid: UUID_A, displayName: "Ada", email: "not-an-email" },
    ]) {
      const res = await h.app.inject({
        method: "POST",
        url: `/api/events/${OPEN_EVENT}/registrations`,
        payload: partial,
      });
      expect(res.statusCode, JSON.stringify(partial)).toBe(400);
    }
    // Nothing half-written: a refused body never reaches the store.
    expect(h.registrations.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The confirmation view
// ---------------------------------------------------------------------------

describe("GET /api/registrations/:id", () => {
  it("shows the event, the address and the two timestamps — and no email", async () => {
    const { app, registrations } = harness();
    await registrations.create({
      eventId: OPEN_EVENT,
      address: ATTENDEE,
      addressProof: "xaman_signin",
      displayName: "Ada",
      email: "ada@example.com",
      signinPayloadUuid: UUID_A,
    });

    const res = await app.inject({ method: "GET", url: "/api/registrations/reg-1" });
    const view = res.json().registration;

    expect(res.statusCode).toBe(200);
    expect(Object.keys(view).sort()).toEqual([
      "address",
      "checkedInAt",
      "displayName",
      "event",
      "id",
      "registeredAt",
    ]);
    expect(view).toMatchObject({
      id: "reg-1",
      address: ATTENDEE,
      displayName: "Ada",
      checkedInAt: null,
    });
    expect(view.event).toMatchObject({ eventId: OPEN_EVENT, name: "XRPL Meetup" });
    expect(res.body).not.toContain("ada@example.com");
    expect(res.body).not.toContain(UUID_A);
  });

  it("shows the check-in once a volunteer has scanned them", async () => {
    const { app, registrations } = harness();
    await registrations.create({ eventId: OPEN_EVENT, address: ATTENDEE, addressProof: "xaman_signin" });
    await registrations.markCheckedIn("reg-1", new Date("2026-09-01T10:00:00.000Z"));

    const res = await app.inject({ method: "GET", url: "/api/registrations/reg-1" });

    expect(res.json().registration.checkedInAt).toBe("2026-09-01T10:00:00.000Z");
  });

  it("404s an unknown id", async () => {
    const { app } = harness();

    const res = await app.inject({ method: "GET", url: "/api/registrations/reg-nope" });

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// No Xaman keys
// ---------------------------------------------------------------------------

describe("with NullSignInService", () => {
  function nullHarness(): Harness {
    return harness({ deps: { signIn: new NullSignInService() } });
  }

  it("fails the sign-in route with a typed, readable error", async () => {
    const { app } = nullHarness();

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations/signin`,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("CONFIG_INVALID");
    expect(res.json().error.message).toContain("XUMM_API_KEY");
  });

  it("fails the registration route the same way", async () => {
    const { app, registrations } = nullHarness();

    const res = await app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations`,
      payload: regBody({ signinUuid: UUID_A }),
    });

    expect(res.json().error.code).toBe("CONFIG_INVALID");
    expect(registrations.rows).toHaveLength(0);
  });

  it("still serves everything else", async () => {
    const { app, registrations } = nullHarness();
    await registrations.create({ eventId: OPEN_EVENT, address: ATTENDEE, addressProof: "xaman_signin" });

    const list = await app.inject({ method: "GET", url: "/api/events" });
    const one = await app.inject({ method: "GET", url: `/api/events/${OPEN_EVENT}` });
    const confirmation = await app.inject({ method: "GET", url: "/api/registrations/reg-1" });
    const admin = await app.inject({
      method: "GET",
      url: `/admin/api/events/${OPEN_EVENT}/registrations`,
      headers: asAdmin,
    });

    expect([list.statusCode, one.statusCode, confirmation.statusCode, admin.statusCode]).toEqual([
      200, 200, 200, 200,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe("buildServer wiring", () => {
  it("serves the public registration routes", async () => {
    const { deps } = makeDeps();
    const app = buildServer(deps);

    const list = await app.inject({ method: "GET", url: "/api/events" });
    const signin = await app.inject({
      method: "POST",
      url: `/api/events/${OPEN_EVENT}/registrations/signin`,
    });

    expect(list.statusCode).toBe(200);
    expect(signin.statusCode).toBe(201);
  });

  it("does not serve the admin surface to an anonymous caller", async () => {
    const { deps } = makeDeps();
    const app = buildServer(deps);

    const res = await app.inject({ method: "GET", url: "/admin/api/events" });

    // 401 from the guard, or 503 from the prefix hook when this deployment has
    // no admin credentials at all. Never 200, and never the event list.
    expect([401, 503]).toContain(res.statusCode);
    expect(res.body).not.toContain("Secret Offsite");
  });

  it("registers nothing when the repositories are absent", async () => {
    const { deps } = makeDeps();
    const app = buildServer({ ...deps, events: undefined, registrations: undefined });

    const res = await app.inject({ method: "GET", url: "/api/events" });

    expect(res.statusCode).toBe(404);
  });

  it("rate limits the sign-in route", async () => {
    const { deps } = makeDeps({
      deps: { rateLimit: { enabled: true, signin: { max: 1, timeWindow: "1 minute" } } },
    });
    const app = buildServer(deps);
    const url = `/api/events/${OPEN_EVENT}/registrations/signin`;

    const first = await app.inject({ method: "POST", url });
    const second = await app.inject({ method: "POST", url });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(429);
  });
});
