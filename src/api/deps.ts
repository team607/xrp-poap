/**
 * Everything the HTTP layer is allowed to touch, in one injectable bag.
 *
 * There are no module-level singletons anywhere under src/api: buildServer()
 * takes an ApiDeps and nothing else, so a test can stand the whole server up
 * with a fake gateway, fake repositories and fake ledger operations. buildDeps()
 * is the only place that reaches for real connections.
 */
import type { FastifyServerOptions } from "fastify";
import type { AppConfig, SponsorConfig } from "../config.js";
import type {
  AttendanceRepository,
  ClaimOffer,
  ClaimRepository,
  CreateClaimOfferInput,
  EventId,
  MintBadgeInput,
  MintResult,
  Roster,
  SponsorLedger,
  SponsorResult,
  VerifyClaimInput,
  VerifyClaimResult,
  XrplGateway,
} from "../types.js";
import { createGateway } from "../xrpl/client.js";
import { NullXamanService, XummXamanService, type XamanService } from "../xaman/client.js";
import { assertDemoAllowed, type DemoOptions } from "./demo-state.js";
import { REDACTED, redactDetails, scrubSecrets } from "./http-errors.js";

// ---------------------------------------------------------------------------
// Ledger operations
// ---------------------------------------------------------------------------

/**
 * The ledger operations the routes call, as an interface rather than direct
 * imports of src/xrpl/*. Two reasons: the routes stay honest about what they
 * touch, and the API test suite never has to fake rippled responses precisely
 * enough to drive mint/offer/verify end to end — those modules have their own
 * unit tests. Every operation still takes the gateway as its first argument.
 */
export interface ChainOps {
  mint(gateway: XrplGateway, input: MintBadgeInput): Promise<MintResult>;
  createClaimOffer(gateway: XrplGateway, input: CreateClaimOfferInput): Promise<ClaimOffer>;
  accountExists(gateway: XrplGateway, address: string): Promise<boolean>;
  sponsorWallet(
    gateway: XrplGateway,
    input: { address: string; eventId: EventId; config: SponsorConfig; ledger?: SponsorLedger },
  ): Promise<SponsorResult>;
  verifyClaim(gateway: XrplGateway, input: VerifyClaimInput): Promise<VerifyClaimResult>;
  /**
   * count of entries the node returned with no owner. GET /roster forwards the
   * whole object, so declaring the narrower type here would have made that
   * forwarding accidental — true at runtime, invisible to anyone reading the
   * contract. The type is imported for its shape only and is erased at compile
   * time, so this does not pull src/xrpl/roster.js into the module graph.
   */
  getRoster(
    gateway: XrplGateway,
    eventId: EventId,
    opts?: { issuerAddress?: string; maxPages?: number; limit?: number },
  ): Promise<Roster>;
}

/** Bind ChainOps to the real implementations. */
export async function loadChainOps(): Promise<ChainOps> {
  const [mintMod, offersMod, sponsorMod, verifyMod, rosterMod] = await Promise.all([
    import("../xrpl/mint.js"),
    import("../xrpl/offers.js"),
    import("../xrpl/sponsor.js"),
    import("../xrpl/verify.js"),
    import("../xrpl/roster.js"),
  ]);

  return {
    mint: mintMod.mint,
    createClaimOffer: offersMod.createClaimOffer,
    accountExists: sponsorMod.accountExists,
    sponsorWallet: sponsorMod.sponsorWallet,
    verifyClaim: verifyMod.verifyClaim,
    getRoster: rosterMod.getRoster,
  };
}

// ---------------------------------------------------------------------------
// Logging — the second half of the redaction story
// ---------------------------------------------------------------------------

/**
 * The response body and the log line are two different exits, and only one of
 * them used to be guarded.
 *
 * `toErrorResponse()` in http-errors.ts scrubs everything on its way into a
 * response. The log sink had nothing: pino's default `err` serializer emits
 * every own enumerable property of the error — so `details` always, whatever it
 * happens to hold — and follows `cause` into the message and the stack. An
 * `XrplLayerError` whose details bag ever picked up a wallet, a config object or
 * an `err.cause` chain would print the seed verbatim to stdout while the caller
 * saw a tidy `"[redacted]"`.
 *
 * Two layers now stand in the way, in this order:
 *
 *   1. `serializeLoggedError` below — an ALLOW LIST. It builds a fresh object
 *      out of the handful of fields named there and runs each of them through
 *      the same `scrubSecrets()` / `redactDetails()` the response path uses.
 *      Nothing that is not named reaches the sink, so a future error class that
 *      hangs a `wallet` off itself cannot leak by accident.
 *   2. `LOG_REDACT_PATHS` — pino's own key-path redaction, applied to the whole
 *      log object. This is what covers the field that is not an error at all:
 *      `log.info({ gateway })`, where XrplConnection holds a Wallet and
 *      `Object.keys(wallet)` includes `seed`.
 */

/** The shape fastify's `serializers.err` contract requires. */
export interface SerializedLogError {
  type: string;
  message: string;
  stack: string;
  [key: string]: unknown;
}

/** How far down an `error.cause` chain to keep going before giving up. */
const MAX_CAUSE_DEPTH = 4;

function scrubOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? scrubSecrets(value) : undefined;
}

/**
 * Turn anything thrown into a log-safe object.
 *
 * Deliberately an allow list, not a deny list: the returned object is built
 * field by field, so an error carrying `{ wallet }`, `{ config }` or any other
 * unforeseen property simply does not appear. `details` is the one open-ended
 * field and it goes through `redactDetails()`, exactly as the response does.
 */
export function serializeLoggedError(value: unknown, depth = 0): SerializedLogError {
  if (!(value instanceof Error)) {
    // `log.error({ err: "something" })` happens. Treat it as a details bag.
    const bag = redactDetails(value);
    return {
      type: typeof value,
      message: bag ? "" : scrubSecrets(String(value)),
      stack: "",
      ...(bag ? { details: bag } : {}),
    };
  }

  const err = value as Error & {
    code?: unknown;
    statusCode?: unknown;
    engineResult?: unknown;
    details?: unknown;
  };

  const code = scrubOptionalString(err.code);
  const engineResult = scrubOptionalString(err.engineResult);
  const details = redactDetails(err.details);

  const out: SerializedLogError = {
    type: err.name,
    message: scrubSecrets(err.message),
    stack: scrubOptionalString(err.stack) ?? "",
    ...(code === undefined ? {} : { code }),
    ...(typeof err.statusCode === "number" ? { statusCode: err.statusCode } : {}),
    ...(engineResult === undefined ? {} : { engineResult }),
    ...(details ? { details } : {}),
  };

  // pino's default serializer walks `cause` into the message and the stack, so
  // dropping it here without recursing would just move the leak.
  if (err.cause !== undefined && err.cause !== null) {
    out.cause =
      depth < MAX_CAUSE_DEPTH ? serializeLoggedError(err.cause, depth + 1) : "[truncated]";
  }

  return out;
}

/**
 * pino key paths, censored wholesale. The second layer: it catches values that
 * never went near an Error, which the serializer cannot see.
 *
 * Three levels of wildcard is a judgement call, not a law — it covers
 * `{ gateway: { wallet: { seed } } }`, which is the realistic shape. Depth is
 * cheap here; the expensive mistake is a missing key.
 */
export const LOG_REDACT_PATHS: string[] = [
  "seed",
  "*.seed",
  "*.*.seed",
  "*.*.*.seed",
  "issuerSeed",
  "*.issuerSeed",
  "*.*.issuerSeed",
  "secret",
  "*.secret",
  "*.*.secret",
  "apiKey",
  "*.apiKey",
  "*.*.apiKey",
  "apiSecret",
  "*.apiSecret",
  "*.*.apiSecret",
  "privateKey",
  "*.privateKey",
  "*.*.privateKey",
  "password",
  "*.password",
  "*.*.password",
  "passphrase",
  "*.passphrase",
  "jwt",
  "*.jwt",
  "*.*.jwt",
  "token",
  "*.token",
  "*.*.token",
  "userToken",
  "*.userToken",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "req.headers.authorization",
  "req.headers.cookie",
];

/** Logger options minus the `boolean` shorthand fastify also accepts. */
export type ApiLoggerOptions = Exclude<FastifyServerOptions["logger"], boolean | undefined>;

/**
 * The one logger configuration. buildDeps() uses it in production and the tests
 * use it verbatim with a capture stream bolted on, so what is asserted is what
 * ships.
 */
export function buildLoggerOptions(level?: string): ApiLoggerOptions {
  return {
    level: level ?? process.env.LOG_LEVEL ?? "info",
    serializers: { err: (err) => serializeLoggedError(err) },
    redact: { paths: LOG_REDACT_PATHS, censor: REDACTED },
  };
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface RateLimitSettings {
  /** Off in tests. On everywhere else. */
  enabled?: boolean;
  global?: { max: number; timeWindow: string | number };
  /** The claim route spends the issuer's XRP, so it gets its own tighter cap. */
  claim?: { max: number; timeWindow: string | number };
}

export interface ApiDeps {
  config: AppConfig;
  gateway: XrplGateway;
  attendance: AttendanceRepository;
  /**
   * Guards the mint. Not optional: the attendance table cannot dedupe a claim
   * because nothing writes to it until after the attendee signs, so without
   * this one address can drive N mints and lock N * 0.2 XRP of owner reserve
   * (brief 7) before a single row exists.
   */
  claims: ClaimRepository;
  sponsorLedger: SponsorLedger;
  xaman?: XamanService;
  /** Ledger operations. Injected so the server is constructible without a node. */
  chain: ChainOps;
  /**
   * Per-event default metadata URI, used when a claim request carries no
   * `metadataUri`. Routes never reach into the metadata/IPFS pipeline
   * themselves: pinning is a separate concern with its own failure modes
   * (brief 8 step 4), and a route is the wrong place to discover Pinata is down.
   */
  metadataUriForEvent?: (eventId: EventId) => string | undefined | Promise<string | undefined>;
  rateLimit?: RateLimitSettings;
  /**
   * Whether `X-Forwarded-For` may be believed when deriving `request.ip`.
   *
   * DEFAULTS TO FALSE, and false is the only safe default: with no proxy in
   * front, trusting the header lets any caller pick their own rate-limit
   * bucket. Behind an ingress the opposite is true — every attendee at the
   * event arrives from the load balancer's single address and shares one 5/min
   * claim bucket, so real people get 429s while a distributed attacker, who
   * changes source address anyway, does not.
   *
   * Accepts fastify's form: `true`, or a CIDR/address list naming the proxies
   * that may be believed — prefer the list. AppConfig has no field for this yet
   * (see parseTrustProxy below), so it is an ApiDeps option and the composition
   * root supplies it.
   */
  trustProxy?: boolean | string | string[];
  /**
   * The TESTNET-ONLY demo harness. Absent — the default — means `/demo/*` does
   * not exist and the server 404s it like any other unknown path.
   *
   * Set only by the composition root, from `DEMO_ENABLED`, and only ever
   * alongside a non-mainnet network: buildDeps() below and buildServer() both
   * refuse the mainnet combination rather than quietly dropping the routes. See
   * src/api/demo-state.ts.
   */
  demo?: DemoOptions;
  logger?: FastifyServerOptions["logger"];
}

export interface BuiltDeps {
  deps: ApiDeps;
  close(): Promise<void>;
}

/**
 * `TRUST_PROXY` -> `ApiDeps.trustProxy`.
 *
 * Read here rather than in loadConfig() only because AppConfig has no field for
 * it and src/config.ts is not this change's to edit; deps.ts already reads
 * LOG_LEVEL the same way. It belongs in AppConfig — see the summary.
 *
 * Unset or empty means FALSE. A deployment has to say yes.
 *
 * The booleans follow src/config.ts's `bool()` vocabulary so `TRUST_PROXY=1`
 * means what everything else in this repo means by `1`. Anything else is passed
 * through as fastify's comma-separated address/CIDR list, which is the form to
 * prefer: `true` trusts whoever last touched the request.
 *
 * There is deliberately no hop-count form. Fastify treats a numeric trustProxy
 * as fail-closed (it cannot validate the immediate peer), so accepting one here
 * would silently mean "never trust" while reading as "trust one hop".
 */
export function parseTrustProxy(raw: string | undefined): boolean | string {
  const value = raw?.trim();
  if (value === undefined || value === "") return false;

  const lower = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(lower)) return true;
  if (["false", "0", "no", "off"].includes(lower)) return false;
  return value;
}

/**
 * Real wiring. Connects the gateway, picks durable storage when it is
 * configured, and constructs the Xaman service only when keys are present —
 * the server starts fine without them.
 */
export async function buildDeps(config: AppConfig): Promise<BuiltDeps> {
  // The demo switch is checked BEFORE anything opens a socket. `DEMO_ENABLED`
  // paired with mainnet is a hard error, not a silent skip — see
  // assertDemoAllowed() — and refusing here means a mainnet connection is never
  // even attempted by a process configured that way.
  const demoEnabled = config.demoEnabled;
  if (demoEnabled) assertDemoAllowed(config);

  const gateway = await createGateway(config);
  const chain = await loadChainOps();

  // Imported here rather than at the top of the file: src/db pulls in `pg`, and
  // nothing that merely imports the server (tests, tooling) should pay for a
  // Postgres driver it will not use.
  const db = await import("../db/index.js");

  let attendance: AttendanceRepository;
  let sponsorLedger: SponsorLedger;
  let claims: ClaimRepository;
  let disposeStores: (() => Promise<void>) | undefined;

  if (config.databaseUrl) {
    const pool = db.createPool(config.databaseUrl);
    attendance = new db.PgAttendanceRepository(pool);
    sponsorLedger = new db.PgSponsorLedger(pool);
    claims = new db.PgClaimRepository(pool);
    disposeStores = () => db.closePool(pool);
  } else {
    attendance = new db.MemoryAttendanceRepository();
    sponsorLedger = new db.MemorySponsorLedger();
    claims = new db.MemoryClaimRepository();
    // One line, once, at startup. Losing the index does not lose attendance —
    // the ledger still has it — but it does lose every cheap read until the
    // rows are re-derived. Losing the claim slots is worse than that: an
    // in-flight offer id goes with them, and scripts/reap-offers.ts can then
    // no longer find the 0.2 XRP each one is holding.
    console.warn(
      "[api] DATABASE_URL is unset: the attendance index, the sponsorship " +
        "guards and the claim slots are in memory and do not survive a restart. Not " +
        "durable. The ledger remains the source of truth; re-derive with GET /verify. " +
        "Offers open at restart become unreapable — cancel them by hand.",
    );
  }

  const { apiKey, apiSecret } = config.xumm;
  const xaman: XamanService =
    apiKey && apiSecret ? new XummXamanService({ apiKey, apiSecret }) : new NullXamanService();

  // Without this, every claim request must carry its own `metadataUri`.
  const defaultMetadataUri = config.defaultMetadataUri;

  /**
   * Demo wiring, built only when the switch is on. The faucet op closes over
   * the concrete XrplConnection because `client.fundWallet()` is not a submit
   * and is not on the XrplGateway seam — closing over it here keeps the demo
   * routes gateway-agnostic and unit-testable, with no cast.
   */
  const demo: DemoOptions | undefined = demoEnabled
    ? await (async () => {
        const [offersMod, burnMod, sponsorMod] = await Promise.all([
          import("../xrpl/offers.js"),
          import("../xrpl/burn.js"),
          import("../xrpl/sponsor.js"),
        ]);
        return {
          enabled: true,
          ops: {
            fundWallet: async () => {
              const funded = await gateway.client.fundWallet();
              return { wallet: funded.wallet, balanceXrp: String(funded.balance) };
            },
            getAccountBalanceXrp: sponsorMod.getAccountBalanceXrp,
            acceptOfferAs: offersMod.acceptOfferAs,
            burn: burnMod.burn,
          },
        } satisfies DemoOptions;
      })()
    : undefined;

  const deps: ApiDeps = {
    config,
    gateway,
    attendance,
    claims,
    sponsorLedger,
    xaman,
    chain,
    trustProxy: config.api.trustProxy,
    logger: buildLoggerOptions(),
    ...(defaultMetadataUri ? { metadataUriForEvent: () => defaultMetadataUri } : {}),
    ...(demo ? { demo } : {}),
  };

  return {
    deps,
    async close(): Promise<void> {
      try {
        await gateway.disconnect();
      } finally {
        if (disposeStores) await disposeStores();
      }
    },
  };
}
