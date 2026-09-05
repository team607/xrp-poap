/**
 * HTTP surface tests.
 *
 * The server is built from a hand-made ApiDeps: a MockGateway that throws on
 * any use it was not primed for, in-file fake repositories, and mocked ledger
 * operations. Nothing here touches the network, a database, or Xaman, and none
 * of it depends on src/db or src/xrpl behaving in a particular way — those have
 * their own unit tests.
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MockGateway } from "../../test/helpers/mock-gateway.js";
import type { AppConfig } from "../config.js";
import { XrplLayerError } from "../errors.js";
import type {
  AttendanceRecord,
  AttendanceRepository,
  BadgeUri,
  BadgeUriResolver,
  ClaimRecord,
  ClaimRepository,
  EventId,
  SponsorLedger,
  SponsorReservation,
  SponsorReserveInput,
  VerificationChecks,
  VerifyClaimResult,
} from "../types.js";
import type { XamanService } from "../xaman/client.js";
import {
  buildLoggerOptions,
  parseTrustProxy,
  serializeLoggedError,
  type ApiDeps,
  type ChainOps,
} from "./deps.js";
import { isSensitiveKey, redactDetails } from "./http-errors.js";
import { buildServer } from "./server.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = "rwukQtEt5yj9QGTBSoLWuBvVpPh5nNPpN4";
const ATTENDEE = "rwPy1pJd3RcHrEaqKk1yUiEGCqz8wewJZm";
const OTHER = "ra6pcMuGFgwSefKt4GPy6UCeEXkn2KtaNS";
const EVENT_ID = 4242;

const NFTOKEN_ID = "000800008685A6D01DEDD0C4365B0928256424853B9842F30A379442FF969F9D";
const OFFER_ID = "8685A6D01DEDD0C4365B0928256424853B9842F30A379442FF969F9DD0D3AABC";
const ACCEPT_TX = "B4068EC978F85028EFF92C1D9D48C249A5243E31EE517344378D33413E25EEBD";
const MINT_TX = "C31F96F645E7BDFDE9D28B2612A8C9442C4CB2DA3B05A5F8EA32F2A1BE2F32B7";

/** Shaped like a real family seed so the value-level scrub has something to bite. */
const FAKE_SEED = "sEdV6Xn3bRq9J2wY4tK8mZpL1cH7dQa";

const METADATA_URI = "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy/meta.json";

/** Per-attendee artwork, as the resolver would hand it back. Deliberately not METADATA_URI. */
const ATTENDEE_METADATA_URI =
  "ipfs://bafkreic7q2u3xj4hwvpn5nnkl3rvqfmt6a2zvzq7q4bxhk2m7uv3gy4wxa/meta.json";
const ATTENDEE_IMAGE_URI = "ipfs://bafkreib5g3jz2vkq7hxsdfe4o6l2npymu7cwq4t3nzr6xk4hbwzvq2mtwe";
/** A walk-up: nobody pre-pinned this one, so the claim itself pinned it. */
const WALKUP_METADATA_URI =
  "ipfs://bafkreid4vsn3rk6jqz7pt2mhx5w4cybgu6ftz2eo3l7qkxaj5nwrvh2yqi/meta.json";

const ALL_CHECKS_PASS: VerificationChecks = {
  transactionFound: true,
  isAcceptOffer: true,
  submittedByAddress: true,
  succeeded: true,
  issuerAndTaxonMatch: true,
};

function attendedResult(overrides: Partial<VerifyClaimResult> = {}): VerifyClaimResult {
  return {
    attended: true,
    status: "attended",
    checks: { ...ALL_CHECKS_PASS },
    nftokenId: NFTOKEN_ID,
    nftokenIdSource: "meta.nftoken_id",
    // Read off the accept transaction by verifyClaim(). This — never a value a
    // caller supplied — is what gets indexed.
    sellOfferId: OFFER_ID,
    isBurned: false,
    currentOwner: ATTENDEE,
    ledgerIndex: 4_242_000,
    ...overrides,
  };
}

function notAttendedResult(): VerifyClaimResult {
  return {
    attended: false,
    status: "not_attended",
    checks: { ...ALL_CHECKS_PASS, submittedByAddress: false },
    failedCheck: "submittedByAddress",
    reason: "The transaction was not submitted by that address",
  };
}

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

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeAttendanceRepository implements AttendanceRepository {
  readonly rows: AttendanceRecord[] = [];
  private seq = 0;

  async insert(record: AttendanceRecord): Promise<AttendanceRecord> {
    // Stands in for UNIQUE (event_id, address).
    const clash = this.rows.some(
      (row) => row.eventId === record.eventId && row.address === record.address,
    );
    if (clash) {
      throw new XrplLayerError(
        "DUPLICATE_CLAIM",
        `${record.address} already has a badge for event ${record.eventId}`,
        { eventId: record.eventId, address: record.address },
      );
    }
    this.seq += 1;
    const stored: AttendanceRecord = {
      ...record,
      id: String(this.seq),
      claimedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    this.rows.push(stored);
    return stored;
  }

  async findByEventAndAddress(eventId: EventId, address: string): Promise<AttendanceRecord | null> {
    return this.rows.find((row) => row.eventId === eventId && row.address === address) ?? null;
  }

  async listByEvent(
    eventId: EventId,
    opts?: { limit?: number; offset?: number },
  ): Promise<AttendanceRecord[]> {
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return this.rows.filter((row) => row.eventId === eventId).slice(offset, offset + limit);
  }

  async countByEvent(eventId: EventId): Promise<number> {
    return this.rows.filter((row) => row.eventId === eventId).length;
  }

  async listByAddress(address: string): Promise<AttendanceRecord[]> {
    return this.rows.filter((row) => row.address === address);
  }
}

class FakeSponsorLedger implements SponsorLedger {
  readonly entries: Array<{
    id: string;
    eventId: EventId;
    address: string;
    amountXrp: string;
    txHash?: string;
    released?: boolean;
  }> = [];
  private seq = 0;

  async hasSponsored(eventId: EventId, address: string): Promise<boolean> {
    return this.entries.some(
      (e) => e.eventId === eventId && e.address === address && e.released !== true,
    );
  }

  async sponsoredTodayXrp(): Promise<string> {
    return "0";
  }

  async reserve(input: SponsorReserveInput): Promise<SponsorReservation | null> {
    if (await this.hasSponsored(input.eventId, input.address)) return null;
    this.seq += 1;
    const reservation: SponsorReservation = {
      id: `sponsor-${this.seq}`,
      eventId: input.eventId,
      address: input.address,
      amountXrp: input.amountXrp,
    };
    this.entries.push({ ...reservation });
    return reservation;
  }

  async confirm(reservationId: string, txHash: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === reservationId);
    if (entry) entry.txHash = txHash;
  }

  async release(reservationId: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === reservationId);
    if (entry) entry.released = true;
  }
}

/**
 * Stands in for the real claim slot table, unique index and all.
 *
 * `open()` is the whole point: it either takes (eventId, address) or returns
 * null, and it is the only thing between one attendee and N mints.
 */
class FakeClaimRepository implements ClaimRepository {
  readonly rows: ClaimRecord[] = [];
  private seq = 0;

  async open(input: {
    eventId: EventId;
    address: string;
    expiresAt?: Date;
  }): Promise<ClaimRecord | null> {
    if (this.rows.some((r) => r.eventId === input.eventId && r.address === input.address)) {
      return null;
    }
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

  async markClaimed(id: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.status = "claimed";
  }

  async markAbandoned(id: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.status = "abandoned";
  }

  async listExpired(now: Date, limit = 100): Promise<ClaimRecord[]> {
    return this.rows
      .filter(
        (r) => r.status === "pending" && r.offerId != null && r.expiresAt != null && r.expiresAt <= now,
      )
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex((r) => r.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

function makeChainMocks() {
  return {
    mint: vi.fn<ChainOps["mint"]>(async (_gateway, input) => ({
      nftokenId: NFTOKEN_ID,
      eventId: input.eventId,
      uri: input.uri,
      txHash: MINT_TX,
      ledgerIndex: 4_241_000,
      fee: "12",
    })),
    createClaimOffer: vi.fn<ChainOps["createClaimOffer"]>(async (_gateway, input) => ({
      offerId: OFFER_ID,
      nftokenId: input.nftokenId,
      destination: input.destination,
      txHash: MINT_TX,
      ledgerIndex: 4_241_001,
      fee: "12",
    })),
    accountExists: vi.fn<ChainOps["accountExists"]>(async () => true),
    /**
     * The claim route asks what a wallet HOLDS, not whether it exists — a real
     * account under base + owner reserve cannot accept a badge either. Tests
     * that want "this wallet needs funding" set this to a dust balance.
     */
    getAccountBalanceXrp: vi.fn<ChainOps["getAccountBalanceXrp"]>(async () => "100"),
    sponsorWallet: vi.fn<ChainOps["sponsorWallet"]>(async (_gateway, input) => ({
      sponsored: true,
      alreadyActivated: false,
      address: input.address,
      amountXrp: input.config.amountXrp,
      txHash: MINT_TX,
      ledgerIndex: 4_240_999,
    })),
    verifyClaim: vi.fn<ChainOps["verifyClaim"]>(async () => attendedResult()),
    getRoster: vi.fn<ChainOps["getRoster"]>(async (_gateway, eventId) => ({
      eventId,
      issuer: ISSUER,
      entries: [],
      minted: 0,
      claimed: 0,
      burned: 0,
      ownerUnknown: 0,
    })),
  };
}

type ChainMocks = ReturnType<typeof makeChainMocks>;

/**
 * A per-attendee badge URI resolver, faked.
 *
 * Deliberately NOT the real PinningBadgeUriResolver, and deliberately not
 * importing src/metadata at all: what these tests are about is what the claim
 * route does when the resolver is slow, angry or missing, and that has to be
 * assertable without Pinata, without a manifest on disk, and without the
 * resolver module having been written yet.
 *
 * The default implementation is the happy pre-pinned path. A test that wants a
 * failure reaches for `.mockRejectedValueOnce()` / `.mockImplementationOnce()`,
 * which leaves the retry behind it succeeding — which is the half of "the slot
 * was released" worth proving.
 */
function fakeBadgeUris(): { resolve: ReturnType<typeof vi.fn<BadgeUriResolver["resolve"]>> } {
  return {
    resolve: vi.fn<BadgeUriResolver["resolve"]>(async (): Promise<BadgeUri> => ({
      metadataUri: ATTENDEE_METADATA_URI,
      imageUri: ATTENDEE_IMAGE_URI,
      pinnedOnDemand: false,
    })),
  };
}

interface Harness {
  app: FastifyInstance;
  deps: ApiDeps;
  chain: ChainMocks;
  attendance: FakeAttendanceRepository;
  claims: FakeClaimRepository;
  sponsorLedger: FakeSponsorLedger;
  gateway: MockGateway;
}

/**
 * The injected admin check, and it ADMITS BY DEFAULT.
 *
 * Minting is behind the admin session, but these tests are about what minting
 * does — the slot, the sponsorship, the offer, the reserve — not about whether
 * the guard works. Making every one of them carry a session would be forty
 * edits that assert nothing new; src/api/auth.ts has its own tests for that.
 *
 * Refusal is exercised deliberately, by `deniedHarness()` below.
 */
const admitAdmin: NonNullable<ApiDeps["requireAdmin"]> = () => undefined;

const refuseAdmin: NonNullable<ApiDeps["requireAdmin"]> = (_request, reply) =>
  reply
    .code(401)
    .send({ error: { code: "UNAUTHORIZED", message: "Not signed in. POST /admin/api/login first." } });

function harness(options: { config?: Partial<AppConfig>; deps?: Partial<ApiDeps> } = {}): Harness {
  const chain = makeChainMocks();
  const attendance = new FakeAttendanceRepository();
  const claims = new FakeClaimRepository();
  const sponsorLedger = new FakeSponsorLedger();
  // Nothing is queued on it: any route that reaches for the ledger directly
  // fails the test loudly instead of quietly passing.
  const gateway = new MockGateway({ issuerAddress: ISSUER });

  const deps: ApiDeps = {
    config: testConfig(options.config),
    gateway,
    attendance,
    claims,
    sponsorLedger,
    chain,
    metadataUriForEvent: () => METADATA_URI,
    rateLimit: { enabled: false },
    requireAdmin: admitAdmin,
    ...options.deps,
  };

  return { app: buildServer(deps), deps, chain, attendance, claims, sponsorLedger, gateway };
}

/**
 * A harness whose logger is the real one from buildDeps(), pointed at an array.
 *
 * The point is that `buildLoggerOptions()` is used verbatim: what these tests
 * assert about the log sink is the configuration that ships, not a rehearsal
 * of it.
 */
function loggingHarness(options: Parameters<typeof harness>[0] = {}): Harness & {
  lines: string[];
  log(): string;
} {
  const lines: string[] = [];
  const h = harness({
    ...options,
    deps: {
      ...options.deps,
      logger: {
        ...buildLoggerOptions("trace"),
        stream: {
          write(line: string) {
            lines.push(line);
          },
        },
      },
    },
  });
  return { ...h, lines, log: () => lines.join("") };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("answers without touching the gateway", async () => {
    const h = harness();

    const res = await h.app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      network: "testnet",
      issuer: ISSUER,
      xamanConfigured: false,
    });
    expect(h.gateway.requests).toHaveLength(0);
    expect(h.gateway.submits).toHaveLength(0);
  });

  it("never echoes the issuer seed", async () => {
    const h = harness();
    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.body).not.toContain(FAKE_SEED);
  });
});

// ---------------------------------------------------------------------------
// POST /events/:eventId/claims
// ---------------------------------------------------------------------------

describe("POST /events/:eventId/claims", () => {
  it("mints, offers lazily to that one address, and returns the accept payload", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE, metadataUri: METADATA_URI },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();

    expect(body.accept).toEqual({
      TransactionType: "NFTokenAcceptOffer",
      Account: ATTENDEE,
      NFTokenSellOffer: OFFER_ID,
    });
    expect(Object.keys(body.accept)).toHaveLength(3);
    expect(body).toMatchObject({ offerId: OFFER_ID, nftokenId: NFTOKEN_ID });

    expect(h.chain.mint).toHaveBeenCalledTimes(1);
    expect(h.chain.mint.mock.calls[0]?.[1]).toEqual({ eventId: EVENT_ID, uri: METADATA_URI });

    // One offer, created at claim time, locked to this attendee.
    expect(h.chain.createClaimOffer).toHaveBeenCalledTimes(1);
    expect(h.chain.createClaimOffer.mock.calls[0]?.[1]).toEqual({
      nftokenId: NFTOKEN_ID,
      destination: ATTENDEE,
    });

    // Claiming is not attending: nothing is indexed until the chain confirms.
    expect(h.attendance.rows).toHaveLength(0);
  });

  it("uses the per-event default URI when the request omits one", async () => {
    const h = harness();

    await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE },
    });

    expect(h.chain.mint.mock.calls[0]?.[1]).toEqual({ eventId: EVENT_ID, uri: METADATA_URI });
  });

  it("400s on a malformed address", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: "rNotARealAddress!!" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
    expect(h.chain.mint).not.toHaveBeenCalled();
  });

  it("400s on an event id past the reserved taxon boundary", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "POST",
      url: "/events/2147483648/claims",
      payload: { address: ATTENDEE },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
    expect(h.chain.mint).not.toHaveBeenCalled();
  });

  it("400s when there is no metadata URI to mint", async () => {
    const h = harness({ deps: { metadataUriForEvent: () => undefined } });

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE },
    });

    expect(res.statusCode).toBe(400);
    expect(h.chain.mint).not.toHaveBeenCalled();
  });

  it("409s a second claim and hands back the record it already has", async () => {
    const h = harness();
    await h.attendance.insert({
      eventId: EVENT_ID,
      address: ATTENDEE,
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
      txHash: ACCEPT_TX,
      ledgerIndex: 4_242_000,
    });

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("DUPLICATE_CLAIM");
    expect(body.record).toMatchObject({ nftokenId: NFTOKEN_ID, txHash: ACCEPT_TX });
    // No XRP spent on a duplicate.
    expect(h.chain.mint).not.toHaveBeenCalled();
    expect(h.chain.createClaimOffer).not.toHaveBeenCalled();
  });

  it("409s an unactivated wallet with funding instructions when sponsorship is off", async () => {
    const h = harness();
    h.chain.accountExists.mockResolvedValue(false);
    h.chain.getAccountBalanceXrp.mockResolvedValue("0");

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("ACCOUNT_NOT_FOUND");
    expect(body.error.message).toMatch(/base reserve/i);
    // The number a person has to act on, not just the word.
    expect(body.error.message).toMatch(/owner reserve/i);
    expect(body.error.details).toMatchObject({ balanceXrp: "0", shortfallXrp: "1.2" });
    expect(h.chain.sponsorWallet).not.toHaveBeenCalled();
    expect(h.chain.mint).not.toHaveBeenCalled();
  });

  /**
   * THE REGRESSION THIS BLOCK EXISTS FOR.
   *
   * The gate used to be `accountExists()`. A wallet holding dust passes that —
   * the account is real — so nothing was sponsored, the badge was minted, the
   * offer created, and the attendee's wallet then refused the accept because it
   * could not afford the NFTokenPage. Cost: a badge nobody can take, 0.2 XRP of
   * issuer reserve locked in an offer that has to be reaped, and a volunteer
   * who had been told the wallet was ready.
   *
   * A dust balance is MORE likely than an empty account. It belongs to somebody
   * who has used XRP before, which is exactly who does not expect this.
   */
  it("sponsors a wallet that EXISTS but cannot afford the badge", async () => {
    const h = harness({
      config: { sponsor: { enabled: true, amountXrp: "1.5", dailyCapXrp: "50" } },
    });
    // Real account, activated, and still 0.2 XRP short of holding one badge.
    h.chain.accountExists.mockResolvedValue(true);
    h.chain.getAccountBalanceXrp.mockResolvedValue("1");

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE },
    });

    expect(res.statusCode).toBe(201);
    expect(h.chain.sponsorWallet).toHaveBeenCalledTimes(1);
    expect(h.chain.mint).toHaveBeenCalledTimes(1);
  });

  it("leaves a wallet alone the moment it can hold a badge", async () => {
    const h = harness({
      config: { sponsor: { enabled: true, amountXrp: "1.5", dailyCapXrp: "50" } },
    });
    // Exactly base + one owner reserve. Enough, so not a penny is spent.
    h.chain.accountExists.mockResolvedValue(true);
    h.chain.getAccountBalanceXrp.mockResolvedValue("1.2");

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE },
    });

    expect(res.statusCode).toBe(201);
    expect(h.chain.sponsorWallet).not.toHaveBeenCalled();
  });

  it("sponsors an unactivated wallet when sponsorship is on, passing the ledger guard", async () => {
    const h = harness({
      config: { sponsor: { enabled: true, amountXrp: "1.5", dailyCapXrp: "50" } },
    });
    h.chain.accountExists.mockResolvedValue(false);
    h.chain.getAccountBalanceXrp.mockResolvedValue("0");

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE },
    });

    expect(res.statusCode).toBe(201);
    expect(h.chain.sponsorWallet).toHaveBeenCalledTimes(1);
    const call = h.chain.sponsorWallet.mock.calls[0]?.[1];
    expect(call?.address).toBe(ATTENDEE);
    expect(call?.eventId).toBe(EVENT_ID);
    expect(call?.ledger).toBe(h.sponsorLedger);
  });

  it("maps a daily-cap refusal to 429 and a plain refusal to 403", async () => {
    const h = harness({
      config: { sponsor: { enabled: true, amountXrp: "1.5", dailyCapXrp: "50" } },
    });
    h.chain.accountExists.mockResolvedValue(false);
    h.chain.getAccountBalanceXrp.mockResolvedValue("0");
    h.chain.sponsorWallet.mockRejectedValueOnce(
      new XrplLayerError("SPONSORSHIP_DENIED", "daily cap reached", { kind: "daily_cap" }),
    );

    const capped = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE },
    });
    expect(capped.statusCode).toBe(429);

    h.chain.sponsorWallet.mockRejectedValueOnce(
      new XrplLayerError("SPONSORSHIP_DENIED", "already sponsored", { kind: "duplicate" }),
    );
    const denied = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: OTHER },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("still returns the accept payload when Xaman is unavailable", async () => {
    const brokenXaman: XamanService = {
      createClaimRequest: vi.fn(async () => {
        throw new XrplLayerError("CONFIG_INVALID", "Xaman is not configured");
      }),
      getPayload: vi.fn(async () => ({ resolved: false, signed: false })),
    };
    const h = harness({ deps: { xaman: brokenXaman } });

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().accept.NFTokenSellOffer).toBe(OFFER_ID);
    expect(res.json().xaman).toBeUndefined();
  });

  it("includes the Xaman handles when Xaman answers", async () => {
    const xaman: XamanService = {
      createClaimRequest: vi.fn(async () => ({
        uuid: "payload-uuid-1",
        qrPng: "https://xumm.app/qr.png",
        deeplink: "https://xumm.app/sign/payload-uuid-1",
        websocket: "wss://xumm.app/sign/payload-uuid-1",
        expiresAt: "2026-01-01T00:10:00.000Z",
      })),
      getPayload: vi.fn(async () => ({ resolved: false, signed: false })),
    };
    const h = harness({ deps: { xaman } });

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE, badgeName: "Feooh Meetup" },
    });

    expect(res.json().xaman).toMatchObject({
      uuid: "payload-uuid-1",
      deeplink: "https://xumm.app/sign/payload-uuid-1",
    });
  });

  it("rate limits harder than the global bucket, because it spends XRP", async () => {
    const h = harness({
      deps: { rateLimit: { enabled: true, claim: { max: 1, timeWindow: "1 minute" } } },
    });

    const first = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE },
    });
    const second = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: OTHER },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("RATE_LIMITED");
    expect(h.chain.mint).toHaveBeenCalledTimes(1);

    // Reads stay on the global bucket.
    const health = await h.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Per-attendee badge artwork — and what happens when Pinata will not play
// ---------------------------------------------------------------------------

/**
 * The precedence is body URI > per-attendee resolver > event-wide default > 400,
 * and the interesting half is the second step: it can pin to Pinata inside the
 * claim, so it can be slow, rate-limited or simply down while a volunteer holds
 * an attendee's phone. Every failure below is measured on two things — does the
 * attendee still get a badge, and is the claim slot still theirs afterwards.
 */
describe("POST /events/:eventId/claims — per-attendee badge artwork", () => {
  const claim = (app: FastifyInstance, address = ATTENDEE, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address, ...payload },
    });

  /** A Pinata failure in the shape the real pinner throws it. */
  const pinFailure = () =>
    new XrplLayerError("PIN_FAILED", "Pinata /pinning/pinJSONToIPFS responded 429 Too Many Requests", {
      path: "/pinning/pinJSONToIPFS",
      status: 429,
    });

  it("prefers an explicit metadataUri in the body and never calls the resolver", async () => {
    const badgeUris = fakeBadgeUris();
    const h = harness({ deps: { badgeUris } });

    const res = await claim(h.app, ATTENDEE, { metadataUri: METADATA_URI });

    expect(res.statusCode).toBe(201);
    expect(h.chain.mint.mock.calls[0]?.[1]).toEqual({ eventId: EVENT_ID, uri: METADATA_URI });
    // The caller already pinned it and said where. Nothing to resolve, nothing
    // to pay Pinata for, nothing that can time out.
    expect(badgeUris.resolve).not.toHaveBeenCalled();
    // Nothing was resolved, so there is nothing honest to say about pinning.
    expect(res.json().pinnedOnDemand).toBeUndefined();
  });

  it("resolves per attendee when the body carries no URI, and mints what it returns", async () => {
    const badgeUris = fakeBadgeUris();
    const h = harness({ deps: { badgeUris } });

    const res = await claim(h.app);

    expect(res.statusCode).toBe(201);
    expect(badgeUris.resolve).toHaveBeenCalledTimes(1);
    expect(badgeUris.resolve.mock.calls[0]?.[0]).toEqual({ eventId: EVENT_ID, address: ATTENDEE });
    // The resolver's URI is what lands on the ledger — not the event-wide one,
    // which is configured on this harness and would otherwise win by accident.
    expect(h.chain.mint.mock.calls[0]?.[1]).toEqual({
      eventId: EVENT_ID,
      uri: ATTENDEE_METADATA_URI,
    });
  });

  it("gives each attendee their own artwork", async () => {
    const badgeUris = fakeBadgeUris();
    const h = harness({ deps: { badgeUris } });

    await claim(h.app, ATTENDEE);
    await claim(h.app, OTHER);

    expect(badgeUris.resolve.mock.calls.map((call) => call[0]?.address)).toEqual([ATTENDEE, OTHER]);
  });

  it("reports pinnedOnDemand: true so a console can show a walk-up being pinned live", async () => {
    const badgeUris = fakeBadgeUris();
    badgeUris.resolve.mockResolvedValueOnce({
      metadataUri: WALKUP_METADATA_URI,
      imageUri: ATTENDEE_IMAGE_URI,
      pinnedOnDemand: true,
    });
    const h = harness({ deps: { badgeUris } });

    const walkup = await claim(h.app, ATTENDEE);

    expect(walkup.statusCode).toBe(201);
    expect(walkup.json().pinnedOnDemand).toBe(true);
    expect(h.chain.mint.mock.calls[0]?.[1]?.uri).toBe(WALKUP_METADATA_URI);
    // The existing shape is untouched: pinnedOnDemand rides alongside it.
    expect(walkup.json()).toMatchObject({ offerId: OFFER_ID, nftokenId: NFTOKEN_ID });

    // And the pre-pinned roster path says so too, rather than staying silent.
    const prePinned = await claim(h.app, OTHER);
    expect(prePinned.json().pinnedOnDemand).toBe(false);
  });

  it("falls back to the event-wide badge when the resolver throws, and warns", async () => {
    const badgeUris = fakeBadgeUris();
    badgeUris.resolve.mockRejectedValueOnce(pinFailure());
    const h = loggingHarness({ deps: { badgeUris } });

    const res = await claim(h.app);

    // A generic badge beats no badge at a live desk.
    expect(res.statusCode).toBe(201);
    expect(h.chain.mint.mock.calls[0]?.[1]).toEqual({ eventId: EVENT_ID, uri: METADATA_URI });
    expect(h.claims.rows).toHaveLength(1);
    expect(h.claims.rows[0]?.offerId).toBe(OFFER_ID);

    // Silent degradation is the failure mode that gets discovered from the
    // badges, so the fallback is loud in the log even though it is quiet on
    // the wire. 40 is pino's warn.
    expect(h.log()).toContain('"level":40');
    expect(h.log()).toContain("Pinata");
    expect(h.log()).toContain(METADATA_URI);
  });

  it("502s naming Pinata when the resolver throws and there is nothing to fall back to", async () => {
    const badgeUris = fakeBadgeUris();
    badgeUris.resolve.mockRejectedValueOnce(pinFailure());
    const h = harness({ deps: { badgeUris, metadataUriForEvent: undefined } });
    const released = vi.spyOn(h.claims, "delete");

    const res = await claim(h.app);

    // 502, not 500: an upstream failed, the caller can retry, and an operator
    // reading this needs to know it was the pinning service and not the ledger.
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("PIN_FAILED");
    expect(res.json().error.message).toMatch(/Pinata/);
    expect(h.chain.mint).not.toHaveBeenCalled();

    // THE SLOT IS BACK. A Pinata outage must not cost the attendee their claim
    // on top of their artwork.
    expect(released).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledWith("claim-1");
    expect(h.claims.rows).toHaveLength(0);

    // Which is only worth anything if the retry then works.
    const retried = await claim(h.app);
    expect(retried.statusCode).toBe(201);
    expect(h.chain.mint.mock.calls[0]?.[1]?.uri).toBe(ATTENDEE_METADATA_URI);
    expect(h.claims.rows).toHaveLength(1);
  });

  it("stops waiting on a resolver that never answers, and falls back", async () => {
    const badgeUris = fakeBadgeUris();
    // Pinata accepted the socket and then said nothing. No rejection is ever
    // coming, so only a timeout ends this claim.
    badgeUris.resolve.mockImplementationOnce(() => new Promise<BadgeUri>(() => {}));
    const h = loggingHarness({ deps: { badgeUris, badgeUriTimeoutMs: 25 } });

    const res = await claim(h.app);

    expect(res.statusCode).toBe(201);
    expect(h.chain.mint.mock.calls[0]?.[1]).toEqual({ eventId: EVENT_ID, uri: METADATA_URI });
    expect(h.log()).toContain("25ms");
  });

  it("502s and releases the slot when a hung resolver has no fallback either", async () => {
    const badgeUris = fakeBadgeUris();
    badgeUris.resolve.mockImplementationOnce(() => new Promise<BadgeUri>(() => {}));
    const h = harness({
      deps: { badgeUris, metadataUriForEvent: undefined, badgeUriTimeoutMs: 25 },
    });
    const released = vi.spyOn(h.claims, "delete");

    const res = await claim(h.app);

    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toMatch(/Pinata/);
    expect(released).toHaveBeenCalledTimes(1);
    expect(h.claims.rows).toHaveLength(0);
    expect((await claim(h.app)).statusCode).toBe(201);
  });

  it("keeps the event-wide path exactly as it was when no resolver is wired", async () => {
    const h = harness();

    const res = await claim(h.app);

    expect(res.statusCode).toBe(201);
    expect(h.chain.mint.mock.calls[0]?.[1]).toEqual({ eventId: EVENT_ID, uri: METADATA_URI });
    expect(res.json().pinnedOnDemand).toBeUndefined();
  });

  it("never puts a Pinata error's own text in the response body", async () => {
    const badgeUris = fakeBadgeUris();
    badgeUris.resolve.mockRejectedValueOnce(
      new XrplLayerError("PIN_FAILED", `Pinata rejected Bearer ${FAKE_SEED}-ish-jwt-value`, {
        jwt: "eyJhbGciOiJIUzI1NiJ9.super-secret",
      }),
    );
    const h = harness({ deps: { badgeUris, metadataUriForEvent: undefined } });

    const res = await claim(h.app);

    expect(res.statusCode).toBe(502);
    // The upstream message rides on `cause`, which the response never
    // serialises: a third party's error text is not something to echo at an
    // attendee, and it is exactly where a leaked credential would hide.
    const body = res.payload;
    expect(body).not.toContain("super-secret");
    expect(body).not.toContain(FAKE_SEED);
    expect(body).not.toContain("Bearer");
  });

  it("keeps the upstream reason in the log, where an operator can still read it", async () => {
    const badgeUris = fakeBadgeUris();
    badgeUris.resolve.mockRejectedValueOnce(pinFailure());
    const h = loggingHarness({ deps: { badgeUris, metadataUriForEvent: undefined } });

    const res = await claim(h.app);

    expect(res.statusCode).toBe(502);
    // Not in the body — but "the pin failed" with no reason is a 3am support
    // ticket, so the cause is carried to the sink and scrubbed there.
    expect(res.payload).not.toContain("429 Too Many Requests");
    expect(h.log()).toContain("429 Too Many Requests");
  });
});

// ---------------------------------------------------------------------------
// POST /events/:eventId/claims/:offerId/confirm
// ---------------------------------------------------------------------------

/**
 * A registrations repo just complete enough for the check-in path.
 *
 * The main harness deliberately has none, so every confirm test above exercises
 * the walk-up case. These two cover the other half — which is how the missing
 * `markCheckedIn()` call went unnoticed: with no repo wired, the code that was
 * never written was also never missed.
 */
class CheckInSpy {
  rows: Array<{ id: string; address: string; checkedInAt: Date | null }> = [];
  failFind = false;

  seed(id: string, address: string): void {
    this.rows.push({ id, address, checkedInAt: null });
  }

  async findByAddress(_eventId: number, address: string): Promise<any> {
    if (this.failFind) throw new Error("registrations store is down");
    return this.rows.find((r) => r.address === address) ?? null;
  }
  async markCheckedIn(id: string, at?: Date): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error("no such registration");
    // Idempotent, exactly as the real one is.
    row.checkedInAt ??= at ?? new Date();
  }
  async create(): Promise<any> {
    throw new Error("not used");
  }
  async findById(): Promise<any> {
    return null;
  }
  async listByEvent(): Promise<any[]> {
    return [];
  }
  async countByEvent(): Promise<{ total: number; checkedIn: number }> {
    return { total: this.rows.length, checkedIn: this.rows.filter((r) => r.checkedInAt).length };
  }
}

describe("minting is behind the admin session", () => {
  /**
   * The route was open to the internet. Anyone who could reach the host could
   * mint against any open event, using a fresh address each time to step past
   * the per-address limit, spending 0.2 XRP of locked reserve and up to 1.5 XRP
   * of sponsorship per request until the daily cap stopped them.
   */
  it("401s an unauthenticated mint, and spends nothing doing it", async () => {
    const h = harness({ deps: { requireAdmin: refuseAdmin } });

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
    // Refused before the slot, the mint, the offer and the sponsorship.
    expect(h.claims.rows).toHaveLength(0);
    expect(h.chain.mint).not.toHaveBeenCalled();
    expect(h.chain.createClaimOffer).not.toHaveBeenCalled();
    expect(h.chain.sponsorWallet).not.toHaveBeenCalled();
  });

  it("still lets a signed-in desk through", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE },
    });

    expect(res.statusCode).toBe(201);
    expect(h.chain.mint).toHaveBeenCalledTimes(1);
  });
});

describe("GET /events/:eventId/claims/for/:address", () => {
  /**
   * What the attendee's own page uses now that it may not mint. Public on
   * purpose: a claim offer is destination-locked and already readable from the
   * ledger, so this reveals nothing, and only the destination can accept it —
   * with a key this server has never held.
   */
  it("is readable with no session at all", async () => {
    const h = harness({ deps: { requireAdmin: refuseAdmin } });
    h.claims.rows.push({
      id: "c1",
      eventId: EVENT_ID,
      address: ATTENDEE,
      status: "pending",
      offerId: OFFER_ID,
      nftokenId: NFTOKEN_ID,
      expiresAt: new Date(Date.now() + 600_000),
    } as never);

    const res = await h.app.inject({
      method: "GET",
      url: `/events/${EVENT_ID}/claims/for/${ATTENDEE}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      offerId: OFFER_ID,
      nftokenId: NFTOKEN_ID,
      accept: { TransactionType: "NFTokenAcceptOffer", NFTokenSellOffer: OFFER_ID },
    });
  });

  it("404s before the desk has issued, and mints nothing while saying so", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "GET",
      url: `/events/${EVENT_ID}/claims/for/${ATTENDEE}`,
    });

    // The ordinary state of an attendee standing in a queue.
    expect(res.statusCode).toBe(404);
    expect(h.chain.mint).not.toHaveBeenCalled();
    expect(h.claims.rows).toHaveLength(0);
  });
});

describe("confirming a badge also checks the attendee in", () => {
  it("marks a registered attendee as arrived", async () => {
    const registrations = new CheckInSpy();
    registrations.seed("reg-1", ATTENDEE);
    const h = harness({ deps: { registrations: registrations as any } });

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims/${OFFER_ID}/confirm`,
      payload: { address: ATTENDEE, txHash: ACCEPT_TX },
    });

    expect(res.statusCode).toBe(200);
    expect(h.attendance.rows).toHaveLength(1);
    // The one that was missing: attendance alone left the console saying
    // "not yet" for everybody, forever.
    expect(registrations.rows[0]?.checkedInAt).toBeInstanceOf(Date);
  });

  it("does not invent an arrival for a walk-up", async () => {
    const registrations = new CheckInSpy(); // nobody registered
    const h = harness({ deps: { registrations: registrations as any } });

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims/${OFFER_ID}/confirm`,
      payload: { address: ATTENDEE, txHash: ACCEPT_TX },
    });

    // Turning up without signing up is normal, not an error.
    expect(res.statusCode).toBe(200);
    expect(h.attendance.rows).toHaveLength(1);
    expect(registrations.rows).toHaveLength(0);
  });

  it("still confirms when the check-in itself fails", async () => {
    const registrations = new CheckInSpy();
    registrations.seed("reg-1", ATTENDEE);
    registrations.failFind = true;
    const h = harness({ deps: { registrations: registrations as any } });

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims/${OFFER_ID}/confirm`,
      payload: { address: ATTENDEE, txHash: ACCEPT_TX },
    });

    // The badge is on the ledger and attendance is written by this point. A
    // 500 here would send the desk back to retry a confirm that succeeded.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ attended: true });
    expect(h.attendance.rows).toHaveLength(1);
    expect(registrations.rows[0]?.checkedInAt).toBeNull();
  });
});

describe("POST /events/:eventId/claims/:offerId/confirm", () => {
  it("422s a failed verification and writes nothing", async () => {
    const h = harness();
    h.chain.verifyClaim.mockResolvedValue(notAttendedResult());

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims/${OFFER_ID}/confirm`,
      payload: { address: ATTENDEE, txHash: ACCEPT_TX },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("VERIFICATION_FAILED");
    expect(body.error.details.failedCheck).toBe("submittedByAddress");
    expect(body.error.details.checks.submittedByAddress).toBe(false);
    // A real mismatch carries no retry hint: waiting will not change it.
    expect(body.error.details.notYet).toBeUndefined();
    expect(h.attendance.rows).toHaveLength(0);
  });

  /**
   * THE RACE, and it is not hypothetical: a confirm 422'd at 12:03:07 on
   * testnet and the identical one returned 200 at 12:06:06. Xaman reports the
   * transaction hash the instant it submits; a ledger takes a few seconds more
   * to validate. Both pages used to read that 422 as "the ledger disagrees" —
   * the desk stopped watching and showed a red card, and the attendee's page
   * threw away a correct hash and asked them to find another. Neither could
   * tell the two apart, because the response did not say.
   */
  it("marks a 422 that is only the ledger catching up, so a caller may retry", async () => {
    const h = harness();
    h.chain.verifyClaim.mockResolvedValue({
      attended: false,
      status: "not_attended",
      checks: { ...ALL_CHECKS_PASS, transactionFound: false },
      failedCheck: "transactionFound",
      notYet: true,
      reason: "No transaction on this ledger yet.",
    } as VerifyClaimResult);

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims/${OFFER_ID}/confirm`,
      payload: { address: ATTENDEE, txHash: ACCEPT_TX },
    });

    // Still a 422 and still nothing written — only the reading changes.
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.notYet).toBe(true);
    expect(h.attendance.rows).toHaveLength(0);
  });

  it("writes exactly one record on a successful verification", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims/${OFFER_ID}/confirm`,
      payload: { address: ATTENDEE, txHash: ACCEPT_TX },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ attended: true, alreadyRecorded: false });
    expect(h.attendance.rows).toHaveLength(1);
    expect(h.attendance.rows[0]).toMatchObject({
      eventId: EVENT_ID,
      address: ATTENDEE,
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
      txHash: ACCEPT_TX,
      ledgerIndex: 4_242_000,
    });

    // Verification is against the chain, not against the client's say-so.
    expect(h.chain.verifyClaim).toHaveBeenCalledWith(h.gateway, {
      address: ATTENDEE,
      eventId: EVENT_ID,
      txHash: ACCEPT_TX,
    });
  });

  it("is idempotent when confirmed twice", async () => {
    const h = harness();
    const send = () =>
      h.app.inject({
        method: "POST",
        url: `/events/${EVENT_ID}/claims/${OFFER_ID}/confirm`,
        payload: { address: ATTENDEE, txHash: ACCEPT_TX },
      });

    const first = await send();
    const second = await send();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().alreadyRecorded).toBe(true);
    expect(h.attendance.rows).toHaveLength(1);
  });

  it("400s a transaction hash that is not 64 hex characters", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims/${OFFER_ID}/confirm`,
      payload: { address: ATTENDEE, txHash: "DEADBEEF" },
    });

    expect(res.statusCode).toBe(400);
    expect(h.chain.verifyClaim).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/xaman
// ---------------------------------------------------------------------------

function xamanDelivery(): Record<string, unknown> {
  return {
    meta: { payload_uuidv4: "payload-uuid-1" },
    custom_meta: {
      identifier: `poap-${EVENT_ID}-8685A6D0`,
      blob: { kind: "poap-claim", eventId: EVENT_ID, offerId: OFFER_ID, attendeeAddress: ATTENDEE },
    },
    payloadResponse: {
      payload_uuidv4: "payload-uuid-1",
      signed: true,
      txid: ACCEPT_TX,
      account: ATTENDEE,
    },
  };
}

describe("POST /webhooks/xaman", () => {
  it("verifies against the chain and indexes once, however many times it is delivered", async () => {
    const h = harness();
    const deliver = () =>
      h.app.inject({ method: "POST", url: "/webhooks/xaman", payload: xamanDelivery() });

    const first = await deliver();
    const second = await deliver();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, recorded: true });
    expect(second.json()).toMatchObject({ ok: true, recorded: false, alreadyRecorded: true });
    expect(h.attendance.rows).toHaveLength(1);
    expect(h.chain.verifyClaim).toHaveBeenCalledTimes(2);
  });

  it("acknowledges a rejected signature without writing", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "POST",
      url: "/webhooks/xaman",
      payload: {
        meta: { payload_uuidv4: "payload-uuid-1" },
        payloadResponse: { payload_uuidv4: "payload-uuid-1", signed: false, txid: null },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, recorded: false, reason: "not_signed" });
    expect(h.chain.verifyClaim).not.toHaveBeenCalled();
    expect(h.attendance.rows).toHaveLength(0);
  });

  it("does not index a claim the ledger will not confirm, and does not ask for a retry", async () => {
    const h = harness();
    h.chain.verifyClaim.mockResolvedValue(notAttendedResult());

    const res = await h.app.inject({
      method: "POST",
      url: "/webhooks/xaman",
      payload: xamanDelivery(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ recorded: false, reason: "verification_failed" });
    expect(h.attendance.rows).toHaveLength(0);
  });

  it("400s a body that is not a Xaman delivery at all", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "POST",
      url: "/webhooks/xaman",
      payload: { hello: "world" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_INPUT");
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("GET /events/:eventId/attendance", () => {
  it("pages the local index and never reads the chain", async () => {
    const h = harness();
    for (const address of [ATTENDEE, OTHER]) {
      await h.attendance.insert({
        eventId: EVENT_ID,
        address,
        nftokenId: NFTOKEN_ID,
        txHash: ACCEPT_TX,
        ledgerIndex: 4_242_000,
      });
    }

    const res = await h.app.inject({
      method: "GET",
      url: `/events/${EVENT_ID}/attendance?limit=1&offset=1`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ eventId: EVENT_ID, total: 2, limit: 1, offset: 1 });
    expect(res.json().records).toHaveLength(1);
    expect(res.json().records[0].address).toBe(OTHER);

    expect(h.chain.getRoster).not.toHaveBeenCalled();
    expect(h.chain.verifyClaim).not.toHaveBeenCalled();
    expect(h.gateway.requests).toHaveLength(0);
  });

  it("400s a nonsense limit", async () => {
    const h = harness();
    const res = await h.app.inject({
      method: "GET",
      url: `/events/${EVENT_ID}/attendance?limit=chips`,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /events/:eventId/roster", () => {
  it("reads the chain", async () => {
    const h = harness();
    h.chain.getRoster.mockResolvedValue({
      eventId: EVENT_ID,
      issuer: ISSUER,
      entries: [
        {
          nftokenId: NFTOKEN_ID,
          owner: ATTENDEE,
          isBurned: false,
          taxon: EVENT_ID,
          serial: 1,
          claimed: true,
        },
      ],
      minted: 1,
      claimed: 1,
      burned: 0,
      ownerUnknown: 0,
    });

    const res = await h.app.inject({ method: "GET", url: `/events/${EVENT_ID}/roster?limit=10` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ minted: 1, claimed: 1, burned: 0 });
    expect(h.chain.getRoster).toHaveBeenCalledWith(h.gateway, EVENT_ID, { limit: 10 });
  });

  it("forwards an entry with no owner, and the ownerUnknown count with it", async () => {
    const h = harness();
    h.chain.getRoster.mockResolvedValue({
      eventId: EVENT_ID,
      issuer: ISSUER,
      entries: [
        // The node did not report an owner. `owner` and `claimed` are both
        // absent — unknown, not "the issuer", not "unclaimed".
        { nftokenId: NFTOKEN_ID, isBurned: false, taxon: EVENT_ID, serial: 1 },
        { nftokenId: NFTOKEN_ID, owner: ATTENDEE, isBurned: false, taxon: EVENT_ID, serial: 2, claimed: true },
      ],
      minted: 2,
      claimed: 1,
      burned: 0,
      ownerUnknown: 1,
    });

    const res = await h.app.inject({ method: "GET", url: `/events/${EVENT_ID}/roster` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Reaches the caller. `minted - claimed` would otherwise read the unknown
    // entry as definitely unclaimed.
    expect(body.ownerUnknown).toBe(1);
    expect(body.entries[0].owner).toBeUndefined();
    expect(body.entries[0].claimed).toBeUndefined();
    expect(body.entries[1]).toMatchObject({ owner: ATTENDEE, claimed: true });
  });
});

describe("GET /verify", () => {
  it("returns attended: true for a burned badge, with the per-check breakdown", async () => {
    const h = harness();
    h.chain.verifyClaim.mockResolvedValue(
      attendedResult({
        status: "attended_badge_burned",
        isBurned: true,
        currentOwner: ATTENDEE,
      }),
    );

    const res = await h.app.inject({
      method: "GET",
      url: `/verify?address=${ATTENDEE}&eventId=${EVENT_ID}&txHash=${ACCEPT_TX}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.attended).toBe(true);
    expect(body.status).toBe("attended_badge_burned");
    expect(body.isBurned).toBe(true);
    expect(body.checks).toEqual(ALL_CHECKS_PASS);
    expect(body.nftokenId).toBe(NFTOKEN_ID);
    expect(body.nftokenIdSource).toBe("meta.nftoken_id");
  });

  it("passes `degraded` straight through", async () => {
    const h = harness();
    h.chain.verifyClaim.mockResolvedValue(
      attendedResult({ degraded: true, nftokenIdSource: "affected_nodes", isBurned: false }),
    );

    const res = await h.app.inject({
      method: "GET",
      url: `/verify?address=${ATTENDEE}&eventId=${EVENT_ID}&txHash=${ACCEPT_TX}`,
    });

    expect(res.json()).toMatchObject({
      attended: true,
      degraded: true,
      nftokenIdSource: "affected_nodes",
    });
  });

  it("answers 200 with attended: false — a negative is an answer, not an error", async () => {
    const h = harness();
    h.chain.verifyClaim.mockResolvedValue(notAttendedResult());

    const res = await h.app.inject({
      method: "GET",
      url: `/verify?address=${ATTENDEE}&eventId=${EVENT_ID}&txHash=${ACCEPT_TX}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ attended: false, failedCheck: "submittedByAddress" });
  });

  it("400s a malformed address in the query", async () => {
    const h = harness();
    const res = await h.app.inject({
      method: "GET",
      url: `/verify?address=nope&eventId=${EVENT_ID}&txHash=${ACCEPT_TX}`,
    });
    expect(res.statusCode).toBe(400);
    expect(h.chain.verifyClaim).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Errors and redaction
// ---------------------------------------------------------------------------

describe("error redaction", () => {
  it("redacts whole credential keys and leaves ledger identifiers alone", () => {
    const redacted = redactDetails({
      seed: FAKE_SEED,
      issuerSeed: FAKE_SEED,
      ISSUER_SEED: FAKE_SEED,
      secret: "s3cr3t",
      apiSecret: "s3cr3t",
      xummApiSecret: "s3cr3t",
      jwt: "header.payload.signature",
      PINATA_JWT: "header.payload.signature",
      password: "hunter2",
      authorization: "Bearer abc",
      token: "abc",
      accessToken: "abc",
      refresh_token: "abc",
      nftokenId: NFTOKEN_ID,
      nftokenIdSource: "meta.nftoken_id",
      NFTokenID: NFTOKEN_ID,
      nftoken_id: NFTOKEN_ID,
      offerId: OFFER_ID,
      txHash: ACCEPT_TX,
      address: ATTENDEE,
      eventId: EVENT_ID,
    });

    for (const key of [
      "seed",
      "issuerSeed",
      "ISSUER_SEED",
      "secret",
      "apiSecret",
      "xummApiSecret",
      "jwt",
      "PINATA_JWT",
      "password",
      "authorization",
      "token",
      "accessToken",
      "refresh_token",
    ]) {
      expect(isSensitiveKey(key), `${key} must be treated as sensitive`).toBe(true);
      expect(redacted?.[key], `${key} must be redacted`).toBe("[redacted]");
    }

    for (const key of [
      "nftokenId",
      "nftokenIdSource",
      "NFTokenID",
      "nftoken_id",
      "offerId",
      "txHash",
      "address",
      "eventId",
    ]) {
      expect(isSensitiveKey(key), `${key} must not be treated as sensitive`).toBe(false);
      expect(redacted?.[key], `${key} must survive`).not.toBe("[redacted]");
    }

    expect(redacted?.nftokenId).toBe(NFTOKEN_ID);
    expect(redacted?.nftokenIdSource).toBe("meta.nftoken_id");
  });

  it("recurses into nested objects and arrays", () => {
    const redacted = redactDetails({
      wallets: [{ address: ATTENDEE, seed: FAKE_SEED }],
      nested: { deeper: { apiSecret: "s3cr3t", nftokenId: NFTOKEN_ID } },
    });

    expect(JSON.stringify(redacted)).not.toContain(FAKE_SEED);
    expect(JSON.stringify(redacted)).not.toContain("s3cr3t");
    expect(JSON.stringify(redacted)).toContain(NFTOKEN_ID);
    expect(JSON.stringify(redacted)).toContain(ATTENDEE);
  });

  it("scrubs a seed that was interpolated into a message or a bare value", () => {
    const redacted = redactDetails({ note: `signed with ${FAKE_SEED}`, list: [FAKE_SEED] });
    expect(JSON.stringify(redacted)).not.toContain(FAKE_SEED);
  });

  it("never lets a seed or a jwt out through a route", async () => {
    const h = harness();
    h.chain.getRoster.mockRejectedValue(
      new XrplLayerError("LEDGER_QUERY_FAILED", `nfts_by_issuer failed using ${FAKE_SEED}`, {
        issuerSeed: FAKE_SEED,
        pinataJwt: "header.payload.signature",
        nftokenId: NFTOKEN_ID,
        nested: { apiSecret: "s3cr3t" },
      }),
    );

    const res = await h.app.inject({ method: "GET", url: `/events/${EVENT_ID}/roster` });

    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(FAKE_SEED);
    expect(res.body).not.toContain("header.payload.signature");
    expect(res.body).not.toContain("s3cr3t");

    const body = res.json();
    expect(body.error.code).toBe("LEDGER_QUERY_FAILED");
    expect(body.error.details.issuerSeed).toBe("[redacted]");
    expect(body.error.details.pinataJwt).toBe("[redacted]");
    // The identifier you need to debug it is still there.
    expect(body.error.details.nftokenId).toBe(NFTOKEN_ID);
  });

  it("does not leak internals from an unexpected error", async () => {
    const h = harness();
    h.chain.getRoster.mockRejectedValue(new Error(`kaboom ${FAKE_SEED}`));

    const res = await h.app.inject({ method: "GET", url: `/events/${EVENT_ID}/roster` });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(FAKE_SEED);
    expect(res.json()).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  it("404s an unknown route in the same shape", async () => {
    const h = harness();
    const res = await h.app.inject({ method: "GET", url: "/nope" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// The claim slot — one attendee, one badge, whatever they do to the endpoint
// ---------------------------------------------------------------------------

describe("POST /events/:eventId/claims — the mint guard", () => {
  const claim = (app: FastifyInstance, address = ATTENDEE, headers?: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address },
      ...(headers ? { headers } : {}),
    });

  it("takes the claim slot BEFORE the mint, and persists both ids on it", async () => {
    const h = harness();

    const res = await claim(h.app);

    expect(res.statusCode).toBe(201);
    expect(h.claims.rows).toHaveLength(1);
    expect(h.claims.rows[0]).toMatchObject({
      eventId: EVENT_ID,
      address: ATTENDEE,
      status: "pending",
      nftokenId: NFTOKEN_ID,
      // Durable at claim time. Without it scripts/reap-offers.ts has no way to
      // find the 0.2 XRP this offer is holding.
      offerId: OFFER_ID,
    });
    expect(h.claims.rows[0]?.expiresAt).toBeInstanceOf(Date);
  });

  it("mints ONCE for six sequential claims from one address", async () => {
    const h = harness();

    const responses = [];
    for (let i = 0; i < 6; i += 1) responses.push(await claim(h.app));

    // One mint. One offer. One 0.2 XRP reserve, not six.
    expect(h.chain.mint).toHaveBeenCalledTimes(1);
    expect(h.chain.createClaimOffer).toHaveBeenCalledTimes(1);
    expect(h.claims.rows).toHaveLength(1);

    expect(responses[0]?.statusCode).toBe(201);
    for (const res of responses.slice(1)) {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ offerId: OFFER_ID, reusedExistingOffer: true });
      // A retry is still handed something it can sign.
      expect(res.json().accept).toEqual({
        TransactionType: "NFTokenAcceptOffer",
        Account: ATTENDEE,
        NFTokenSellOffer: OFFER_ID,
      });
    }
  });

  it("mints ONCE for five concurrent claims from one address", async () => {
    const h = harness();

    const responses = await Promise.all([
      claim(h.app),
      claim(h.app),
      claim(h.app),
      claim(h.app),
      claim(h.app),
    ]);

    expect(h.chain.mint).toHaveBeenCalledTimes(1);
    expect(h.chain.createClaimOffer).toHaveBeenCalledTimes(1);
    expect(h.claims.rows).toHaveLength(1);

    const codes = responses.map((res) => res.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    // Every loser is either handed the one offer that exists (200) or told to
    // come back in a moment (409). Never a second badge, never a 500.
    expect(codes.filter((c) => c === 200 || c === 409)).toHaveLength(4);

    for (const res of responses) {
      if (res.statusCode === 200) expect(res.json().offerId).toBe(OFFER_ID);
      if (res.statusCode === 409) expect(res.json().error.code).toBe("DUPLICATE_CLAIM");
    }
  });

  it("still mints for a different address", async () => {
    const h = harness();

    expect((await claim(h.app, ATTENDEE)).statusCode).toBe(201);
    expect((await claim(h.app, OTHER)).statusCode).toBe(201);

    expect(h.chain.mint).toHaveBeenCalledTimes(2);
    expect(h.claims.rows).toHaveLength(2);
  });

  it("409s while another request holds the slot but has no offer yet", async () => {
    const h = harness();
    // The state a concurrent claim is in between open() and the offer.
    await h.claims.open({ eventId: EVENT_ID, address: ATTENDEE });

    const res = await claim(h.app);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DUPLICATE_CLAIM");
    expect(res.json().error.message).toMatch(/already in progress/i);
    // There is nothing to hand back, and a second badge is not the answer.
    expect(h.chain.mint).not.toHaveBeenCalled();
    expect(h.claims.rows).toHaveLength(1);
  });

  it("409s an address whose claim slot is already spent", async () => {
    const h = harness();
    await h.claims.open({ eventId: EVENT_ID, address: ATTENDEE });
    await h.claims.markClaimed("claim-1");

    const res = await claim(h.app);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DUPLICATE_CLAIM");
    expect(h.chain.mint).not.toHaveBeenCalled();
  });

  it("does not reopen a slot the reaper closed out", async () => {
    const h = harness();
    await h.claims.open({ eventId: EVENT_ID, address: ATTENDEE });
    await h.claims.markAbandoned("claim-1");

    const res = await claim(h.app);

    expect(res.statusCode).toBe(409);
    expect(h.chain.mint).not.toHaveBeenCalled();
    expect(h.chain.createClaimOffer).not.toHaveBeenCalled();
  });

  it("releases the slot when the mint throws, so the attendee is not locked out", async () => {
    const h = harness();
    h.chain.mint.mockRejectedValueOnce(
      new XrplLayerError("TX_FAILED", "tefPAST_SEQ", { engineResult: "tefPAST_SEQ" }),
    );

    const failed = await claim(h.app);
    expect(failed.statusCode).toBe(502);
    // The slot is gone: a transient failure must not cost someone their badge.
    expect(h.claims.rows).toHaveLength(0);

    const retried = await claim(h.app);
    expect(retried.statusCode).toBe(201);
    expect(h.claims.rows).toHaveLength(1);
    expect(h.chain.mint).toHaveBeenCalledTimes(2);
  });

  it("releases the slot when the OFFER throws, and names the orphaned badge", async () => {
    const h = loggingHarness();
    h.chain.createClaimOffer.mockRejectedValueOnce(
      new XrplLayerError("TX_FAILED", "tecINSUFFICIENT_RESERVE"),
    );

    const failed = await claim(h.app);

    expect(failed.statusCode).toBe(502);
    expect(h.claims.rows).toHaveLength(0);
    // The badge was minted and nothing is offering it. An operator has to be
    // able to find it.
    expect(h.log()).toContain(NFTOKEN_ID);
    expect(h.log()).toContain("orphaned");

    expect((await claim(h.app)).statusCode).toBe(201);
  });

  it("releases the slot when sponsorship is refused", async () => {
    const h = harness({
      config: { sponsor: { enabled: true, amountXrp: "1.5", dailyCapXrp: "50" } },
    });
    h.chain.accountExists.mockResolvedValue(false);
    h.chain.getAccountBalanceXrp.mockResolvedValue("0");
    h.chain.sponsorWallet.mockRejectedValueOnce(
      new XrplLayerError("SPONSORSHIP_DENIED", "daily cap reached", { kind: "daily_cap" }),
    );

    expect((await claim(h.app)).statusCode).toBe(429);
    expect(h.claims.rows).toHaveLength(0);
  });

  it("releases the slot when there is no metadata URI to mint", async () => {
    const h = harness({ deps: { metadataUriForEvent: () => undefined } });

    expect((await claim(h.app)).statusCode).toBe(400);
    expect(h.claims.rows).toHaveLength(0);
    expect(h.chain.mint).not.toHaveBeenCalled();
  });

  it("marks the slot claimed once the chain confirms", async () => {
    const h = harness();
    await claim(h.app);

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims/${OFFER_ID}/confirm`,
      payload: { address: ATTENDEE, txHash: ACCEPT_TX },
    });

    expect(res.statusCode).toBe(200);
    expect(h.claims.rows[0]?.status).toBe("claimed");
    // A claimed slot is no longer reapable: its 0.2 XRP was released by the
    // accept, not by a cancellation.
    expect(await h.claims.listExpired(new Date(Date.now() + 3_600_000))).toHaveLength(0);
  });

  it("marks the slot claimed from the webhook path too", async () => {
    const h = harness();
    await claim(h.app);

    await h.app.inject({ method: "POST", url: "/webhooks/xaman", payload: xamanDelivery() });

    expect(h.claims.rows[0]?.status).toBe("claimed");
  });

  it("leaves an unsigned claim reapable once it expires", async () => {
    const h = harness();
    await claim(h.app);

    const afterExpiry = new Date(Date.now() + 3_600_000);
    const reapable = await h.claims.listExpired(afterExpiry);

    expect(reapable).toHaveLength(1);
    expect(reapable[0]?.offerId).toBe(OFFER_ID);
  });
});

// ---------------------------------------------------------------------------
// Attendance rows are never hollow
// ---------------------------------------------------------------------------

describe("attendance rows require a real ledger index", () => {
  const confirm = (app: FastifyInstance) =>
    app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims/${OFFER_ID}/confirm`,
      payload: { address: ATTENDEE, txHash: ACCEPT_TX },
    });

  it("502s rather than writing ledgerIndex 0 when the tx response has none", async () => {
    const h = harness();
    h.chain.verifyClaim.mockResolvedValue(attendedResult({ ledgerIndex: undefined }));

    const res = await confirm(h.app);

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("LEDGER_QUERY_FAILED");
    // `ledger_index bigint NOT NULL` deserves a real value or no row at all.
    expect(h.attendance.rows).toHaveLength(0);
  });

  it("502s on a zero ledger index too", async () => {
    const h = harness();
    h.chain.verifyClaim.mockResolvedValue(attendedResult({ ledgerIndex: 0 }));

    const res = await confirm(h.app);

    expect(res.statusCode).toBe(502);
    expect(h.attendance.rows).toHaveLength(0);
  });

  it("still refuses when the NFTokenID is missing", async () => {
    const h = harness();
    h.chain.verifyClaim.mockResolvedValue(attendedResult({ nftokenId: undefined }));

    const res = await confirm(h.app);

    expect(res.statusCode).toBe(502);
    expect(h.attendance.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The stored offer id comes off the chain, never off the caller
// ---------------------------------------------------------------------------

const FORGED_OFFER_ID = `0BAD${"0".repeat(60)}`;

describe("offer id provenance", () => {
  it("ignores a forged offerId in an unauthenticated webhook body", async () => {
    const h = harness();
    const delivery = xamanDelivery();
    (delivery.custom_meta as any).blob.offerId = FORGED_OFFER_ID;

    const res = await h.app.inject({
      method: "POST",
      url: "/webhooks/xaman",
      payload: delivery,
    });

    expect(res.statusCode).toBe(200);
    expect(h.attendance.rows).toHaveLength(1);
    // The offer the accept transaction actually consumed, per verifyClaim().
    expect(h.attendance.rows[0]?.offerId).toBe(OFFER_ID);
    expect(JSON.stringify(h.attendance.rows)).not.toContain(FORGED_OFFER_ID);
  });

  it("ignores a forged offerId in the confirm path", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims/${FORGED_OFFER_ID}/confirm`,
      payload: { address: ATTENDEE, txHash: ACCEPT_TX },
    });

    expect(res.statusCode).toBe(200);
    expect(h.attendance.rows[0]?.offerId).toBe(OFFER_ID);
  });

  it("falls back to the id we recorded ourselves, never the caller's", async () => {
    const h = harness();
    // The chain could not name the offer this time.
    h.chain.verifyClaim.mockResolvedValue(attendedResult({ sellOfferId: undefined }));
    // ...but we wrote it down when we created it.
    await h.claims.open({ eventId: EVENT_ID, address: ATTENDEE });
    await h.claims.attach("claim-1", { offerId: OFFER_ID });

    await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims/${FORGED_OFFER_ID}/confirm`,
      payload: { address: ATTENDEE, txHash: ACCEPT_TX },
    });

    expect(h.attendance.rows[0]?.offerId).toBe(OFFER_ID);
  });

  it("stores null rather than a caller-supplied id when nothing trustworthy exists", async () => {
    const h = harness();
    h.chain.verifyClaim.mockResolvedValue(attendedResult({ sellOfferId: undefined }));

    await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims/${FORGED_OFFER_ID}/confirm`,
      payload: { address: ATTENDEE, txHash: ACCEPT_TX },
    });

    expect(h.attendance.rows[0]?.offerId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rate limiting: which bucket, and whose IP
// ---------------------------------------------------------------------------

describe("claim rate limiting", () => {
  const from = (ip: string, address: string) => ({
    method: "POST" as const,
    url: `/events/${EVENT_ID}/claims`,
    payload: { address },
    headers: { "x-forwarded-for": ip },
  });

  it("defaults to distrusting X-Forwarded-For, so one socket is one bucket", async () => {
    const h = harness({
      deps: { rateLimit: { enabled: true, claim: { max: 1, timeWindow: "1 minute" } } },
    });

    // Two different claimed source addresses, one real socket.
    const first = await h.app.inject(from("203.0.113.1", ATTENDEE));
    const second = await h.app.inject(from("203.0.113.2", OTHER));

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(429);
    expect(h.deps.trustProxy ?? false).toBe(false);
  });

  it("gives each real client its own bucket once a proxy is trusted", async () => {
    const h = harness({
      deps: {
        trustProxy: true,
        rateLimit: { enabled: true, claim: { max: 1, timeWindow: "1 minute" } },
      },
    });

    const first = await h.app.inject(from("203.0.113.1", ATTENDEE));
    const second = await h.app.inject(from("203.0.113.2", OTHER));

    // The whole point: two attendees behind one ingress no longer collide.
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    // ...and the IP bucket still bites when it is genuinely the same client.
    const third = await h.app.inject(from("203.0.113.1", OTHER));
    expect(third.statusCode).toBe(429);
  });

  it("limits one address however many source IPs it arrives from", async () => {
    const h = harness({
      deps: {
        trustProxy: true,
        rateLimit: { enabled: true, claim: { max: 2, timeWindow: "1 minute" } },
      },
    });

    const first = await h.app.inject(from("203.0.113.1", ATTENDEE));
    const second = await h.app.inject(from("203.0.113.2", ATTENDEE));
    const third = await h.app.inject(from("203.0.113.3", ATTENDEE));

    expect(first.statusCode).toBe(201);
    // Second is the idempotent retry, still under both buckets.
    expect(second.statusCode).toBe(200);
    // Third crosses the address bucket even though its IP bucket is empty.
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("RATE_LIMITED");
    expect(third.headers["retry-after"]).toBeDefined();
  });

  it("parses TRUST_PROXY conservatively", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("0")).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("1")).toBe(true);
    // A hop count would be fail-closed in fastify, so it is a list or nothing.
    expect(parseTrustProxy("10.0.0.0/8,127.0.0.1")).toBe("10.0.0.0/8,127.0.0.1");
  });
});

// ---------------------------------------------------------------------------
// The log sink is an exit too
// ---------------------------------------------------------------------------

describe("log redaction", () => {
  it("keeps a seed in err.details out of the log line, not just the response", async () => {
    const h = loggingHarness();
    h.chain.getRoster.mockRejectedValue(
      new XrplLayerError("LEDGER_QUERY_FAILED", `nfts_by_issuer failed using ${FAKE_SEED}`, {
        issuerSeed: FAKE_SEED,
      }),
    );

    const res = await h.app.inject({ method: "GET", url: `/events/${EVENT_ID}/roster` });

    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(FAKE_SEED);
    // The half that used to leak.
    expect(h.log()).not.toContain(FAKE_SEED);
    expect(h.log()).toContain("LEDGER_QUERY_FAILED");
  });

  it("keeps a seed nested inside err.details out of the log line", async () => {
    const h = loggingHarness();
    h.chain.getRoster.mockRejectedValue(
      new XrplLayerError("LEDGER_QUERY_FAILED", "boom", {
        gateway: { wallet: { seed: FAKE_SEED } },
        nftokenId: NFTOKEN_ID,
      }),
    );

    await h.app.inject({ method: "GET", url: `/events/${EVENT_ID}/roster` });

    expect(h.log()).not.toContain(FAKE_SEED);
    // Still useful. Redaction that eats the identifiers gets turned off.
    expect(h.log()).toContain(NFTOKEN_ID);
  });

  it("keeps a seed in an array element out of the log line", async () => {
    const h = loggingHarness();
    h.chain.getRoster.mockRejectedValue(
      new XrplLayerError("LEDGER_QUERY_FAILED", "boom", {
        wallets: [{ address: ATTENDEE, seed: FAKE_SEED }],
      }),
    );

    await h.app.inject({ method: "GET", url: `/events/${EVENT_ID}/roster` });

    expect(h.log()).not.toContain(FAKE_SEED);
    expect(h.log()).toContain(ATTENDEE);
  });

  it("follows an Error.cause chain instead of letting pino print it", async () => {
    const h = loggingHarness();
    const root = new Error(`signed with ${FAKE_SEED}`);
    const middle = new XrplLayerError("CONNECTION_FAILED", "submit failed", {
      issuerSeed: FAKE_SEED,
    });
    (middle as { cause?: unknown }).cause = root;
    const outer = new Error("could not read the roster", { cause: middle });
    h.chain.getRoster.mockRejectedValue(outer);

    const res = await h.app.inject({ method: "GET", url: `/events/${EVENT_ID}/roster` });

    expect(res.statusCode).toBe(500);
    expect(h.log()).not.toContain(FAKE_SEED);
    // The chain is still there to debug with — just scrubbed.
    expect(h.log()).toContain("could not read the roster");
    expect(h.log()).toContain("submit failed");
  });

  it("censors a seed that never went near an Error", async () => {
    const h = loggingHarness();

    // The shape the invariant was written for: XrplConnection holds a Wallet,
    // and Object.keys(wallet) includes `seed`.
    h.app.log.info(
      {
        gateway: { network: "testnet", wallet: { seed: FAKE_SEED } },
        wallets: [{ seed: FAKE_SEED }],
        issuerSeed: FAKE_SEED,
        nftokenId: NFTOKEN_ID,
      },
      "connected",
    );

    expect(h.log()).not.toContain(FAKE_SEED);
    expect(h.log()).toContain("[redacted]");
    expect(h.log()).toContain(NFTOKEN_ID);
  });

  it("serialises an error to a fixed set of fields, dropping anything else", () => {
    const err = new XrplLayerError("TX_FAILED", "nope", { issuerSeed: FAKE_SEED });
    // A future error class that hangs a wallet off itself must not leak by
    // virtue of pino emitting every own enumerable property.
    (err as unknown as Record<string, unknown>).wallet = { seed: FAKE_SEED };

    const serialized = serializeLoggedError(err);

    expect(serialized.wallet).toBeUndefined();
    expect(serialized.type).toBe("XrplLayerError");
    expect(serialized.code).toBe("TX_FAILED");
    expect((serialized.details as Record<string, unknown>).issuerSeed).toBe("[redacted]");
    expect(JSON.stringify(serialized)).not.toContain(FAKE_SEED);
  });

  it("survives a non-Error in the err field", () => {
    expect(JSON.stringify(serializeLoggedError(`oops ${FAKE_SEED}`))).not.toContain(FAKE_SEED);
    expect(JSON.stringify(serializeLoggedError({ seed: FAKE_SEED }))).not.toContain(FAKE_SEED);
    expect(serializeLoggedError(undefined).type).toBe("undefined");
  });

  it("does not print the issuer seed on a normal request either", async () => {
    const h = loggingHarness();

    await h.app.inject({
      method: "POST",
      url: `/events/${EVENT_ID}/claims`,
      payload: { address: ATTENDEE },
    });

    expect(h.log()).not.toContain(FAKE_SEED);
    expect(h.lines.length).toBeGreaterThan(0);
  });
});
