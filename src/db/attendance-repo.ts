/**
 * The attendance index (brief section 6.5).
 *
 * ---------------------------------------------------------------------------
 * THE LEDGER IS THE SOURCE OF TRUTH. THIS TABLE IS ONLY AN INDEX.
 *
 * Never read attendance from the chain on a page load. Read this table: it is
 * a cache of claims we already watched succeed, and it is what the roster,
 * the profile page and the attendee count are served from.
 *
 * A separate verify path re-derives attendance from the chain on demand, given
 * (address, eventId, txHash) — see section 6.4. That path, not this table, is
 * what settles a dispute. If the two ever disagree, the ledger wins and this
 * table is wrong.
 *
 * The corollary matters as much as the rule: this table is allowed to be
 * incomplete (a claim that landed on-chain while our writer was down) but it
 * must never be *invented*. Only write a row for a transaction that came back
 * validated and tesSUCCESS.
 *
 * And attendance is an event, not a state. Nothing in here tracks current NFT
 * ownership, because a burned badge is still attendance.
 * ---------------------------------------------------------------------------
 */
import { XrplLayerError } from "../errors.js";
import type {
  AttendanceRecord,
  AttendanceRepository,
  EventId,
} from "../types.js";
import type { Queryable } from "./pool.js";

/** Shape of a row as pg hands it back: snake_case, bigints as strings. */
interface AttendanceRow {
  id: string;
  event_id: number;
  address: string;
  nftoken_id: string;
  offer_id: string | null;
  tx_hash: string;
  /** bigint -> string. pg will not narrow this to a number for us, and good. */
  ledger_index: string | number;
  claimed_at: Date | string;
}

const COLUMNS =
  "id, event_id, address, nftoken_id, offer_id, tx_hash, ledger_index, claimed_at";

/**
 * Chronological, oldest claim first, with a stable tie-break on id so that
 * paging through a busy event never repeats or skips a row. `claimed_at`
 * alone is not enough: two claims can share a timestamp.
 */
const ORDER_BY = "ORDER BY claimed_at ASC, id ASC";

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

interface PgErrorLike {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
}

function asPgError(err: unknown): PgErrorLike | undefined {
  return err && typeof err === "object" ? (err as PgErrorLike) : undefined;
}

function isUniqueViolation(err: unknown): boolean {
  return asPgError(err)?.code === UNIQUE_VIOLATION;
}

/**
 * Which unique constraint fired. Constraint names come from
 * 001_attendance.sql, but a table created straight from the DDL in the brief
 * gets Postgres' auto-generated names instead, so fall back to the DETAIL
 * line ("Key (tx_hash)=(...) already exists.").
 */
function violatedTxHash(err: unknown): boolean {
  const pg = asPgError(err);
  const constraint = pg?.constraint ?? "";
  if (constraint.includes("tx_hash")) return true;
  if (constraint.includes("event_id") || constraint.includes("event_address")) return false;
  return /key \(tx_hash\)/i.test(pg?.detail ?? "");
}

/** Ledger indexes are bigint on the wire. Above 2^53 a JS number silently lies. */
function toLedgerIndex(value: string | number, context: Record<string, unknown>): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new XrplLayerError(
      "LEDGER_QUERY_FAILED",
      `ledger_index ${value} cannot be represented as a JS number without precision loss`,
      { ...context, ledgerIndex: String(value) },
    );
  }
  return n;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function rowToRecord(row: AttendanceRow): AttendanceRecord {
  return {
    id: String(row.id),
    eventId: row.event_id,
    // Verbatim. See the note on address handling in insert().
    address: row.address,
    nftokenId: row.nftoken_id,
    offerId: row.offer_id,
    txHash: row.tx_hash,
    ledgerIndex: toLedgerIndex(row.ledger_index, { txHash: row.tx_hash }),
    claimedAt: toDate(row.claimed_at),
  };
}

/** Clamps caller-supplied paging into something a query planner can live with. */
export function normalizePaging(opts?: { limit?: number; offset?: number }): {
  limit: number;
  offset: number;
} {
  const rawLimit = opts?.limit;
  const rawOffset = opts?.offset;

  const limit =
    rawLimit === undefined || !Number.isFinite(rawLimit)
      ? DEFAULT_PAGE_LIMIT
      : Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_PAGE_LIMIT);

  const offset =
    rawOffset === undefined || !Number.isFinite(rawOffset)
      ? 0
      : Math.max(Math.trunc(rawOffset), 0);

  return { limit, offset };
}

export class PgAttendanceRepository implements AttendanceRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Writes one claim.
   *
   * ADDRESS HANDLING: addresses are stored **verbatim**. XRPL classic
   * addresses are base58 and case-sensitive — `rHb9CJ...` and `rhb9cj...` are
   * different strings and only one of them is a real account. Lowercasing is
   * the reflex you bring from Ethereum's hex addresses, and here it would
   * silently break every lookup and quietly corrupt the index. Do not
   * normalise case, do not trim beyond what the caller passed. Validation of
   * the address itself belongs to the xrpl layer, not to the index.
   */
  async insert(record: AttendanceRecord): Promise<AttendanceRecord> {
    const ledgerIndex = toLedgerIndex(record.ledgerIndex, {
      txHash: record.txHash,
      eventId: record.eventId,
    });

    try {
      const res = await this.db.query(
        `INSERT INTO attendance
           (event_id, address, nftoken_id, offer_id, tx_hash, ledger_index, claimed_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
         RETURNING ${COLUMNS}`,
        [
          record.eventId,
          record.address,
          record.nftokenId,
          record.offerId ?? null,
          record.txHash,
          // bigint parameters go over the wire as text; never as a float.
          String(ledgerIndex),
          record.claimedAt ?? null,
        ],
      );

      const row = res.rows[0] as AttendanceRow | undefined;
      if (!row) {
        throw new XrplLayerError(
          "LEDGER_QUERY_FAILED",
          "INSERT INTO attendance returned no row",
          { eventId: record.eventId, txHash: record.txHash },
        );
      }
      return rowToRecord(row);
    } catch (err) {
      // A second claim attempt is an expected condition, not a 500. The API
      // layer turns DUPLICATE_CLAIM into a 409 and, usually, into "you already
      // have this badge" rather than an error at all.
      if (isUniqueViolation(err)) {
        throw violatedTxHash(err)
          ? new XrplLayerError(
              "DUPLICATE_CLAIM",
              `Transaction ${record.txHash} is already recorded as an attendance. ` +
                "One NFTokenAcceptOffer is one attendance.",
              {
                constraint: "tx_hash",
                txHash: record.txHash,
                eventId: record.eventId,
                address: record.address,
              },
            )
          : new XrplLayerError(
              "DUPLICATE_CLAIM",
              `Address ${record.address} already has an attendance record for event ${record.eventId}.`,
              {
                constraint: "event_id,address",
                eventId: record.eventId,
                address: record.address,
                txHash: record.txHash,
              },
            );
      }
      throw err;
    }
  }

  async findByEventAndAddress(
    eventId: EventId,
    address: string,
  ): Promise<AttendanceRecord | null> {
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM attendance WHERE event_id = $1 AND address = $2 LIMIT 1`,
      [eventId, address],
    );
    const row = res.rows[0] as AttendanceRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async listByEvent(
    eventId: EventId,
    opts?: { limit?: number; offset?: number },
  ): Promise<AttendanceRecord[]> {
    const { limit, offset } = normalizePaging(opts);
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM attendance WHERE event_id = $1 ${ORDER_BY} LIMIT $2 OFFSET $3`,
      [eventId, limit, offset],
    );
    return (res.rows as AttendanceRow[]).map(rowToRecord);
  }

  async countByEvent(eventId: EventId): Promise<number> {
    const res = await this.db.query(
      "SELECT count(*)::text AS n FROM attendance WHERE event_id = $1",
      [eventId],
    );
    const row = res.rows[0] as { n: string } | undefined;
    return row ? Number(row.n) : 0;
  }

  /** "Which events did this wallet attend?" Backed by attendance_address_idx. */
  async listByAddress(address: string): Promise<AttendanceRecord[]> {
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM attendance WHERE address = $1 ${ORDER_BY}`,
      [address],
    );
    return (res.rows as AttendanceRow[]).map(rowToRecord);
  }
}
