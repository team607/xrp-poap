/**
 * The TESTNET-ONLY demo harness, tested the way the rest of the HTTP surface is:
 * fastify inject against hand-made deps, a MockGateway that throws on any use it
 * was not primed for, and no network.
 *
 * Most of what is asserted here is not behaviour, it is REFUSAL. These routes
 * generate wallets, take faucet money and sign transactions, so the four guards
 * matter more than the happy path:
 *
 *   1. absent entirely unless the composition root turned them on   -> 404
 *   2. enabled + mainnet is a startup error, never a silent skip    -> throws
 *   3. re-checked per request, so a mutated config cannot open them -> 403
 *   4. the attendee seed cannot reach a response or a log line
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "xrpl";
import { describe, expect, it, vi } from "vitest";
import { MockGateway } from "../../test/helpers/mock-gateway.js";
import type { AppConfig } from "../config.js";
import { AccountNotFoundError, ConfigError, SponsorshipDeniedError } from "../errors.js";
import {
  MAX_TAXON,
  type AttendanceRecord,
  type AttendanceRepository,
  type ClaimRecord,
  type ClaimRepository,
  type EventId,
  type SponsorLedger,
  type SponsorReservation,
  type SponsorReserveInput,
} from "../types.js";
import {
  BASE_RESERVE_XRP,
  DEMO_EVENT_ID_BASE,
  DemoState,
  MAX_DEMO_WALLETS,
  OWNER_RESERVE_PER_OBJECT_XRP,
  assertDemoAllowed,
  badgeReadyReserveXrp,
  parseDemoEnabled,
  reserveShortfallXrp,
  type DemoChainOps,
  type DemoOptions,
} from "./demo-state.js";
import { buildLoggerOptions, type ApiDeps, type ChainOps } from "./deps.js";
import { buildServer } from "./server.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = "rwukQtEt5yj9QGTBSoLWuBvVpPh5nNPpN4";
const NFTOKEN_ID = "000800008685A6D01DEDD0C4365B0928256424853B9842F30A379442FF969F9D";
const OFFER_ID = "8685A6D01DEDD0C4365B0928256424853B9842F30A379442FF969F9DD0D3AABC";
const ACCEPT_TX = "B4068EC978F85028EFF92C1D9D48C249A5243E31EE517344378D33413E25EEBD";
const BURN_TX = "C31F96F645E7BDFDE9D28B2612A8C9442C4CB2DA3B05A5F8EA32F2A1BE2F32B7";

const ISSUER_BALANCE = "999.99";

/**
 * A directory that is guaranteed not to exist, so the 503 branch is
 * deterministic for all four pages. Pointing at the real src/api/public would
 * make these tests pass or fail depending on which UI files happen to have been
 * written yet, which is exactly the coupling the 503 exists to avoid.
 */
const MISSING_DIR = join(tmpdir(), "xrpl-demo-ui-that-was-never-built");

/** The four pages, and the repo-relative file each 503 has to name. */
const DEMO_PAGES = [
  ["/demo", "demo-index.html"],
  ["/demo/walkthrough", "demo.html"],
  ["/demo/attendee", "attendee.html"],
  ["/demo/volunteer", "volunteer.html"],
] as const;

/**
 * EVERY route this harness registers.
 *
 * One list, used by both the "absent unless enabled" and the "403 on mainnet"
 * sweeps, so a route added without a guard cannot slip through by being left
 * out of a copy of the list. Both guards run before body validation, so a
 * bodyless POST is enough to reach them.
 */
const DEMO_ROUTES = [
  ["GET", "/demo"],
  ["GET", "/demo/walkthrough"],
  ["GET", "/demo/attendee"],
  ["GET", "/demo/volunteer"],
  ["GET", "/demo/state"],
  ["POST", "/demo/attendee"],
  ["POST", "/demo/accept"],
  ["POST", "/demo/burn"],
  ["POST", "/demo/reset"],
  ["POST", "/demo/wallet"],
  ["GET", `/demo/wallet/${ISSUER}/status`],
  ["POST", `/demo/wallet/${ISSUER}/accept`],
  ["GET", `/demo/lookup?address=${ISSUER}`],
  ["POST", "/demo/sponsor"],
] as const;

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    endpoint: "wss://clio.altnet.rippletest.net:51233",
    fallbackEndpoints: [],
    network: "testnet",
    issuerAddress: ISSUER,
    issuerSeed: "sEdV6Xn3bRq9J2wY4tK8mZpL1cH7dQa",
    sponsor: { enabled: true, amountXrp: "1.5", dailyCapXrp: "50" },
    pinata: { gateway: "https://gateway.pinata.cloud" },
    xumm: {},
    demoEnabled: false,
    api: { port: 0, host: "127.0.0.1", trustProxy: false },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fakes — only what the demo routes actually touch
// ---------------------------------------------------------------------------

class FakeClaimRepository implements ClaimRepository {
  readonly rows: ClaimRecord[] = [];
  private seq = 0;

  async open(input: {
    eventId: EventId;
    address: string;
    expiresAt?: Date;
  }): Promise<ClaimRecord | null> {
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
    patch: { nftokenId?: string; offerId?: string },
  ): Promise<void> {
    const row = await this.open({ eventId, address });
    if (row) await this.attach(row.id, patch);
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

class FakeSponsorLedger implements SponsorLedger {
  async hasSponsored(_eventId: EventId, _address: string): Promise<boolean> {
    return false;
  }
  async sponsoredTodayXrp(): Promise<string> {
    return "0";
  }
  async reserve(_input: SponsorReserveInput): Promise<SponsorReservation | null> {
    return null;
  }
  async confirm(_reservationId: string, _txHash: string): Promise<void> {}
  async release(_reservationId: string): Promise<void> {}
}

/**
 * The real ledger operations, wired to explode. The demo must reach the chain
 * only through its own injected ops; anything that leaks into ChainOps fails
 * loudly rather than passing quietly.
 */
function unusedChainOps(): ChainOps {
  const unused =
    (name: string) =>
    async (): Promise<never> => {
      throw new Error(`ChainOps.${name} must not be called by the demo routes`);
    };
  return {
    mint: unused("mint"),
    createClaimOffer: unused("createClaimOffer"),
    accountExists: unused("accountExists"),
    sponsorWallet: unused("sponsorWallet"),
    verifyClaim: unused("verifyClaim"),
    getRoster: unused("getRoster"),
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  deps: ApiDeps;
  state: DemoState;
  ops: {
    fundWallet: ReturnType<typeof vi.fn<DemoChainOps["fundWallet"]>>;
    getAccountBalanceXrp: ReturnType<typeof vi.fn<DemoChainOps["getAccountBalanceXrp"]>>;
    acceptOfferAs: ReturnType<typeof vi.fn<DemoChainOps["acceptOfferAs"]>>;
    burn: ReturnType<typeof vi.fn<DemoChainOps["burn"]>>;
  };
  claims: FakeClaimRepository;
  attendance: FakeAttendanceRepository;
  /** Addresses the fake ledger knows about. Absent means "not activated". */
  balances: Map<string, string>;
  lines: string[];
  log(): string;
}

function makeDeps(
  options: {
    config?: Partial<AppConfig>;
    /** false leaves ApiDeps.demo undefined, i.e. DEMO_ENABLED was not set. */
    demo?: boolean;
    demoOverrides?: Partial<DemoOptions>;
    /**
     * Only the ChainOps a test needs. Everything else stays wired to explode,
     * so a demo route that reaches for the real ledger by accident fails loudly.
     */
    chain?: Partial<ChainOps>;
  } = {},
): Harness {
  const state = new DemoState();
  const claims = new FakeClaimRepository();
  const attendance = new FakeAttendanceRepository();
  const balances = new Map<string, string>([[ISSUER, ISSUER_BALANCE]]);
  const lines: string[] = [];

  const ops = {
    fundWallet: vi.fn<DemoChainOps["fundWallet"]>(async () => {
      const wallet = Wallet.generate();
      balances.set(wallet.classicAddress, "100");
      return { wallet, balanceXrp: "100" };
    }),
    getAccountBalanceXrp: vi.fn<DemoChainOps["getAccountBalanceXrp"]>(async (_gateway, address) => {
      const known = balances.get(address);
      if (known === undefined) throw new AccountNotFoundError(address);
      return known;
    }),
    acceptOfferAs: vi.fn<DemoChainOps["acceptOfferAs"]>(async () => ({
      txHash: ACCEPT_TX,
      ledgerIndex: 4_242_000,
    })),
    burn: vi.fn<DemoChainOps["burn"]>(async (_gateway, params) => ({
      nftokenId: params.nftokenId,
      txHash: BURN_TX,
      ledgerIndex: 4_242_001,
      fee: "12",
    })),
  };

  const demo: DemoOptions = {
    enabled: true,
    ops,
    state,
    htmlDir: MISSING_DIR,
    ...options.demoOverrides,
  };

  const deps: ApiDeps = {
    config: testConfig(options.config),
    // Nothing is queued on it: a demo route that reaches for the ledger
    // directly fails the test instead of quietly passing.
    gateway: new MockGateway({ issuerAddress: ISSUER }),
    attendance,
    claims,
    sponsorLedger: new FakeSponsorLedger(),
    chain: { ...unusedChainOps(), ...options.chain },
    rateLimit: { enabled: false },
    // The real logger configuration from buildDeps(), pointed at an array, so
    // what is asserted about the log sink is the configuration that ships.
    logger: {
      ...buildLoggerOptions("trace"),
      stream: {
        write(line: string) {
          lines.push(line);
        },
      },
    },
    ...(options.demo === false ? {} : { demo }),
  };

  return { deps, state, ops, claims, attendance, balances, lines, log: () => lines.join("") };
}

function harness(options: Parameters<typeof makeDeps>[0] = {}) {
  const h = makeDeps(options);
  return { ...h, app: buildServer(h.deps) };
}

// ---------------------------------------------------------------------------
// GUARD 1 — the routes do not exist unless they were turned on
// ---------------------------------------------------------------------------

describe("demo routes are absent unless enabled", () => {
  it("404s every demo path when DEMO_ENABLED was not set", async () => {
    const h = harness({ demo: false });

    for (const [method, url] of DEMO_ROUTES) {
      const res = await h.app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json().error.code, `${method} ${url}`).toBe("NOT_FOUND");
    }

    // Not disabled-but-present: nothing was constructed at all.
    expect(h.ops.fundWallet).not.toHaveBeenCalled();
    expect(h.log()).not.toContain("DEMO ROUTES ARE LIVE");
  });

  it("leaves the real API untouched when the demo is off", async () => {
    const h = harness({ demo: false });
    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("reads DEMO_ENABLED conservatively, and refuses to guess", () => {
    expect(parseDemoEnabled(undefined)).toBe(false);
    expect(parseDemoEnabled("")).toBe(false);
    expect(parseDemoEnabled("  ")).toBe(false);
    expect(parseDemoEnabled("false")).toBe(false);
    expect(parseDemoEnabled("0")).toBe(false);
    expect(parseDemoEnabled("off")).toBe(false);
    expect(parseDemoEnabled("true")).toBe(true);
    expect(parseDemoEnabled("1")).toBe(true);
    expect(parseDemoEnabled("YES")).toBe(true);
    // Neither "on" nor a silent "off": an operator's belief and the process's
    // behaviour must not be allowed to diverge quietly.
    expect(() => parseDemoEnabled("maybe")).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// GUARD 2 — enabled + mainnet is a startup error
// ---------------------------------------------------------------------------

describe("the demo refuses to exist on mainnet", () => {
  it("throws a ConfigError from buildServer rather than skipping quietly", () => {
    const { deps } = makeDeps({ config: { network: "mainnet" } });

    expect(() => buildServer(deps)).toThrow(ConfigError);
    expect(() => buildServer(deps)).toThrow(/DEMO_ENABLED/);
    expect(() => buildServer(deps)).toThrow(/mainnet/);
  });

  it("names the conflict in the error, not just the fact of it", () => {
    try {
      assertDemoAllowed({ network: "mainnet", endpoint: "wss://xrplcluster.com" });
      expect.unreachable("assertDemoAllowed must throw on mainnet");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const details = (err as ConfigError).details;
      expect(details?.network).toBe("mainnet");
      expect(details?.endpoint).toBe("wss://xrplcluster.com");
    }
  });

  it("allows testnet and devnet", () => {
    expect(() => assertDemoAllowed({ network: "testnet" })).not.toThrow();
    expect(() => assertDemoAllowed({ network: "devnet" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// GUARD 3 — re-checked per request
// ---------------------------------------------------------------------------

describe("the network is re-checked on every demo request", () => {
  it("403s once the config says mainnet, even though it said testnet at boot", async () => {
    const h = harness();

    // Built clean, so the routes exist...
    expect((await h.app.inject({ method: "GET", url: "/demo/state" })).statusCode).toBe(200);

    // ...and then something mutates the live config object.
    h.deps.config.network = "mainnet";

    for (const [method, url] of DEMO_ROUTES) {
      const res = await h.app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code, `${method} ${url}`).toBe("NETWORK_GUARD");
    }

    // Nothing was signed and no faucet was touched on the way to the refusal.
    expect(h.ops.fundWallet).not.toHaveBeenCalled();
    expect(h.ops.acceptOfferAs).not.toHaveBeenCalled();
    expect(h.ops.burn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GUARD 4 — the seed
// ---------------------------------------------------------------------------

describe("the attendee seed never leaves the process", () => {
  it("is absent from /demo/state, however full the state is", async () => {
    const h = harness();
    const wallet = Wallet.generate();
    const seed = wallet.seed ?? "";
    expect(seed.length).toBeGreaterThan(20);

    h.ops.fundWallet.mockResolvedValue({ wallet, balanceXrp: "100" });
    h.balances.set(wallet.classicAddress, "100");

    await h.app.inject({ method: "POST", url: "/demo/attendee" });
    // Every field the state can hold, populated, so there is maximum surface.
    await h.claims.seed(h.state.eventId, wallet.classicAddress, {
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
    });
    await h.app.inject({ method: "POST", url: "/demo/accept" });
    await h.app.inject({ method: "POST", url: "/demo/burn" });

    const created = await h.app.inject({ method: "POST", url: "/demo/attendee" });
    const state = await h.app.inject({ method: "GET", url: "/demo/state" });

    expect(created.body).not.toContain(seed);
    expect(state.statusCode).toBe(200);
    expect(state.body).not.toContain(seed);
    // The address is public and must survive; only the key is gone.
    expect(created.body).toContain(wallet.classicAddress);
    // The log sink is the other exit.
    expect(h.log()).not.toContain(seed);
  });

  it("is unreachable through JSON.stringify of the state object itself", () => {
    const wallet = Wallet.generate();
    const seed = wallet.seed ?? "";
    expect(seed.length).toBeGreaterThan(20);

    const state = new DemoState();
    state.setAttendee(wallet, { funded: true });
    state.observeBadge({ nftokenId: NFTOKEN_ID, offerId: OFFER_ID });
    state.markAccepted(ACCEPT_TX);

    expect(JSON.stringify(state)).not.toContain(seed);
    expect(JSON.stringify(state.view())).not.toContain(seed);
    expect(JSON.stringify({ state })).not.toContain(seed);
    expect(JSON.stringify({ ...state })).not.toContain(seed);
    expect(JSON.stringify(Object.keys(state))).not.toContain("seed");
    // ...and the disclosure is still useful.
    expect(JSON.stringify(state)).toContain(wallet.classicAddress);
    expect(JSON.stringify(state)).toContain(NFTOKEN_ID);

    // The wallet is reachable for signing, and only that way.
    expect(state.signingWallet()?.seed).toBe(seed);
  });

  it("logs one loud line when the routes go live", () => {
    const h = harness();
    expect(h.log()).toContain("DEMO ROUTES ARE LIVE");
    expect(h.log()).toContain("Testnet only");
  });
});

// ---------------------------------------------------------------------------
// The pages
//
// Four of them now, owned by nobody here: they are read off disk and served
// as-is. A page that has not been written yet is a 503 naming the file, never
// a crash and never a boot failure — that is what lets the UI half and the API
// half be built independently.
// ---------------------------------------------------------------------------

describe("the demo pages", () => {
  it("503s with an operator message when a page has not been built yet", async () => {
    const h = harness();

    for (const [url, file] of DEMO_PAGES) {
      const res = await h.app.inject({ method: "GET", url });

      expect(res.statusCode, url).toBe(503);
      // Named individually: "the demo UI is missing" is useless when there are
      // four of them and three are fine.
      expect(res.json().error.message, url).toContain(`src/api/public/${file}`);
      expect(res.json().error.message, url).toMatch(/has not been built yet/i);
    }

    // The rest of the harness still works, which is the point of not crashing.
    expect((await h.app.inject({ method: "GET", url: "/demo/state" })).statusCode).toBe(200);
  });

  it("serves each page as text/html when its file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xrpl-demo-ui-"));
    for (const [, file] of DEMO_PAGES) {
      writeFileSync(join(dir, file), `<h1>${file}</h1>`, "utf8");
    }

    try {
      const h = harness({ demoOverrides: { htmlDir: dir } });

      for (const [url, file] of DEMO_PAGES) {
        const res = await h.app.inject({ method: "GET", url });

        expect(res.statusCode, url).toBe(200);
        expect(res.headers["content-type"], url).toMatch(/text\/html/);
        expect(res.body, url).toContain(file);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still honours the walkthrough's own path override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xrpl-demo-ui-"));
    const htmlPath = join(dir, "somewhere-else.html");
    writeFileSync(htmlPath, "<h1>claim your badge</h1>", "utf8");

    try {
      const h = harness({ demoOverrides: { htmlPath } });
      const res = await h.app.inject({ method: "GET", url: "/demo/walkthrough" });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.body).toContain("claim your badge");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes GET and POST /demo/attendee independently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xrpl-demo-ui-"));
    writeFileSync(join(dir, "attendee.html"), "<h1>your badge</h1>", "utf8");

    try {
      const h = harness({ demoOverrides: { htmlDir: dir } });

      // The page...
      const page = await h.app.inject({ method: "GET", url: "/demo/attendee" });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("your badge");

      // ...and the walkthrough's wallet route, on the same path. A page route
      // silently shadowing the POST would break the walkthrough invisibly.
      const created = await h.app.inject({ method: "POST", url: "/demo/attendee" });
      expect(created.statusCode).toBe(201);
      expect(String(created.json().address)).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// GET /demo/state
// ---------------------------------------------------------------------------

describe("GET /demo/state", () => {
  it("reports the network, the endpoint and a live issuer balance", async () => {
    const h = harness();

    const res = await h.app.inject({ method: "GET", url: "/demo/state" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: true,
      network: "testnet",
      endpoint: "wss://clio.altnet.rippletest.net:51233",
      eventId: DEMO_EVENT_ID_BASE + 1,
      issuer: { address: ISSUER, balanceXrp: ISSUER_BALANCE },
      attendee: null,
      badge: null,
      attendance: { recorded: false },
    });
    // Live, not remembered.
    expect(h.ops.getAccountBalanceXrp).toHaveBeenCalledWith(h.deps.gateway, ISSUER);
  });

  it("learns the badge from the claim slot the REAL claim route wrote", async () => {
    const h = harness();
    const created = await h.app.inject({ method: "POST", url: "/demo/attendee" });
    const address = created.json().address as string;

    // Nothing is posted back to the demo: this is what POST
    // /events/:eventId/claims leaves in the claim repository.
    await h.claims.seed(h.state.eventId, address, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });

    const res = await h.app.inject({ method: "GET", url: "/demo/state" });

    expect(res.json().badge).toEqual({
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
      accepted: false,
      burned: false,
    });
    expect(res.json().attendee).toMatchObject({ address, balanceXrp: "100", activated: true });
  });

  it("learns attendance from the index the REAL confirm route wrote", async () => {
    const h = harness();
    const created = await h.app.inject({ method: "POST", url: "/demo/attendee" });
    const address = created.json().address as string;

    await h.attendance.insert({
      eventId: h.state.eventId,
      address,
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
      txHash: ACCEPT_TX,
      ledgerIndex: 4_242_000,
    });

    const res = await h.app.inject({ method: "GET", url: "/demo/state" });

    expect(res.json().attendance).toEqual({ recorded: true, txHash: ACCEPT_TX });
    expect(res.json().badge).toMatchObject({ nftokenId: NFTOKEN_ID, accepted: true });
  });

  it("reports an unactivated attendee as such rather than failing", async () => {
    const h = harness();

    const created = await h.app.inject({
      method: "POST",
      url: "/demo/attendee",
      payload: { funded: false },
    });
    const res = await h.app.inject({ method: "GET", url: "/demo/state" });

    expect(res.statusCode).toBe(200);
    expect(res.json().attendee).toEqual({
      address: created.json().address,
      balanceXrp: "0",
      activated: false,
    });
  });
});

// ---------------------------------------------------------------------------
// POST /demo/attendee
// ---------------------------------------------------------------------------

describe("POST /demo/attendee", () => {
  it("faucet-funds by default", async () => {
    const h = harness();

    const res = await h.app.inject({ method: "POST", url: "/demo/attendee" });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ balanceXrp: "100", activated: true });
    expect(h.ops.fundWallet).toHaveBeenCalledTimes(1);
  });

  it("generates an unfunded, unactivated wallet when asked, and takes no faucet money", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "POST",
      url: "/demo/attendee",
      payload: { funded: false },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.activated).toBe(false);
    expect(body.balanceXrp).toBe("0");
    expect(String(body.address)).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);

    // The whole point of the unfunded path: nothing was faucet-funded, so the
    // address genuinely does not exist on the ledger and POST /claims must
    // sponsor it. The ledger agrees:
    expect(h.ops.fundWallet).not.toHaveBeenCalled();
    expect(h.balances.has(body.address)).toBe(false);
    const state = await h.app.inject({ method: "GET", url: "/demo/state" });
    expect(state.json().attendee.activated).toBe(false);
  });

  it("replaces the previous attendee and their badge state", async () => {
    const h = harness();
    const first = await h.app.inject({ method: "POST", url: "/demo/attendee" });
    const firstAddress = first.json().address as string;
    await h.claims.seed(h.state.eventId, firstAddress, {
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
    });
    expect((await h.app.inject({ method: "GET", url: "/demo/state" })).json().badge).not.toBeNull();

    const second = await h.app.inject({ method: "POST", url: "/demo/attendee" });
    const res = await h.app.inject({ method: "GET", url: "/demo/state" });

    expect(second.json().address).not.toBe(firstAddress);
    expect(res.json().attendee.address).toBe(second.json().address);
    // Carrying the old ids over would show the previous attendee's badge.
    expect(res.json().badge).toBeNull();
  });

  it("400s a body that is not the documented shape", async () => {
    const h = harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/demo/attendee",
      payload: { funded: "yes please" },
    });
    expect(res.statusCode).toBe(400);
    expect(h.ops.fundWallet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /demo/accept
// ---------------------------------------------------------------------------

describe("POST /demo/accept", () => {
  it("409s when there is no attendee", async () => {
    const h = harness();

    const res = await h.app.inject({ method: "POST", url: "/demo/accept" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/no demo attendee/i);
    expect(h.ops.acceptOfferAs).not.toHaveBeenCalled();
  });

  it("409s when there is an attendee but no offer to accept", async () => {
    const h = harness();
    await h.app.inject({ method: "POST", url: "/demo/attendee" });

    const res = await h.app.inject({ method: "POST", url: "/demo/accept" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/no claim offer/i);
    // The message tells the page what to do next.
    expect(res.json().error.message).toContain(`/events/${h.state.eventId}/claims`);
    expect(h.ops.acceptOfferAs).not.toHaveBeenCalled();
  });

  it("signs the offer the real claim route created, as the attendee", async () => {
    const h = harness();
    const created = await h.app.inject({ method: "POST", url: "/demo/attendee" });
    const address = created.json().address as string;
    await h.claims.seed(h.state.eventId, address, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });

    const res = await h.app.inject({ method: "POST", url: "/demo/accept" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ txHash: ACCEPT_TX, ledgerIndex: 4_242_000 });

    const call = h.ops.acceptOfferAs.mock.calls[0]?.[1];
    expect(call?.offerId).toBe(OFFER_ID);
    // Signed by the attendee, never by the issuer.
    expect(call?.wallet.classicAddress).toBe(address);

    expect((await h.app.inject({ method: "GET", url: "/demo/state" })).json().badge.accepted).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// POST /demo/burn
// ---------------------------------------------------------------------------

describe("POST /demo/burn", () => {
  it("409s before anything has been accepted", async () => {
    const h = harness();
    const created = await h.app.inject({ method: "POST", url: "/demo/attendee" });
    await h.claims.seed(h.state.eventId, created.json().address as string, {
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
    });

    const res = await h.app.inject({ method: "POST", url: "/demo/burn" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/not been accepted/i);
    expect(h.ops.burn).not.toHaveBeenCalled();
  });

  it("burns from the attendee's own wallet, not the issuer's", async () => {
    const h = harness();
    const created = await h.app.inject({ method: "POST", url: "/demo/attendee" });
    const address = created.json().address as string;
    await h.claims.seed(h.state.eventId, address, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });
    await h.app.inject({ method: "POST", url: "/demo/accept" });

    const res = await h.app.inject({ method: "POST", url: "/demo/burn" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ txHash: BURN_TX });

    const call = h.ops.burn.mock.calls[0]?.[1];
    expect(call?.nftokenId).toBe(NFTOKEN_ID);
    // A holder burn: signed by the holder, so it works regardless of tfBurnable.
    expect(call?.wallet.classicAddress).toBe(address);

    const state = await h.app.inject({ method: "GET", url: "/demo/state" });
    expect(state.json().badge).toMatchObject({ accepted: true, burned: true });
  });
});

// ---------------------------------------------------------------------------
// POST /demo/reset
// ---------------------------------------------------------------------------

describe("POST /demo/reset", () => {
  it("issues a new event id from a counter and clears the attendee", async () => {
    const h = harness();
    await h.app.inject({ method: "POST", url: "/demo/attendee" });

    const first = (await h.app.inject({ method: "GET", url: "/demo/state" })).json().eventId;
    const reset = await h.app.inject({ method: "POST", url: "/demo/reset" });
    const after = await h.app.inject({ method: "GET", url: "/demo/state" });

    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ eventId: first + 1 });
    expect(after.json().eventId).toBe(first + 1);
    expect(after.json().attendee).toBeNull();
    expect(after.json().badge).toBeNull();
    expect(after.json().attendance).toEqual({ recorded: false });
  });

  it("stays a short, readable taxon well under the reserved boundary", () => {
    const state = new DemoState();

    expect(state.eventId).toBe(DEMO_EVENT_ID_BASE + 1);
    for (let i = 0; i < 50; i += 1) state.reset();
    expect(state.eventId).toBe(DEMO_EVENT_ID_BASE + 51);
    expect(state.eventId).toBeLessThan(MAX_TAXON);
    // A clock-derived id would be ~1.7e12 and would fail this outright.
    expect(String(state.eventId)).toHaveLength(6);
  });

  it("touches nothing on the ledger", async () => {
    const h = harness();
    await h.app.inject({ method: "POST", url: "/demo/attendee" });
    h.ops.fundWallet.mockClear();

    await h.app.inject({ method: "POST", url: "/demo/reset" });

    expect(h.ops.fundWallet).not.toHaveBeenCalled();
    expect(h.ops.acceptOfferAs).not.toHaveBeenCalled();
    expect(h.ops.burn).not.toHaveBeenCalled();
    expect((h.deps.gateway as MockGateway).submits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE TWO-ROLE FLOW
//
// An attendee walks up to a volunteer. Everything below is one half of that
// conversation, and the two halves must never be able to disagree: both read
// the SAME two stores the real routes wrote, through the same reader.
// ---------------------------------------------------------------------------

/** Address-shaped junk that is not a valid classic address. */
const NOT_AN_ADDRESS = "https://example.com/definitely-not-a-wallet";

/** Register a wallet through the route and hand back what the page would hold. */
async function newWallet(
  h: ReturnType<typeof harness>,
  body?: { funded: boolean },
): Promise<{ address: string; token: string }> {
  const res = await h.app.inject({
    method: "POST",
    url: "/demo/wallet",
    ...(body ? { payload: body } : {}),
  });
  expect(res.statusCode).toBe(201);
  return { address: res.json().address as string, token: res.json().token as string };
}

// ---------------------------------------------------------------------------
// Reserve arithmetic
// ---------------------------------------------------------------------------

describe("what an empty wallet actually needs", () => {
  it("computes the shortfall from the named reserves rather than a literal", () => {
    // Base reserve, plus headroom for the one NFTokenPage the badge lands in.
    expect(badgeReadyReserveXrp()).toBe("1.2");
    expect(BASE_RESERVE_XRP).toBe("1");
    expect(OWNER_RESERVE_PER_OBJECT_XRP).toBe("0.2");

    expect(reserveShortfallXrp("0")).toBe("1.2");
    expect(reserveShortfallXrp("0.5")).toBe("0.7");
    expect(reserveShortfallXrp("1")).toBe("0.2");
  });

  it("never reports a negative shortfall, which would read as a refund", () => {
    expect(reserveShortfallXrp("1.2")).toBe("0");
    expect(reserveShortfallXrp("100")).toBe("0");
    expect(reserveShortfallXrp("999.999999")).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// The wallet registry
// ---------------------------------------------------------------------------

describe("the wallet registry", () => {
  it("holds many attendees at once and evicts the oldest past the cap", () => {
    const state = new DemoState();
    const first = Wallet.generate();
    state.registerWallet(first, { funded: false });

    for (let i = 0; i < MAX_DEMO_WALLETS; i += 1) {
      state.registerWallet(Wallet.generate(), { funded: false });
    }

    // Bounded, and it is the oldest that went.
    expect(state.walletCount).toBe(MAX_DEMO_WALLETS);
    expect(state.hasWallet(first.classicAddress)).toBe(false);
    expect(state.walletFor(first.classicAddress)).toBeUndefined();
  });

  it("never evicts the walkthrough's attendee out from under the page", () => {
    const state = new DemoState();
    const walkthrough = Wallet.generate();
    state.setAttendee(walkthrough, { funded: true });

    for (let i = 0; i < MAX_DEMO_WALLETS * 2; i += 1) {
      state.registerWallet(Wallet.generate(), { funded: false });
    }

    expect(state.walletCount).toBe(MAX_DEMO_WALLETS);
    expect(state.signingWallet()?.classicAddress).toBe(walkthrough.classicAddress);
  });

  it("issues a handle that is unguessable, unique, and not the key", () => {
    const state = new DemoState();
    const wallet = Wallet.generate();
    const seed = wallet.seed ?? "";

    const token = state.registerWallet(wallet, { funded: false });
    const other = state.registerWallet(Wallet.generate(), { funded: false });

    expect(token).not.toBe(seed);
    expect(token).not.toBe(other);
    expect(token).toMatch(/^[0-9a-f]{48}$/);

    expect(state.authorises(wallet.classicAddress, token)).toBe(true);
    expect(state.authorises(wallet.classicAddress, other)).toBe(false);
    expect(state.authorises(wallet.classicAddress, undefined)).toBe(false);
    expect(state.authorises(wallet.classicAddress, "")).toBe(false);
    // An address this process holds no key for cannot be authorised at all.
    expect(state.authorises(Wallet.generate().classicAddress, token)).toBe(false);
  });

  it("keeps handles out of every view of the state", () => {
    const state = new DemoState();
    const wallet = Wallet.generate();
    const token = state.registerWallet(wallet, { funded: false });

    expect(JSON.stringify(state)).not.toContain(token);
    expect(JSON.stringify(state.view())).not.toContain(token);
    expect(JSON.stringify({ ...state })).not.toContain(token);
    expect(JSON.stringify(state.wallets())).not.toContain(token);
    // ...and the disclosure is still useful.
    expect(state.wallets()).toEqual([
      { address: wallet.classicAddress, createdAt: expect.any(String), fundedAtCreation: false },
    ]);
  });

  it("survives a reset, because the people did not go home", () => {
    const state = new DemoState();
    const wallet = Wallet.generate();
    const token = state.registerWallet(wallet, { funded: false });
    const before = state.eventId;

    state.reset();

    expect(state.eventId).toBe(before + 1);
    expect(state.authorises(wallet.classicAddress, token)).toBe(true);
    // But nothing they did on the old event may read as current.
    state.markWalletAccepted(wallet.classicAddress, before, ACCEPT_TX, 1);
    expect(state.walletAccept(wallet.classicAddress, state.eventId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /demo/wallet
// ---------------------------------------------------------------------------

describe("POST /demo/wallet", () => {
  it("defaults to an unactivated wallet, and takes no faucet money", async () => {
    const h = harness();

    const res = await h.app.inject({ method: "POST", url: "/demo/wallet" });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.activated).toBe(false);
    expect(body.balanceXrp).toBe("0");
    expect(String(body.address)).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);

    // The whole point of the default: the address genuinely does not exist on
    // the ledger, so the volunteer has to fund it before a badge can land.
    expect(h.ops.fundWallet).not.toHaveBeenCalled();
    expect(h.balances.has(body.address)).toBe(false);
  });

  it("faucet-funds only when asked", async () => {
    const h = harness();

    const res = await h.app.inject({
      method: "POST",
      url: "/demo/wallet",
      payload: { funded: true },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ balanceXrp: "100", activated: true });
    expect(h.ops.fundWallet).toHaveBeenCalledTimes(1);
  });

  it("returns a handle that is not the seed, and never logs either", async () => {
    const h = harness();
    const wallet = Wallet.generate();
    const seed = wallet.seed ?? "";
    expect(seed.length).toBeGreaterThan(20);
    h.ops.fundWallet.mockResolvedValue({ wallet, balanceXrp: "100" });
    h.balances.set(wallet.classicAddress, "100");

    const created = await h.app.inject({
      method: "POST",
      url: "/demo/wallet",
      payload: { funded: true },
    });
    const token = created.json().token as string;

    expect(token).toBeTypeOf("string");
    expect(token).not.toBe(seed);
    expect(created.body).not.toContain(seed);
    // The other exit. `token` is on LOG_REDACT_PATHS too, so even a future log
    // line that names it cannot print it.
    expect(h.log()).not.toContain(seed);
    expect(h.log()).not.toContain(token);

    // Everything downstream still keeps the seed in.
    await h.claims.seed(h.state.eventId, wallet.classicAddress, {
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
    });
    const status = await h.app.inject({
      method: "GET",
      url: `/demo/wallet/${wallet.classicAddress}/status`,
    });
    const lookup = await h.app.inject({
      method: "GET",
      url: `/demo/lookup?address=${wallet.classicAddress}`,
    });
    const accepted = await h.app.inject({
      method: "POST",
      url: `/demo/wallet/${wallet.classicAddress}/accept`,
      payload: { token },
    });

    for (const res of [status, lookup, accepted]) {
      expect(res.body).not.toContain(seed);
      expect(res.body).not.toContain(token);
    }
    expect(h.log()).not.toContain(seed);
    expect(h.log()).not.toContain(token);
  });

  it("400s a body that is not the documented shape", async () => {
    const h = harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/demo/wallet",
      payload: { funded: "yes please" },
    });
    expect(res.statusCode).toBe(400);
    expect(h.ops.fundWallet).not.toHaveBeenCalled();
  });

  it("leaves the walkthrough's attendee slot alone", async () => {
    const h = harness();
    const walkthrough = await h.app.inject({ method: "POST", url: "/demo/attendee" });

    await newWallet(h);
    await newWallet(h);

    // Two more people scanned in; the walkthrough is still on its own attendee.
    const state = await h.app.inject({ method: "GET", url: "/demo/state" });
    expect(state.json().attendee.address).toBe(walkthrough.json().address);
  });
});

// ---------------------------------------------------------------------------
// GET /demo/wallet/:address/status
// ---------------------------------------------------------------------------

describe("GET /demo/wallet/:address/status", () => {
  it("reports an unactivated wallet and what it is short by", async () => {
    const h = harness();
    const { address } = await newWallet(h);

    const res = await h.app.inject({ method: "GET", url: `/demo/wallet/${address}/status` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      address,
      eventId: h.state.eventId,
      activated: false,
      balanceXrp: "0",
      reserveShortfallXrp: "1.2",
      pending: null,
      accepted: false,
      attended: false,
    });
  });

  it("derives `pending` from the claim slot the REAL claim route wrote", async () => {
    const h = harness();
    const { address } = await newWallet(h);

    // Nothing is posted back to the demo: this is what POST
    // /events/:eventId/claims leaves in the claim repository.
    await h.claims.seed(h.state.eventId, address, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });

    const res = await h.app.inject({ method: "GET", url: `/demo/wallet/${address}/status` });

    expect(res.json().pending).toEqual({ offerId: OFFER_ID, nftokenId: NFTOKEN_ID });
    expect(res.json().accepted).toBe(false);
  });

  it("shows nothing pending while the mint is still in flight", async () => {
    const h = harness();
    const { address } = await newWallet(h);

    // The claim slot is taken before anything is minted, so there is a moment
    // where a row exists with no offer. Nothing for the attendee to confirm yet.
    await h.claims.open({ eventId: h.state.eventId, address });

    const res = await h.app.inject({ method: "GET", url: `/demo/wallet/${address}/status` });
    expect(res.json().pending).toBeNull();
  });

  it("reports attendance from the index the REAL confirm route wrote", async () => {
    const h = harness();
    const { address } = await newWallet(h);
    await h.claims.seed(h.state.eventId, address, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });

    await h.attendance.insert({
      eventId: h.state.eventId,
      address,
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
      txHash: ACCEPT_TX,
      ledgerIndex: 4_242_000,
    });

    const res = await h.app.inject({ method: "GET", url: `/demo/wallet/${address}/status` });

    expect(res.json()).toMatchObject({
      attended: true,
      accepted: true,
      txHash: ACCEPT_TX,
      // The offer is consumed; showing it as pending would invite a second
      // accept that can only fail.
      pending: null,
    });
  });

  it("reads the balance live rather than remembering what it handed out", async () => {
    const h = harness();
    const { address } = await newWallet(h);

    // The volunteer sponsors them; the ledger, not this process, is what says so.
    h.balances.set(address, "1.5");

    const res = await h.app.inject({ method: "GET", url: `/demo/wallet/${address}/status` });

    expect(res.json()).toMatchObject({
      activated: true,
      balanceXrp: "1.5",
      reserveShortfallXrp: "0",
    });
  });

  it("400s an address that is not a classic address", async () => {
    const h = harness();
    const res = await h.app.inject({ method: "GET", url: "/demo/wallet/nonsense/status" });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /demo/wallet/:address/accept
// ---------------------------------------------------------------------------

describe("POST /demo/wallet/:address/accept", () => {
  it("403s a wrong handle, before it reads anything and long before it signs", async () => {
    const h = harness();
    const { address } = await newWallet(h);
    await h.claims.seed(h.state.eventId, address, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });

    const res = await h.app.inject({
      method: "POST",
      url: `/demo/wallet/${address}/accept`,
      payload: { token: "0".repeat(48) },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/handle/i);
    expect(h.ops.acceptOfferAs).not.toHaveBeenCalled();
  });

  it("403s a missing handle rather than 400ing it", async () => {
    const h = harness();
    const { address } = await newWallet(h);
    await h.claims.seed(h.state.eventId, address, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });

    // No body at all, and an empty body. "You may not drive this wallet" is a
    // different answer from "your JSON is wrong" and the page shows different
    // things for them.
    for (const payload of [undefined, {}]) {
      const res = await h.app.inject({
        method: "POST",
        url: `/demo/wallet/${address}/accept`,
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(403);
    }
    expect(h.ops.acceptOfferAs).not.toHaveBeenCalled();
  });

  it("403s a handle that is real but belongs to somebody else's wallet", async () => {
    const h = harness();
    const mine = await newWallet(h);
    const theirs = await newWallet(h);
    await h.claims.seed(h.state.eventId, theirs.address, {
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
    });

    const res = await h.app.inject({
      method: "POST",
      url: `/demo/wallet/${theirs.address}/accept`,
      payload: { token: mine.token },
    });

    expect(res.statusCode).toBe(403);
    expect(h.ops.acceptOfferAs).not.toHaveBeenCalled();
  });

  it("409s when there is no offer waiting", async () => {
    const h = harness();
    const { address, token } = await newWallet(h);

    const res = await h.app.inject({
      method: "POST",
      url: `/demo/wallet/${address}/accept`,
      payload: { token },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/no claim offer is waiting/i);
    expect(h.ops.acceptOfferAs).not.toHaveBeenCalled();
  });

  it("signs the offer the real claim route created, as that wallet", async () => {
    const h = harness();
    const { address, token } = await newWallet(h);
    await h.claims.seed(h.state.eventId, address, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });

    const res = await h.app.inject({
      method: "POST",
      url: `/demo/wallet/${address}/accept`,
      payload: { token },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ txHash: ACCEPT_TX, ledgerIndex: 4_242_000 });

    const call = h.ops.acceptOfferAs.mock.calls[0]?.[1];
    expect(call?.offerId).toBe(OFFER_ID);
    // Signed by the attendee, never by the issuer.
    expect(call?.wallet.classicAddress).toBe(address);

    // ...and the phone sees it immediately, before /confirm has indexed it.
    const status = await h.app.inject({ method: "GET", url: `/demo/wallet/${address}/status` });
    expect(status.json()).toMatchObject({ accepted: true, attended: false, txHash: ACCEPT_TX });
  });

  it("replays the same hash on a double tap instead of submitting twice", async () => {
    const h = harness();
    const { address, token } = await newWallet(h);
    await h.claims.seed(h.state.eventId, address, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });

    const first = await h.app.inject({
      method: "POST",
      url: `/demo/wallet/${address}/accept`,
      payload: { token },
    });
    const second = await h.app.inject({
      method: "POST",
      url: `/demo/wallet/${address}/accept`,
      payload: { token },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ txHash: ACCEPT_TX, alreadyAccepted: true });
    // The offer is gone from the ledger by now; a second submit could only fail.
    expect(h.ops.acceptOfferAs).toHaveBeenCalledTimes(1);
  });

  it("409s once attendance is recorded, because there is nothing left to sign", async () => {
    const h = harness();
    const { address, token } = await newWallet(h);
    await h.claims.seed(h.state.eventId, address, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });
    await h.attendance.insert({
      eventId: h.state.eventId,
      address,
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
      txHash: ACCEPT_TX,
      ledgerIndex: 4_242_000,
    });

    const res = await h.app.inject({
      method: "POST",
      url: `/demo/wallet/${address}/accept`,
      payload: { token },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/already has a recorded badge/i);
    expect(h.ops.acceptOfferAs).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /demo/lookup — the volunteer's scan result
// ---------------------------------------------------------------------------

describe("GET /demo/lookup", () => {
  it("answers 200 with valid:false for anything that is not an address", async () => {
    const h = harness();

    for (const scanned of [NOT_AN_ADDRESS, "", "  ", "rNotAnAddress", ISSUER.slice(0, -1)]) {
      const res = await h.app.inject({
        method: "GET",
        url: `/demo/lookup?address=${encodeURIComponent(scanned)}`,
      });

      // 200, not 400: a mis-scan is a thing to render, not a broken app.
      expect(res.statusCode, scanned).toBe(200);
      expect(res.json().valid, scanned).toBe(false);
      expect(res.json().alreadyHasBadge, scanned).toBe(false);
    }

    // Nothing was asked of the ledger on the way to that answer.
    expect(h.ops.getAccountBalanceXrp).not.toHaveBeenCalled();
  });

  it("says an unactivated wallet needs sponsorship, and by how much", async () => {
    const h = harness();
    const { address } = await newWallet(h);

    const res = await h.app.inject({ method: "GET", url: `/demo/lookup?address=${address}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      address,
      valid: true,
      eventId: h.state.eventId,
      activated: false,
      balanceXrp: "0",
      needsSponsorship: true,
      reserveShortfallXrp: "1.2",
      // What the sponsor would actually send, from the real SponsorConfig.
      sponsorAmountXrp: "1.5",
      claim: null,
      attended: false,
      alreadyHasBadge: false,
    });
  });

  it("stops asking for sponsorship once the wallet exists", async () => {
    const h = harness();
    const { address } = await newWallet(h);
    h.balances.set(address, "1.5");

    const res = await h.app.inject({ method: "GET", url: `/demo/lookup?address=${address}` });

    expect(res.json()).toMatchObject({
      activated: true,
      balanceXrp: "1.5",
      needsSponsorship: false,
      reserveShortfallXrp: "0",
    });
  });

  it("shows an open claim without calling it a badge", async () => {
    const h = harness();
    const { address } = await newWallet(h);
    h.balances.set(address, "1.5");
    await h.claims.seed(h.state.eventId, address, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });

    const res = await h.app.inject({ method: "GET", url: `/demo/lookup?address=${address}` });

    expect(res.json().claim).toEqual({
      status: "pending",
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
    });
    // POST /claims hands that same offer back rather than minting twice, so the
    // volunteer may still press issue.
    expect(res.json().alreadyHasBadge).toBe(false);
    expect(res.json().attended).toBe(false);
  });

  it("says plainly when this person already attended", async () => {
    const h = harness();
    const { address } = await newWallet(h);
    h.balances.set(address, "1.5");
    await h.attendance.insert({
      eventId: h.state.eventId,
      address,
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
      txHash: ACCEPT_TX,
      ledgerIndex: 4_242_000,
    });

    const res = await h.app.inject({ method: "GET", url: `/demo/lookup?address=${address}` });

    expect(res.json()).toMatchObject({
      attended: true,
      attendedTxHash: ACCEPT_TX,
      alreadyHasBadge: true,
    });
  });

  it("works on an address this process holds no key for", async () => {
    const h = harness();

    // The volunteer scans a real Xaman wallet. There is no demo wallet behind
    // it and there does not need to be.
    const res = await h.app.inject({ method: "GET", url: `/demo/lookup?address=${ISSUER}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ valid: true, activated: true, balanceXrp: ISSUER_BALANCE });
  });
});

// ---------------------------------------------------------------------------
// POST /demo/sponsor
// ---------------------------------------------------------------------------

/** A sponsorWallet that answers however the test wants, and records its input. */
function sponsorOps(impl: ChainOps["sponsorWallet"]) {
  return { sponsorWallet: vi.fn<ChainOps["sponsorWallet"]>(impl) };
}

describe("POST /demo/sponsor", () => {
  it("calls the REAL sponsorWallet, with the real config and the real ledger", async () => {
    const chain = sponsorOps(async (_gateway, input) => ({
      sponsored: true,
      alreadyActivated: false,
      address: input.address,
      amountXrp: "1.5",
      txHash: ACCEPT_TX,
      ledgerIndex: 4_242_002,
    }));
    const h = harness({ chain });
    const { address } = await newWallet(h);

    const res = await h.app.inject({
      method: "POST",
      url: "/demo/sponsor",
      payload: { address, eventId: h.state.eventId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sponsored: true, alreadyActivated: false, amountXrp: "1.5", txHash: ACCEPT_TX });

    // The guards are only real if the real ledger is passed: without it there
    // is no duplicate check and no daily cap.
    const call = chain.sponsorWallet.mock.calls[0]?.[1];
    expect(call?.address).toBe(address);
    expect(call?.eventId).toBe(h.state.eventId);
    expect(call?.config).toBe(h.deps.config.sponsor);
    expect(call?.ledger).toBe(h.deps.sponsorLedger);
  });

  it("reports an already-activated wallet without spending anything", async () => {
    const chain = sponsorOps(async (_gateway, input) => ({
      sponsored: false,
      alreadyActivated: true,
      address: input.address,
    }));
    const h = harness({ chain });

    const res = await h.app.inject({
      method: "POST",
      url: "/demo/sponsor",
      payload: { address: ISSUER, eventId: h.state.eventId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sponsored: false, alreadyActivated: true });
  });

  it("surfaces a refusal as a 403, with the kind the page needs", async () => {
    for (const kind of ["duplicate", "disabled", "already_activated"] as const) {
      const chain = sponsorOps(async () => {
        throw new SponsorshipDeniedError(`refused: ${kind}`, kind, { address: ISSUER });
      });
      const h = harness({ chain });

      const res = await h.app.inject({
        method: "POST",
        url: "/demo/sponsor",
        payload: { address: ISSUER, eventId: h.state.eventId },
      });

      expect(res.statusCode, kind).toBe(403);
      expect(res.json().error.code, kind).toBe("SPONSORSHIP_DENIED");
      expect(res.json().error.details.kind, kind).toBe(kind);
    }
  });

  it("surfaces the daily cap as a 429, because tomorrow it may pass", async () => {
    const chain = sponsorOps(async () => {
      throw new SponsorshipDeniedError("Daily sponsorship cap of 50 XRP would be exceeded", "daily_cap", {
        amountXrp: "1.5",
        dailyCapXrp: "50",
        spentTodayXrp: "49",
      });
    });
    const h = harness({ chain });

    const res = await h.app.inject({
      method: "POST",
      url: "/demo/sponsor",
      payload: { address: ISSUER, eventId: h.state.eventId },
    });

    // A throttle, not a refusal — and never a generic 500, or the volunteer
    // learns nothing from watching the cap work.
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("SPONSORSHIP_DENIED");
    expect(res.json().error.details).toMatchObject({ kind: "daily_cap", spentTodayXrp: "49" });
  });

  it("400s an address or event id that is not one", async () => {
    const h = harness();

    for (const payload of [
      { address: NOT_AN_ADDRESS, eventId: 900_001 },
      { address: ISSUER },
      {},
    ]) {
      const res = await h.app.inject({ method: "POST", url: "/demo/sponsor", payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// The two screens agree
// ---------------------------------------------------------------------------

describe("the attendee's phone and the volunteer's screen", () => {
  it("tell the same story at every step, because they read the same stores", async () => {
    const h = harness();
    const { address, token } = await newWallet(h);

    const status = async () =>
      (await h.app.inject({ method: "GET", url: `/demo/wallet/${address}/status` })).json();
    const lookup = async () =>
      (await h.app.inject({ method: "GET", url: `/demo/lookup?address=${address}` })).json();

    // 1. Scanned. Empty wallet: it cannot receive an NFT at all.
    expect((await lookup()).needsSponsorship).toBe(true);
    expect((await status()).activated).toBe(false);
    expect((await status()).reserveShortfallXrp).toBe((await lookup()).reserveShortfallXrp);

    // 2. Sponsored — by the ledger, which is the only thing either side reads.
    h.balances.set(address, "1.5");
    expect((await lookup()).needsSponsorship).toBe(false);
    expect((await status()).activated).toBe(true);

    // 3. Issued, by the REAL claim route.
    await h.claims.seed(h.state.eventId, address, { nftokenId: NFTOKEN_ID, offerId: OFFER_ID });
    expect((await status()).pending).toEqual({ offerId: OFFER_ID, nftokenId: NFTOKEN_ID });
    expect((await lookup()).claim.offerId).toBe(OFFER_ID);
    expect((await lookup()).alreadyHasBadge).toBe(false);

    // 4. Confirmed on the phone.
    await h.app.inject({
      method: "POST",
      url: `/demo/wallet/${address}/accept`,
      payload: { token },
    });
    expect((await status())).toMatchObject({ accepted: true, pending: null, attended: false });

    // 5. Indexed by the REAL confirm route.
    await h.attendance.insert({
      eventId: h.state.eventId,
      address,
      nftokenId: NFTOKEN_ID,
      offerId: OFFER_ID,
      txHash: ACCEPT_TX,
      ledgerIndex: 4_242_000,
    });
    expect((await status())).toMatchObject({ attended: true, txHash: ACCEPT_TX });
    expect((await lookup())).toMatchObject({ attended: true, alreadyHasBadge: true });
  });
});
