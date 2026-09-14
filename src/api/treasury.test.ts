/**
 * The organiser's treasury routes.
 *
 * Real stores, a real vault and the real ledger operations against a
 * MockGateway, so what is asserted is the whole path from a click in the
 * console to a Payment — and, as often, the refusal that stops one.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import type { ZodType } from "zod";
import { MockGateway, rippledError } from "../../test/helpers/mock-gateway.js";
import type { AppConfig } from "../config.js";
import { MemoryAllowanceLedger } from "../db/allowance-ledger.js";
import { MemoryAttendanceRepository, MemoryEventRepository } from "../db/memory.js";
import { MemoryTreasuryRepository } from "../db/treasury-repo.js";
import { TreasuryService } from "../treasury/service.js";
import { TreasuryVault } from "../treasury/vault.js";
import type { EventStatus } from "../types.js";
import { readAccount } from "../xrpl/account.js";
import { payAllowance } from "../xrpl/allowance.js";
import { sweepTreasury } from "../xrpl/treasury.js";
import type { ApiDeps } from "./deps.js";
import { registerErrorHandler } from "./http-errors.js";
import type { AdminGuard } from "./routes/events.js";
import { registerTreasuryRoutes } from "./routes/treasury.js";

const ISSUER = "rBdhYBA2uaVYG7ia2yusmPu5qMS4hE6oQ";
const ORGANISER = "rPeZcWESwr1Wy64tw6JdVqtKNjhuUzHK2i";
const EVENT = 700012;
const ADMIN_HEADER = "x-test-admin";
const asAdmin = { [ADMIN_HEADER]: "yes" };
const TEST_MASTER_KEY = "0123456789abcdef".repeat(4);

function testConfig(): AppConfig {
  return {
    endpoint: "wss://clio.altnet.rippletest.net:51233",
    fallbackEndpoints: [],
    network: "testnet",
    issuerAddress: ISSUER,
    issuerSeed: "sEdV6Xn3bRq9J2wY4tK8mZpL1cH7dQa",
    reward: { treasuryMasterKey: TEST_MASTER_KEY, maxPerAttendeeXrp: "10", feeBufferXrp: "0.01" },
    pinata: { gateway: "https://gateway.pinata.cloud" },
    xumm: {},
    demoEnabled: false,
    badgeImageUriMode: "https" as const,
    badgeMetadataUriMode: "https" as const,
    admin: { sessionTtlHours: 12 },
    api: { port: 0, host: "127.0.0.1", trustProxy: false, secureCookies: false },
  };
}

const fakeRequireAdmin: AdminGuard = (request: FastifyRequest, reply: FastifyReply) => {
  if (request.headers[ADMIN_HEADER] === "yes") return undefined;
  return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Not signed in." } });
};

interface Harness {
  app: FastifyInstance;
  gateway: MockGateway;
  events: MemoryEventRepository;
  attendance: MemoryAttendanceRepository;
  allowances: MemoryAllowanceLedger;
  treasuries: TreasuryService;
  /** Balances the fake ledger knows, in drops. Absent means the account does not exist. */
  accounts: Map<string, { Balance: string; OwnerCount?: number; Flags?: number }>;
}

async function harness(
  options: { status?: EventStatus; allowanceXrp?: string; budgetXrp?: string; key?: boolean } = {},
): Promise<Harness> {
  const attendance = new MemoryAttendanceRepository();
  const events = new MemoryEventRepository(attendance);
  await events.create({
    eventId: EVENT,
    name: "REDTAPE 10K",
    status: options.status ?? "live",
    allowanceXrp: options.allowanceXrp ?? "5",
    budgetXrp: options.budgetXrp ?? "20",
  });
  const allowances = new MemoryAllowanceLedger({ events });
  const treasuries = new TreasuryService(
    new MemoryTreasuryRepository(events),
    options.key === false ? undefined : new TreasuryVault(TEST_MASTER_KEY),
  );

  const accounts = new Map<string, { Balance: string; OwnerCount?: number; Flags?: number }>();
  let paid = 0;
  const gateway = new MockGateway({ issuerAddress: ISSUER })
    .onRequest("account_info", (payload: Record<string, unknown>) => {
      const data = accounts.get(String(payload.account));
      return data ? { result: { account_data: data } } : rippledError("actNotFound");
    })
    .onSubmit("Payment", () => {
      paid += 1;
      return { hash: paid.toString(16).toUpperCase().padStart(64, "0"), ledgerIndex: paid };
    });

  const deps = {
    config: testConfig(),
    gateway,
    attendance,
    events,
    allowances,
    treasuries,
    chain: { readAccount, payAllowance, sweepTreasury },
    requireAdmin: fakeRequireAdmin,
    rateLimit: { enabled: false },
  } as unknown as ApiDeps;

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(({ schema }) => (data) => {
    const result = (schema as ZodType).safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  });
  registerErrorHandler(app);
  registerTreasuryRoutes(app, deps);

  return { app, gateway, events, attendance, allowances, treasuries, accounts };
}

async function badgeHolder(h: Harness, address: string, n: number): Promise<void> {
  await h.attendance.insert({
    eventId: EVENT,
    address,
    nftokenId: n.toString(16).padStart(64, "0"),
    txHash: (n + 1000).toString(16).padStart(64, "0"),
    ledgerIndex: 1000 + n,
  });
}

const payments = (h: Harness) => h.gateway.submits.filter((s) => s.transactionType === "Payment");

// ---------------------------------------------------------------------------

describe("GET /admin/api/events/:eventId/treasury", () => {
  it("makes the treasury on first read, and shows its address, its balance and the budget", async () => {
    const h = await harness();

    const first = await h.app.inject({ method: "GET", url: `/admin/api/events/${EVENT}/treasury`, headers: asAdmin });

    expect(first.statusCode).toBe(200);
    const address = first.json().address as string;
    expect(address).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
    expect((await h.treasuries.find(EVENT))?.address).toBe(address);

    // Funded with 11 XRP, and one attendee already paid 6.21 of a 20 XRP budget.
    h.accounts.set(address, { Balance: "11000000", OwnerCount: 0 });
    const booked = await h.allowances.reserve({
      eventId: EVENT,
      address: ORGANISER,
      allowanceXrp: "5",
      topupXrp: "1.21",
      treasuryAddress: address,
      budgetXrp: "20",
    });
    await h.allowances.confirm(booked!.id, "E".repeat(64));

    const res = await h.app.inject({ method: "GET", url: `/admin/api/events/${EVENT}/treasury`, headers: asAdmin });

    expect(res.json()).toEqual({
      eventId: EVENT,
      configured: true,
      address,
      account: { activated: true, balanceXrp: "11", reserveXrp: "1", spendableXrp: "10" },
      allowanceXrp: "5",
      budgetXrp: "20",
      committedXrp: "6.21",
      paidXrp: "6.21",
      paidCount: 1,
      inFlightCount: 0,
      remainingBudgetXrp: "13.79",
      // 13.79 still to pay out, 10 on hand.
      fundingNeededXrp: "3.79",
      largestPaymentXrp: "6.21",
      maxPerAttendeeXrp: "10",
      feeBufferXrp: "0.01",
    });
  });

  it("never sends a seed, sealed or otherwise", async () => {
    const h = await harness();

    const res = await h.app.inject({ method: "GET", url: `/admin/api/events/${EVENT}/treasury`, headers: asAdmin });
    const stored = await h.treasuries.find(EVENT);

    expect(res.body).not.toContain(stored?.sealedSeed ?? "never");
    expect(res.body).not.toContain("v1.");
    expect(res.body).not.toMatch(/"seed"|sealed/i);
  });

  it("asks for the base reserve too when the treasury has never been funded", async () => {
    const h = await harness();

    const res = await h.app.inject({ method: "GET", url: `/admin/api/events/${EVENT}/treasury`, headers: asAdmin });

    expect(res.json().account).toMatchObject({ activated: false, spendableXrp: "0" });
    expect(res.json().fundingNeededXrp).toBe("21");
  });

  it("still answers about the budget when the ledger cannot be read", async () => {
    const h = await harness();
    const broken = new MockGateway({ issuerAddress: ISSUER }).onRequest("account_info", rippledError("tooBusy"));
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.setValidatorCompiler(({ schema }) => (data) => {
      const result = (schema as ZodType).safeParse(data);
      return result.success ? { value: result.data } : { error: result.error };
    });
    registerTreasuryRoutes(app, {
      config: testConfig(),
      gateway: broken,
      attendance: h.attendance,
      events: h.events,
      allowances: h.allowances,
      treasuries: h.treasuries,
      chain: { readAccount, payAllowance, sweepTreasury },
      requireAdmin: fakeRequireAdmin,
    } as unknown as ApiDeps);

    const res = await app.inject({ method: "GET", url: `/admin/api/events/${EVENT}/treasury`, headers: asAdmin });

    expect(res.statusCode).toBe(200);
    expect(res.json().account).toBeNull();
    expect(res.json().ledgerError).toBeTruthy();
    expect(res.json().budgetXrp).toBe("20");
  });

  it("says so on a server with no treasury key, and makes nothing", async () => {
    const h = await harness({ key: false });

    const res = await h.app.inject({ method: "GET", url: `/admin/api/events/${EVENT}/treasury`, headers: asAdmin });

    expect(res.json()).toMatchObject({ configured: false, address: null, account: null, fundingNeededXrp: null });
  });

  it("404s an event that does not exist, and 401s without a session", async () => {
    const h = await harness();
    expect((await h.app.inject({ method: "GET", url: "/admin/api/events/9/treasury", headers: asAdmin })).statusCode).toBe(404);
    for (const [method, url] of [
      ["GET", `/admin/api/events/${EVENT}/treasury`],
      ["GET", `/admin/api/events/${EVENT}/allowances`],
      ["POST", `/admin/api/events/${EVENT}/allowances/retry`],
      ["POST", `/admin/api/events/${EVENT}/treasury/sweep`],
    ] as const) {
      // A valid body, so what refuses it is the guard and not the schema.
      const res = await h.app.inject({
        method,
        url,
        ...(method === "POST" ? { payload: { destination: ORGANISER } } : {}),
      });
      expect(res.statusCode, url).toBe(401);
    }
    expect(payments(h)).toHaveLength(0);
  });
});

describe("GET /admin/api/events/:eventId/allowances", () => {
  it("lists who was paid what, newest first, in the words the console uses", async () => {
    const h = await harness();
    const treasury = await h.treasuries.ensure(EVENT);
    const first = await h.allowances.reserve({
      eventId: EVENT,
      address: ORGANISER,
      allowanceXrp: "5",
      topupXrp: "0.01",
      treasuryAddress: treasury!.address,
      budgetXrp: "20",
    });
    await h.allowances.confirm(first!.id, "F".repeat(64));
    const second = Wallet.generate().classicAddress;
    await h.allowances.reserve({
      eventId: EVENT,
      address: second,
      allowanceXrp: "5",
      topupXrp: "1.21",
      treasuryAddress: treasury!.address,
      budgetXrp: "20",
    });

    const res = await h.app.inject({ method: "GET", url: `/admin/api/events/${EVENT}/allowances`, headers: asAdmin });

    expect(res.json().total).toBe(2);
    expect(res.json().allowances.map((a: { address: string; status: string }) => [a.address, a.status])).toEqual([
      [second, "in_flight"],
      [ORGANISER, "paid"],
    ]);
  });
});

describe("POST /admin/api/events/:eventId/allowances/retry", () => {
  it("pays every badge holder who was missed, and skips the ones already paid", async () => {
    const h = await harness();
    const treasury = await h.treasuries.ensure(EVENT);
    const missed = Wallet.generate().classicAddress;
    await badgeHolder(h, ORGANISER, 1);
    await badgeHolder(h, missed, 2);
    const done = await h.allowances.reserve({
      eventId: EVENT,
      address: ORGANISER,
      allowanceXrp: "5",
      topupXrp: "1.21",
      treasuryAddress: treasury!.address,
      budgetXrp: "20",
    });
    await h.allowances.confirm(done!.id, "A".repeat(64));

    const res = await h.app.inject({ method: "POST", url: `/admin/api/events/${EVENT}/allowances/retry`, headers: asAdmin });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ eventId: EVENT, paid: 1, alreadyPaid: 1, nothingOwed: 0, failed: 0, more: false, failures: [] });
    expect(payments(h)).toHaveLength(1);
    expect(payments(h)[0]?.tx.Destination).toBe(missed);
  });

  it("stops at the budget and says why, rather than failing every attendee after it", async () => {
    const h = await harness({ budgetXrp: "6.21" });
    await h.treasuries.ensure(EVENT);
    for (let i = 0; i < 4; i += 1) await badgeHolder(h, Wallet.generate().classicAddress, i);

    const res = await h.app.inject({ method: "POST", url: `/admin/api/events/${EVENT}/allowances/retry`, headers: asAdmin });

    expect(res.json()).toMatchObject({ paid: 1, failed: 1, stoppedBecause: "budget" });
    expect(payments(h)).toHaveLength(1);
  });

  it("pays at most ten per press, and says there are more", async () => {
    const h = await harness({ budgetXrp: "1000", allowanceXrp: "1" });
    await h.treasuries.ensure(EVENT);
    for (let i = 0; i < 12; i += 1) await badgeHolder(h, Wallet.generate().classicAddress, i);

    const res = await h.app.inject({ method: "POST", url: `/admin/api/events/${EVENT}/allowances/retry`, headers: asAdmin });

    expect(res.json()).toMatchObject({ paid: 10, more: true });
    expect(payments(h)).toHaveLength(10);
  });

  it("refuses a draft event", async () => {
    const h = await harness({ status: "draft" });
    const res = await h.app.inject({ method: "POST", url: `/admin/api/events/${EVENT}/allowances/retry`, headers: asAdmin });
    expect(res.statusCode).toBe(409);
  });
});

describe("POST /admin/api/events/:eventId/treasury/sweep", () => {
  const sweepOf = (h: Harness, payload: Record<string, unknown>) =>
    h.app.inject({ method: "POST", url: `/admin/api/events/${EVENT}/treasury/sweep`, headers: asAdmin, payload });

  it("sends what is left to the address the organiser typed, once the event is over", async () => {
    const h = await harness({ status: "closed" });
    const treasury = await h.treasuries.ensure(EVENT);
    h.accounts.set(treasury!.address, { Balance: "8000000" });
    h.accounts.set(ORGANISER, { Balance: "30000000" });

    const res = await sweepOf(h, { destination: ORGANISER });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ eventId: EVENT, amountXrp: "6.999", destination: ORGANISER });
    expect(payments(h)[0]?.tx).toMatchObject({ Account: treasury!.address, Destination: ORGANISER, Amount: "6999000" });
  });

  it("refuses while the event is live", async () => {
    const h = await harness({ status: "live" });
    const res = await sweepOf(h, { destination: ORGANISER });
    expect(res.statusCode).toBe(409);
    expect(payments(h)).toHaveLength(0);
  });

  it("refuses while an allowance is still on its way out", async () => {
    const h = await harness({ status: "closed" });
    const treasury = await h.treasuries.ensure(EVENT);
    await h.allowances.reserve({
      eventId: EVENT,
      address: Wallet.generate().classicAddress,
      allowanceXrp: "5",
      topupXrp: "1.21",
      treasuryAddress: treasury!.address,
      budgetXrp: "20",
    });

    const res = await sweepOf(h, { destination: ORGANISER });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({ inFlightCount: 1 });
  });

  it("refuses an exchange address without its tag, before a drop moves", async () => {
    const h = await harness({ status: "closed" });
    const treasury = await h.treasuries.ensure(EVENT);
    h.accounts.set(treasury!.address, { Balance: "8000000" });
    h.accounts.set(ORGANISER, { Balance: "30000000", Flags: 0x00020000 });

    const res = await sweepOf(h, { destination: ORGANISER });

    expect(res.statusCode).toBe(400);
    expect(payments(h)).toHaveLength(0);
  });

  it("503s on a server with no treasury key, and 400s a destination that is not an address", async () => {
    const keyless = await harness({ status: "closed", key: false });
    expect((await sweepOf(keyless, { destination: ORGANISER })).statusCode).toBe(503);

    const h = await harness({ status: "closed" });
    expect((await sweepOf(h, { destination: "not-an-address" })).statusCode).toBe(400);
    expect((await sweepOf(h, { destination: ORGANISER, destinationTag: -1 })).statusCode).toBe(400);
  });
});
