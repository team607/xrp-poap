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
 * │   2. `DemoState` — every attendee Wallet lives in a `#private` Map and is │
 * │      reachable only through a method. It is unreachable to                │
 * │      `JSON.stringify`, to pino, to `Object.keys`, and to a spread. There  │
 * │      is no code path that can serialise a seed by accident.               │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Nothing in here imports the HTTP layer or the ledger layer, so both
 * `deps.ts` (the composition root) and `routes/demo.ts` can depend on it
 * without a cycle.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { type Wallet } from "xrpl";
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
// Reserve arithmetic — moved to src/xrpl/reserve.ts
//
// It lives there because `sponsorWallet` needs it too, and src/xrpl may not
// import from src/api. Re-exported here so the demo routes and their tests keep
// their existing import, and so there is still exactly one implementation.
// ---------------------------------------------------------------------------

export {
  BASE_RESERVE_XRP,
  OWNER_RESERVE_PER_OBJECT_XRP,
  badgeReadyReserveXrp,
  canReceiveBadge,
  reserveShortfallXrp,
} from "../xrpl/reserve.js";

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

// ---------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------

/**
 * The four pages `/demo/*` serves, and the files they come from.
 *
 * NONE of them are owned by this module — they are read off disk as-is and a
 * missing one is a 503, never a crash. The repo-relative form is what goes in
 * that 503: an absolute server path in a response body helps nobody and leaks
 * the layout.
 */
export type DemoPageName = "index" | "walkthrough" | "attendee" | "volunteer";

export const DEMO_PAGE_FILES: Record<DemoPageName, string> = {
  /** Role chooser: "are you an attendee or a volunteer?" */
  index: "demo-index.html",
  /** The original single-page explainer. Still the whole flow in one screen. */
  walkthrough: "demo.html",
  attendee: "attendee.html",
  volunteer: "volunteer.html",
};

/** Where the pages live, relative to the repo root. Used in operator messages. */
export const DEMO_PUBLIC_REPO_DIR = "src/api/public";

/** What `ApiDeps.demo` carries. Absent means the demo does not exist. */
export interface DemoOptions {
  /** Both this AND a non-mainnet network are required. See assertDemoAllowed. */
  enabled: boolean;
  ops: DemoChainOps;
  /** Supplied by tests; the routes make their own otherwise. */
  state?: DemoState;
  /**
   * Override for the WALKTHROUGH page only, unchanged in meaning since it was
   * the only page there was. `htmlDir` covers the other three.
   */
  htmlPath?: string;
  /**
   * Directory the four pages are read from. Defaults to `src/api/public`.
   * Overridable so a test can point at a directory that is deliberately empty.
   */
  htmlDir?: string;
  /**
   * Event label printed on the badge artwork. Absent means the generator's own
   * `EVENT <id>` caption, which is the default and the safe one.
   *
   * IT MUST MATCH WHATEVER THE PINNING RESOLVER WAS CONFIGURED WITH. The badge
   * art is a pure function of (address, eventId, caption), and `/demo/art`
   * exists precisely because that makes the served SVG byte-identical to the
   * one pinned to IPFS. A caption set here and not there — or there and not
   * here — silently breaks that equality: the page would show one image and the
   * gateway would serve another. Operator input, so it goes through
   * `artLabel()` before it reaches the generator.
   */
  eventName?: string;
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

/**
 * How many attendee wallets this process will hold keys for at once.
 *
 * A real event has many attendees and every one of them costs a Wallet in
 * memory for the life of the process. Fifty is far more than a demo table ever
 * queues up and small enough that the map can never be the reason this process
 * grows. The oldest is evicted first; an evicted wallet's badge is untouched on
 * the ledger, only this process's ability to sign for it is gone.
 */
export const MAX_DEMO_WALLETS = 50;

/** Bytes of entropy behind a wallet handle token. */
const TOKEN_BYTES = 24;

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

/** A registered wallet, minus the two things that must never be disclosed. */
export interface DemoWalletView {
  address: string;
  /** ISO 8601. Only used for "which of these is oldest". */
  createdAt: string;
  /** Whether the faucet was used when it was made, NOT its balance now. */
  fundedAtCreation: boolean;
}

/**
 * One wallet the demo can sign for.
 *
 * `wallet` and `token` are the two fields that must not escape, and neither is
 * ever put in a view: the whole record only exists inside DemoState's `#private`
 * map, so there is no object here that a serialiser could reach.
 */
interface DemoWalletEntry {
  wallet: Wallet;
  /** The opaque handle the attendee page holds. Not a key; still a credential. */
  token: string;
  createdAt: Date;
  fundedAtCreation: boolean;
  /**
   * Our own receipt for having signed this wallet's NFTokenAcceptOffer.
   *
   * NOT a duplicate of claim state: nothing in `deps.claims` or
   * `deps.attendance` records that the attendee signed until the REAL
   * `/confirm` route verifies it against the chain, and between those two
   * moments the attendee's phone still has to be told "done". Scoped to the
   * event id it happened on, so a reset cannot make it look current.
   */
  acceptedOnEventId?: EventId;
  acceptTxHash?: string;
  acceptLedgerIndex?: number;
}

/** Our receipt for one accept we signed. Not attendance — that comes off chain. */
export interface DemoAcceptReceipt {
  txHash: string;
  /** Absent only on the walkthrough path, which records the hash and no more. */
  ledgerIndex?: number;
}

/**
 * One demo run's worth of state. In memory, single process, deliberately
 * forgotten on exit.
 *
 * TWO THINGS LIVE HERE and they are different in kind:
 *
 *   1. THE WALLET REGISTRY — a Map of address -> keypair, because a two-role
 *      event demo has many attendees walking up to one volunteer. It exists
 *      because a browser cannot hold an XRPL key, and for no other reason.
 *   2. THE WALKTHROUGH SLOT — `#attendeeAddress`, the single attendee the
 *      original one-page explainer drives. It points INTO the registry rather
 *      than duplicating it, so /demo/state and /demo/wallet/:address/status can
 *      never disagree about the same wallet.
 *
 * The badge fields are a CACHE OF OBSERVED REALITY, never something the UI
 * feeds back in: `routes/demo.ts` refreshes them from the claim slot and the
 * attendance index — the two stores the real `/events/:eventId/claims` and
 * `/confirm` routes write — before every read. If the demo state and the chain
 * ever disagreed, the demo would be worth nothing.
 */
export class DemoState {
  /**
   * Every attendee key this process holds. `#private`, so it is not an own
   * property: invisible to JSON.stringify, to `{...state}`, to Object.keys, and
   * to pino's serialisers. Reachable only via the methods below, which are
   * methods and therefore also unserialisable.
   *
   * Insertion-ordered, which is what makes "evict the oldest" a `keys().next()`.
   */
  readonly #wallets = new Map<string, DemoWalletEntry>();

  /** The walkthrough's attendee. An address INTO #wallets, never a second copy. */
  #attendeeAddress: string | undefined;

  #sequence = 1;
  #nftokenId: string | undefined;
  #offerId: string | undefined;
  #acceptTxHash: string | undefined;
  #burnTxHash: string | undefined;

  get eventId(): EventId {
    return DEMO_EVENT_ID_BASE + this.#sequence;
  }

  get attendeeAddress(): string | undefined {
    return this.#attendeeAddress;
  }

  get attendeeFunded(): boolean {
    return this.#currentEntry()?.fundedAtCreation ?? false;
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

  /** How many keypairs are held right now. Bounded by MAX_DEMO_WALLETS. */
  get walletCount(): number {
    return this.#wallets.size;
  }

  // -- the registry ---------------------------------------------------------

  /**
   * Register a wallet the demo may sign for, and mint the handle that proves a
   * page drives it.
   *
   * THE TOKEN IS NOT A KEY. It is an unguessable random string, returned once,
   * held by the attendee's browser, and checked before this process will sign
   * anything as that wallet. Without it any tab that knew an address could make
   * someone else's phone-side confirmation happen. It carries no authority over
   * anything except this demo's signing shim.
   */
  registerWallet(wallet: Wallet, opts: { funded: boolean }): string {
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    this.#wallets.set(wallet.classicAddress, {
      wallet,
      token,
      createdAt: new Date(),
      fundedAtCreation: opts.funded,
    });
    this.#evictOldest();
    return token;
  }

  /** True when this process still holds a key for the address. */
  hasWallet(address: string): boolean {
    return this.#wallets.has(address);
  }

  /**
   * Whether `token` is the handle issued for `address`.
   *
   * Constant-time on the comparison and false for an unknown address, so this
   * answers "may you drive this wallet" without also answering "does this
   * wallet exist" at different speeds.
   */
  authorises(address: string, token: string | undefined): boolean {
    const entry = this.#wallets.get(address);
    if (!entry || typeof token !== "string") return false;

    const expected = Buffer.from(entry.token, "utf8");
    const supplied = Buffer.from(token, "utf8");
    if (expected.length !== supplied.length) return false;
    return timingSafeEqual(expected, supplied);
  }

  /**
   * The only way out for a key, and it is a method so that no serialiser can
   * reach it. Callers sign with it and must never put it in a response, a log
   * line or an error's details bag.
   */
  walletFor(address: string): Wallet | undefined {
    return this.#wallets.get(address)?.wallet;
  }

  /** Registered wallets, oldest first, with neither key nor token. */
  wallets(): DemoWalletView[] {
    return [...this.#wallets.values()].map((entry) => ({
      address: entry.wallet.classicAddress,
      createdAt: entry.createdAt.toISOString(),
      fundedAtCreation: entry.fundedAtCreation,
    }));
  }

  /** Whether the faucet was used when this wallet was made. */
  fundedAtCreation(address: string): boolean | undefined {
    return this.#wallets.get(address)?.fundedAtCreation;
  }

  /**
   * Remember that we signed this wallet's accept, against this event.
   *
   * The attendance index is authoritative and arrives a moment later, once the
   * real `/confirm` route has verified the hash on chain. This covers the gap
   * in between, and only that gap.
   */
  markWalletAccepted(
    address: string,
    eventId: EventId,
    txHash: string,
    ledgerIndex?: number,
  ): void {
    const entry = this.#wallets.get(address);
    if (!entry) return;
    entry.acceptedOnEventId = eventId;
    entry.acceptTxHash = txHash;
    if (ledgerIndex !== undefined) entry.acceptLedgerIndex = ledgerIndex;
  }

  /** What we signed for this wallet on this event, if we signed anything. */
  walletAccept(address: string, eventId: EventId): DemoAcceptReceipt | undefined {
    const entry = this.#wallets.get(address);
    if (!entry || entry.acceptedOnEventId !== eventId || entry.acceptTxHash === undefined) {
      return undefined;
    }
    return {
      txHash: entry.acceptTxHash,
      ...(entry.acceptLedgerIndex === undefined ? {} : { ledgerIndex: entry.acceptLedgerIndex }),
    };
  }

  // -- the walkthrough slot -------------------------------------------------

  /**
   * The walkthrough's attendee. Kept for the single-page explainer, which knows
   * about one attendee and has no token to send.
   *
   * Registers into the same map as everyone else — the registry is the one
   * place a key lives — and drops the token on the floor, because the
   * walkthrough authenticates by being the only attendee there is.
   */
  setAttendee(wallet: Wallet, opts: { funded: boolean }): void {
    this.registerWallet(wallet, opts);
    this.#attendeeAddress = wallet.classicAddress;
    // A new wallet means a new claim; carrying the old ids over would show the
    // previous attendee's badge against this one's address.
    this.#clearBadge();
  }

  /**
   * The walkthrough's key. Unchanged signature: it is the wallet in the slot.
   */
  signingWallet(): Wallet | undefined {
    return this.#currentEntry()?.wallet;
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
    // Keep the two views of the same wallet in step: /demo/state and
    // /demo/wallet/:address/status must never disagree about whether this
    // address has signed.
    if (this.#attendeeAddress) this.markWalletAccepted(this.#attendeeAddress, this.eventId, txHash);
  }

  markBurned(txHash: string): void {
    this.#burnTxHash = txHash;
  }

  /**
   * Start a fresh demo on a new event id. Touches nothing on the ledger: the
   * previous badge stays exactly where it is and still verifies, which is the
   * whole point of "attendance is an event, not a state".
   *
   * The wallet registry SURVIVES on purpose. Those are real attendees standing
   * in a room; a new event id does not send them home, and their handles are
   * still the only way their phones can confirm the next badge. Per-wallet
   * accept receipts are scoped to the event they happened on, so nothing from
   * the old event can read as current.
   */
  reset(): EventId {
    this.#sequence = this.#sequence >= MAX_DEMO_SEQUENCE ? 1 : this.#sequence + 1;
    this.#attendeeAddress = undefined;
    this.#clearBadge();
    return this.eventId;
  }

  /**
   * The explicit, allow-listed disclosure. Built field by field out of scalars,
   * so there is no object here that could carry a key along with it.
   */
  view(): DemoStateView {
    const entry = this.#currentEntry();
    return {
      eventId: this.eventId,
      attendee:
        entry === undefined
          ? null
          : { address: entry.wallet.classicAddress, funded: entry.fundedAtCreation },
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

  #currentEntry(): DemoWalletEntry | undefined {
    return this.#attendeeAddress === undefined
      ? undefined
      : this.#wallets.get(this.#attendeeAddress);
  }

  /**
   * Hold the map at MAX_DEMO_WALLETS, oldest out first.
   *
   * The walkthrough's attendee is skipped: evicting them mid-run would break
   * the page that is currently on screen, and there is exactly one of them.
   */
  #evictOldest(): void {
    while (this.#wallets.size > MAX_DEMO_WALLETS) {
      let victim: string | undefined;
      for (const address of this.#wallets.keys()) {
        if (address !== this.#attendeeAddress) {
          victim = address;
          break;
        }
      }
      if (victim === undefined) return;
      this.#wallets.delete(victim);
    }
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
