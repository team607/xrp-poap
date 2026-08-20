/**
 * DEMO ONLY. The in-memory state behind `/demo/*`, plus the guard that decides
 * whether those routes may exist at all.
 *
 * ┌─ WHY THIS FILE IS PARANOID ──────────────────────────────────────────────┐
 * │ The demo harness generates wallets, takes faucet money and signs          │
 * │ transactions on behalf of an attendee. That is fine on testnet and        │
 * │ catastrophic anywhere else, so two things live here:                      │
 * │                                                                           │
 * │   1. `assertDemoAllowed()` — refuses, loudly, to pair the demo with       │
 * │      mainnet. It throws rather than quietly disabling itself, because a   │
 * │      silent skip lets an operator believe the demo is off when they meant │
 * │      it on, or ship it believing it is on.                                │
 * │   2. `DemoState` — the attendee's Wallet lives in a `#private` field and  │
 * │      is reachable only through a method. It is unreachable to             │
 * │      `JSON.stringify`, to pino, to `Object.keys`, and to a spread. There  │
 * │      is no code path that can serialise the seed by accident.             │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Nothing in here imports the HTTP layer or the ledger layer, so both
 * `deps.ts` (the composition root) and `routes/demo.ts` can depend on it
 * without a cycle.
 */
import type { Wallet } from "xrpl";
import { ConfigError } from "../errors.js";
import type { BurnResult, EventId, NetworkName, XrplGateway } from "../types.js";
import { MAX_TAXON } from "../types.js";

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/**
 * Refuse to register the demo against real money.
 *
 * Called twice on purpose: once in the composition root before a connection is
 * opened, and once when the routes are registered, so a server built by hand in
 * a test hits it too. A THIRD check runs per request inside the routes, because
 * a config object mutated after boot must not be able to open them.
 */
export function assertDemoAllowed(config: { network: NetworkName; endpoint?: string }): void {
  if (config.network !== "mainnet") return;

  throw new ConfigError(
    "DEMO_ENABLED is true but XRPL_NETWORK is mainnet. The demo harness generates wallets, " +
      "takes faucet funds and signs transactions on an attendee's behalf; it must never be " +
      "registered against mainnet. Unset DEMO_ENABLED, or point this process at testnet. " +
      "Refusing to start.",
    { network: config.network, ...(config.endpoint ? { endpoint: config.endpoint } : {}) },
  );
}

/**
 * `DEMO_ENABLED` -> boolean, read by the composition root.
 *
 * AppConfig has no field for it (src/config.ts is not this change's to edit), so
 * deps.ts reads `process.env` the way it already does for `LOG_LEVEL`. Unset,
 * empty or false means OFF: a deployment has to say yes.
 *
 * Anything unrecognised THROWS rather than defaulting, following the vocabulary
 * of `bool()` in src/config.ts. `DEMO_ENABLED=maybe` silently meaning "off" is
 * the same failure mode as silently disabling on mainnet — the operator's belief
 * and the process's behaviour diverge, and nothing says so.
 */
export function parseDemoEnabled(raw: string | undefined): boolean {
  const value = raw?.trim();
  if (value === undefined || value === "") return false;

  const lower = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(lower)) return true;
  if (["false", "0", "no", "off"].includes(lower)) return false;

  throw new ConfigError(`DEMO_ENABLED must be a boolean, got "${value}"`, { key: "DEMO_ENABLED" });
}

// ---------------------------------------------------------------------------
// Ledger operations the demo needs and the real routes do not
// ---------------------------------------------------------------------------

/**
 * The four ledger operations that exist only for the demo, injected the same way
 * `ChainOps` is: the routes stay honest about what they touch, and the tests
 * drive them with `vi.fn()` instead of a node.
 *
 * `fundWallet` takes no gateway because it needs the concrete `XrplConnection`
 * (a faucet call is `client.fundWallet()`, not a submit). The composition root
 * closes over the connection it just built rather than casting here.
 */
export interface DemoChainOps {
  /** Faucet a fresh, activated wallet. Testnet/devnet only, by definition. */
  fundWallet(): Promise<{ wallet: Wallet; balanceXrp: string }>;
  /** Balance as a decimal XRP string. Throws ACCOUNT_NOT_FOUND when unactivated. */
  getAccountBalanceXrp(gateway: XrplGateway, address: string): Promise<string>;
  /** The attendee's own NFTokenAcceptOffer. In production Xaman does this. */
  acceptOfferAs(
    gateway: XrplGateway,
    params: { offerId: string; wallet: Wallet },
  ): Promise<{ txHash: string; ledgerIndex: number }>;
  /** Holder-burn, signed by the attendee rather than the issuer. */
  burn(gateway: XrplGateway, params: { nftokenId: string; wallet: Wallet }): Promise<BurnResult>;
}

/** What `ApiDeps.demo` carries. Absent means the demo does not exist. */
export interface DemoOptions {
  /** Both this AND a non-mainnet network are required. See assertDemoAllowed. */
  enabled: boolean;
  ops: DemoChainOps;
  /** Supplied by tests; the routes make their own otherwise. */
  state?: DemoState;
  /** Overridable so a test can point at a file that is deliberately absent. */
  htmlPath?: string;
}

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

/**
 * Event ids double as the NFTokenTaxon, so they must stay below 2147483648.
 * 900_001, 900_002, ... — a counter, not a clock. `Date.now()` would produce
 * 1_7xx_xxx_xxx_xxx, which is three orders of magnitude past the reserved
 * boundary, and even truncated it would give an unreadable id that changes
 * every run and cannot be typed into an explorer from memory.
 */
export const DEMO_EVENT_ID_BASE = 900_000;

/** Paranoia, not arithmetic: keeps the counter inside the legal taxon range. */
const MAX_DEMO_SEQUENCE = 99_999;

export interface DemoBadgeView {
  /** Null until the mint lands; the offer id follows a moment later. */
  nftokenId: string | null;
  offerId: string | null;
  accepted: boolean;
  burned: boolean;
}

/** Everything this store is willing to disclose. The seed is not in it. */
export interface DemoStateView {
  eventId: EventId;
  attendee: { address: string; funded: boolean } | null;
  badge: DemoBadgeView | null;
  /** The attendee's NFTokenAcceptOffer hash. THIS is the attendance record. */
  acceptTxHash: string | null;
  burnTxHash: string | null;
}

/**
 * One demo run's worth of state. In memory, single process, deliberately
 * forgotten on exit.
 *
 * The badge fields are a CACHE OF OBSERVED REALITY, never something the UI
 * feeds back in: `routes/demo.ts` refreshes them from the claim slot and the
 * attendance index — the two stores the real `/events/:eventId/claims` and
 * `/confirm` routes write — before every read. If the demo state and the chain
 * ever disagreed, the demo would be worth nothing.
 */
export class DemoState {
  /**
   * The attendee's key. `#private`, so it is not an own property: invisible to
   * JSON.stringify, to `{...state}`, to Object.keys, and to pino's serialisers.
   * Reachable only via signingWallet() below, which is a method and therefore
   * also unserialisable.
   */
  #attendee: Wallet | undefined;

  #sequence = 1;
  #attendeeFunded = false;
  #nftokenId: string | undefined;
  #offerId: string | undefined;
  #acceptTxHash: string | undefined;
  #burnTxHash: string | undefined;

  get eventId(): EventId {
    return DEMO_EVENT_ID_BASE + this.#sequence;
  }

  get attendeeAddress(): string | undefined {
    return this.#attendee?.classicAddress;
  }

  get attendeeFunded(): boolean {
    return this.#attendeeFunded;
  }

  get nftokenId(): string | undefined {
    return this.#nftokenId;
  }

  get offerId(): string | undefined {
    return this.#offerId;
  }

  get acceptTxHash(): string | undefined {
    return this.#acceptTxHash;
  }

  get burnTxHash(): string | undefined {
    return this.#burnTxHash;
  }

  get accepted(): boolean {
    return this.#acceptTxHash !== undefined;
  }

  get burned(): boolean {
    return this.#burnTxHash !== undefined;
  }

  /**
   * The only way out for the key, and it is a method so that no serialiser can
   * reach it. Callers sign with it and must never put it in a response, a log
   * line or an error's details bag.
   */
  signingWallet(): Wallet | undefined {
    return this.#attendee;
  }

  /**
   * Replace the demo attendee. The badge state goes with them: a new wallet
   * means a new claim, and carrying the old ids over would show the previous
   * attendee's badge against this one's address.
   */
  setAttendee(wallet: Wallet, opts: { funded: boolean }): void {
    this.#attendee = wallet;
    this.#attendeeFunded = opts.funded;
    this.#clearBadge();
  }

  /**
   * Record what the REAL claim route did, as read back out of the claim slot or
   * the attendance index. Merge-only: a later read that cannot see the offer id
   * must not erase one we already observed.
   */
  observeBadge(patch: { nftokenId?: string | null; offerId?: string | null }): void {
    if (patch.nftokenId) this.#nftokenId = patch.nftokenId;
    if (patch.offerId) this.#offerId = patch.offerId;
  }

  markAccepted(txHash: string): void {
    this.#acceptTxHash = txHash;
  }

  markBurned(txHash: string): void {
    this.#burnTxHash = txHash;
  }

  /**
   * Start a fresh demo on a new event id. Touches nothing on the ledger: the
   * previous badge stays exactly where it is and still verifies, which is the
   * whole point of "attendance is an event, not a state".
   */
  reset(): EventId {
    this.#sequence = this.#sequence >= MAX_DEMO_SEQUENCE ? 1 : this.#sequence + 1;
    this.#attendee = undefined;
    this.#attendeeFunded = false;
    this.#clearBadge();
    return this.eventId;
  }

  /**
   * The explicit, allow-listed disclosure. Built field by field out of scalars,
   * so there is no object here that could carry a key along with it.
   */
  view(): DemoStateView {
    const address = this.attendeeAddress;
    return {
      eventId: this.eventId,
      attendee: address === undefined ? null : { address, funded: this.#attendeeFunded },
      badge:
        this.#nftokenId === undefined && this.#offerId === undefined
          ? null
          : {
              nftokenId: this.#nftokenId ?? null,
              offerId: this.#offerId ?? null,
              accepted: this.accepted,
              burned: this.burned,
            },
      acceptTxHash: this.#acceptTxHash ?? null,
      burnTxHash: this.#burnTxHash ?? null,
    };
  }

  /**
   * JSON.stringify() goes through view(). Even if a future field were added as
   * a public property, it could not reach a response or a log line without
   * being named above.
   */
  toJSON(): DemoStateView {
    return this.view();
  }

  #clearBadge(): void {
    this.#nftokenId = undefined;
    this.#offerId = undefined;
    this.#acceptTxHash = undefined;
    this.#burnTxHash = undefined;
  }
}

/** The taxon boundary, asserted once at module load rather than trusted. */
if (DEMO_EVENT_ID_BASE + MAX_DEMO_SEQUENCE > MAX_TAXON) {
  throw new ConfigError("The demo event id range would exceed the reserved NFTokenTaxon boundary", {
    base: DEMO_EVENT_ID_BASE,
    maxSequence: MAX_DEMO_SEQUENCE,
    maxTaxon: MAX_TAXON,
  });
}
