/**
 * The organiser's two cross-event lists.
 *
 * What these routes are FOR is the thing to hold onto: every other read in
 * this API answers a question about one event, and these answer questions
 * about the deployment. So the cases below are mostly about the seam between
 * "all of it" and "one event's slice" — that `eventId` NARROWS rather than
 * selects, and that the counts keep describing the scope even when the rows
 * are filtered down to a handful.
 *
 * The guard is injected rather than exercised: src/api/auth.test.ts owns the
 * question of whether `/admin/api` is reachable without a session, and
 * re-asserting it here would be a second, weaker copy of that.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { MockGateway } from "../../test/helpers/mock-gateway.js";
import { MemoryAttendanceRepository, MemoryRegistrationRepository } from "../db/memory.js";
import type { AppConfig } from "../config.js";
import type { ApiDeps } from "./deps.js";
import { registerErrorHandler } from "./http-errors.js";
import { registerRegistryRoutes } from "./routes/registry.js";
import type { AdminGuard } from "./routes/events.js";

const ISSUER = "rISSUER00000000000000000000000000";
const ADMIN_HEADER = "x-test-admin";

const EVENT_A = 700012;
const EVENT_B = 70011;

const A1 = "rA100000000000000000000000000001";
const A2 = "rA200000000000000000000000000002";
const B1 = "rB100000000000000000000000000003";

/* Every test file in this directory carries its own, for the same reason: a
   shared one would be a second place to look when a config field changes. */
function testConfig(): AppConfig {
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
  };
}

/** Three lines instead of a session store. See the file comment. */
const fakeRequireAdmin: AdminGuard = (request: FastifyRequest, reply: FastifyReply) => {
  if (request.headers[ADMIN_HEADER] === "yes") return undefined;
  return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Not signed in." } });
};

interface Harness {
  app: FastifyInstance;
  registrations: MemoryRegistrationRepository;
  attendance: MemoryAttendanceRepository;
}

function harness(options: { registrations?: null } = {}): Harness {
  /* MemoryRegistrationRepository enforces the foreign key the way the table
     does, so the events have to exist before anybody can register for them. */
  const events = {
    find: async (eventId: number) =>
      eventId === EVENT_A || eventId === EVENT_B
        ? ({ eventId, name: `Event ${eventId}`, status: "closed" } as never)
        : null,
  };
  const registrations = new MemoryRegistrationRepository(events);
  const attendance = new MemoryAttendanceRepository();

  /* The MEMORY repositories, not hand-written fakes: these routes are mostly a
     thin skin over listAll/countAll, and a fake would let the skin and the
     query drift apart without a test noticing. src/db/repo-contract.test.ts is
     what keeps memory honest against Postgres. */
  const deps = {
    config: testConfig(),
    gateway: new MockGateway({ issuerAddress: ISSUER }),
    attendance,
    registrations: options.registrations === null ? undefined : registrations,
    requireAdmin: fakeRequireAdmin,
    rateLimit: { enabled: false },
  } as unknown as ApiDeps;

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(({ schema }) => (data) => {
    const result = (schema as ZodType).safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  });
  registerErrorHandler(app);
  registerRegistryRoutes(app, deps);

  return { app, registrations, attendance };
}

const asAdmin = { [ADMIN_HEADER]: "yes" };

async function seedRegistrations(h: Harness): Promise<void> {
  await h.registrations.create({ eventId: EVENT_A, address: A1, addressProof: "xaman_signin", displayName: "Priya" });
  await h.registrations.create({ eventId: EVENT_A, address: A2, addressProof: "xaman_signin", displayName: "Arjun" });
  await h.registrations.create({ eventId: EVENT_B, address: B1, addressProof: "xaman_signin", displayName: "Sneha" });
}

async function seedBadges(h: Harness): Promise<void> {
  await h.attendance.insert({
    eventId: EVENT_A, address: A1, nftokenId: "NFT-A1", txHash: "TX-A1",
    ledgerIndex: 106789555, claimedAt: new Date("2026-09-06T04:00:00.000Z"),
  });
  await h.attendance.insert({
    eventId: EVENT_B, address: B1, nftokenId: "NFT-B1", txHash: "TX-B1",
    ledgerIndex: 105000001, claimedAt: new Date("2026-08-25T18:00:00.000Z"),
  });
}

// ---------------------------------------------------------------------------

describe("GET /admin/api/registrations", () => {
  const get = (h: Harness, qs = "") =>
    h.app.inject({ method: "GET", url: `/admin/api/registrations${qs}`, headers: asAdmin });

  it("lists registrations from every event at once", async () => {
    const h = harness();
    await seedRegistrations(h);

    const body = (await get(h)).json();

    expect(body.total).toBe(3);
    expect(body.eventId).toBeNull();
    expect(body.registrations.map((r: { address: string }) => r.address).sort()).toEqual(
      [A1, A2, B1].sort(),
    );
  });

  it("narrows to one event without becoming a different endpoint", async () => {
    const h = harness();
    await seedRegistrations(h);

    const body = (await get(h, `?eventId=${EVENT_B}`)).json();

    expect(body.eventId).toBe(EVENT_B);
    expect(body.registrations).toHaveLength(1);
    expect(body.registrations[0].address).toBe(B1);
  });

  /*
   * The filter tabs show what they WOULD find. A count that moved when you
   * pressed a tab could not do that job, so the counts describe the scope and
   * only the rows are filtered.
   */
  it("keeps the counts describing the scope, not the filtered page", async () => {
    const h = harness();
    await seedRegistrations(h);
    const [first] = await h.registrations.listAll({ limit: 1 });
    await h.registrations.markCheckedIn(first!.id);

    const body = (await get(h, "?checkedIn=false")).json();

    expect(body.registrations).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(body.checkedIn).toBe(1);
  });

  it("scopes the counts to the event when one is given", async () => {
    const h = harness();
    await seedRegistrations(h);

    const body = (await get(h, `?eventId=${EVENT_A}`)).json();

    expect(body.total).toBe(2);
  });

  it("pages", async () => {
    const h = harness();
    await seedRegistrations(h);

    const first = (await get(h, "?limit=2&offset=0")).json();
    const second = (await get(h, "?limit=2&offset=2")).json();

    expect(first.registrations).toHaveLength(2);
    expect(second.registrations).toHaveLength(1);
    // Same window over one ordering: no row appears on both pages.
    const ids = new Set(first.registrations.map((r: { id: string }) => r.id));
    expect(second.registrations.some((r: { id: string }) => ids.has(r.id))).toBe(false);
  });

  it("refuses a request with no session", async () => {
    const h = harness();
    const res = await h.app.inject({ method: "GET", url: "/admin/api/registrations" });
    expect(res.statusCode).toBe(401);
  });

  it("503s rather than pretending the list is empty when no store is wired", async () => {
    // An empty list and a missing table look identical to a reader, and only
    // one of them is something an operator has to go and fix.
    const h = harness({ registrations: null });
    const res = await get(h);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("CONFIG_INVALID");
  });

  it("rejects a limit past the ceiling instead of honouring it", async () => {
    const h = harness();
    expect((await get(h, "?limit=5000")).statusCode).toBe(400);
  });
});

describe("GET /admin/api/badges", () => {
  const get = (h: Harness, qs = "") =>
    h.app.inject({ method: "GET", url: `/admin/api/badges${qs}`, headers: asAdmin });

  it("lists badges from every event at once", async () => {
    const h = harness();
    await seedBadges(h);

    const body = (await get(h)).json();

    expect(body.total).toBe(2);
    expect(body.badges.map((b: { eventId: number }) => b.eventId).sort()).toEqual(
      [EVENT_A, EVENT_B].sort(),
    );
  });

  it("carries the event on every row, because the list spans events", async () => {
    // Without it a cross-event list is a column of addresses with no way to
    // tell which door any of them walked through.
    const h = harness();
    await seedBadges(h);

    const row = (await get(h, `?eventId=${EVENT_A}`)).json().badges[0];

    expect(row).toMatchObject({
      eventId: EVENT_A,
      address: A1,
      nftokenId: "NFT-A1",
      txHash: "TX-A1",
      claimedAt: "2026-09-06T04:00:00.000Z",
    });
  });

  it("narrows to one event", async () => {
    const h = harness();
    await seedBadges(h);

    const body = (await get(h, `?eventId=${EVENT_B}`)).json();

    expect(body.total).toBe(1);
    expect(body.badges).toHaveLength(1);
    expect(body.badges[0].address).toBe(B1);
  });

  it("refuses a request with no session", async () => {
    const h = harness();
    const res = await h.app.inject({ method: "GET", url: "/admin/api/badges" });
    expect(res.statusCode).toBe(401);
  });
});
