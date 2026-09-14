/**
 * The persistence layer: the attendance index, the sponsorship ledger, the
 * claim slots, events, registrations and admin sessions.
 *
 * The XRP Ledger is the source of truth for attendance; that table is only an
 * index over it. See src/db/attendance-repo.ts for what that rule costs you.
 * Everything else here is our own state and nothing on chain can reconstruct
 * it — with one seam between the two worlds: an event's id IS the NFTokenTaxon
 * that its badges carry, which is why it can never be renumbered.
 *
 * Pick an implementation at the composition root:
 *   - Postgres:  createPool() + PgAttendanceRepository / PgSponsorLedger /
 *                PgClaimRepository / PgEventRepository /
 *                PgRegistrationRepository / PgSessionStore
 *   - No DB:     createMemoryStores(), which wires the six Memory* stores to
 *                each other the way the schema wires the tables
 * Both sets satisfy the interfaces in src/types.ts and are held to one shared
 * contract suite in src/db/repo-contract.test.ts — concurrency included.
 */
export {
  createPool,
  closePool,
  withTransaction,
  type Queryable,
  type QueryResultLike,
  type CreatePoolOptions,
  type Connectable,
  type TransactionClient,
} from "./pool.js";

export {
  PgAttendanceRepository,
  normalizePaging,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "./attendance-repo.js";

/**
 * Money helpers, re-exported from where they now live. Every store that sums
 * XRP uses these, and so does the ledger layer, which must not import src/db.
 */
export {
  dropsToXrpString,
  xrpToDropsBigInt,
  normalizeXrp,
  isXrpAmount,
  DROPS_PER_XRP,
} from "../money.js";

/** Each event's wallet, with its seed sealed. */
export { PgTreasuryRepository, MemoryTreasuryRepository } from "./treasury-repo.js";

/** Vendors, their price lists, orders, and the sessions that open a vendor's screen. */
export {
  PgVendorRepository,
  MemoryVendorRepository,
  MAX_STOCK,
  type OrderReferences,
} from "./vendor-repo.js";
export {
  PgPurchaseRepository,
  MemoryPurchaseRepository,
  MAX_QUANTITY,
  isPurchaseId,
} from "./purchase-repo.js";
export { PgVendorSessionStore, MemoryVendorSessionStore } from "./vendor-session-store.js";

/** What each event's treasury paid, against its budget. */
export {
  PgAllowanceLedger,
  MemoryAllowanceLedger,
  ALLOWANCE_LOCK_CLASS,
} from "./allowance-ledger.js";

export { PgClaimRepository } from "./claim-repo.js";

/**
 * `assertValidEventId` is exported alongside the repository because the taxon
 * range is a ledger rule that outlives this layer: an id the table would
 * refuse is an id NFTokenMint would refuse too, and a caller allocating one is
 * better off finding out before either.
 */
export {
  PgEventRepository,
  assertValidEventId,
  type EventPatch,
} from "./event-repo.js";

export { PgRegistrationRepository } from "./registration-repo.js";

/**
 * Event photographs. `assertUsablePhotoUrl` is exported beside the repository
 * because the rule it encodes — http(s) only — is enforced in three places
 * (here, the route schema, and a CHECK) and all three have to agree.
 */
export {
  MemoryEventPhotoRepository,
  PgEventPhotoRepository,
  assertUsablePhotoUrl,
  normalizeCaption,
} from "./event-photo-repo.js";

/**
 * `hashSessionId` is exported because the rule it encodes is a cross-module
 * contract, not an implementation detail: the raw session id belongs in the
 * cookie and only its digest belongs in a store. Anything that persists a
 * session id must go through it.
 */
export {
  PgSessionStore,
  hashSessionId,
  newSessionId,
} from "./session-store.js";

export {
  MemoryAttendanceRepository,
  MemoryClaimRepository,
  MemoryEventRepository,
  MemoryRegistrationRepository,
  MemorySessionStore,
  createMemoryStores,
  type MemoryStores,
} from "./memory.js";
