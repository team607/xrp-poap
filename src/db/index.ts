/**
 * The persistence layer: the attendance index, the sponsorship ledger and the
 * claim slots.
 *
 * The XRP Ledger is the source of truth for attendance; that table is only an
 * index over it. See src/db/attendance-repo.ts for what that rule costs you.
 * The sponsorship ledger and the claim slots are the exception — they are our
 * own state, and nothing on chain can reconstruct them.
 *
 * Pick an implementation at the composition root:
 *   - Postgres:  createPool() + PgAttendanceRepository / PgSponsorLedger /
 *                PgClaimRepository
 *   - No DB:     MemoryAttendanceRepository / MemorySponsorLedger /
 *                MemoryClaimRepository
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

export {
  PgSponsorLedger,
  dropsToXrpString,
  xrpToDropsBigInt,
  DROPS_PER_XRP,
  SPONSOR_CAP_LOCK_KEY,
} from "./sponsor-ledger.js";

export { PgClaimRepository } from "./claim-repo.js";

export {
  MemoryAttendanceRepository,
  MemorySponsorLedger,
  MemoryClaimRepository,
} from "./memory.js";
