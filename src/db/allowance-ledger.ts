/**
 * The book behind every allowance an event's treasury pays.
 *
 * One row per attendee per event, written BEFORE the Payment is submitted and
 * confirmed after it validates — the two-phase shape 003 gave the sponsorship
 * table, for the reason 003 gives. Check-then-pay-then-record pays N times under
 * concurrency and records one; reserve-then-pay loses races in budget headroom
 * and never in XRP.
 *
 * TWO GUARDS, both answered here and both atomic:
 *
 *   once per attendee  UNIQUE (event_id, address). The database decides the
 *                      race; the loser gets null, which is not an error.
 *   the event budget   SUM(amount_drops) for the event, reserved rows included,
 *                      checked by the INSERT itself under an advisory lock on
 *                      the event id — so two desks paying the same event
 *                      cannot both read the same headroom.
 *
 * The old daily cap is gone. It was one number for the whole deployment, and a
 * busy desk at one event could exhaust it for every other event that day.
 *
 * Money is integer drops in BigInt from end to end.
 */
import { NotFoundError, ValidationError, XrplLayerError } from "../errors.js";
import { dropsToXrpString, xrpToDropsBigInt } from "../money.js";
import type {
  AllowanceLedger,
  AllowanceRecord,
  AllowanceReserveInput,
  AllowanceStatus,
  AllowanceSummary,
  EventId,
  EventRepository,
} from "../types.js";
import { assertValidAddress } from "../xrpl/encoding.js";
import { normalizePaging } from "./attendance-repo.js";
import { assertValidEventId, isPossibleEventId } from "./event-repo.js";
import { withTransaction, type Queryable } from "./pool.js";

/**
 * Advisory-lock class for the budget check: "ALLW" in ASCII, fits an int4. The
 * second key is the event id, so events never wait on each other — only two
 * payments against the same event's budget do.
 */
export const ALLOWANCE_LOCK_CLASS = 0x414c4c57;

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" ? (err as { code?: string }).code : undefined;
}

function violatesTxHash(err: unknown): boolean {
  const pg = (err ?? {}) as { constraint?: string; detail?: string };
  if ((pg.constraint ?? "").includes("tx_hash")) return true;
  return /key \(tx_hash\)/i.test(pg.detail ?? "");
}

/** Ids are `allowances.id` (bigserial) as text. Anything else names no row. */
function isAllowanceId(id: string): boolean {
  return /^\d+$/.test(id);
}

function unknownEvent(eventId: EventId): NotFoundError {
  return new NotFoundError(`No event ${eventId} to pay an allowance for.`, { eventId });
}

function hashTaken(id: string, txHash: string): XrplLayerError {
  return new XrplLayerError(
    "CONFLICT",
    `Payment ${txHash} is already recorded as a different allowance.`,
    { id, txHash },
  );
}

function notOpen(id: string, txHash: string): NotFoundError {
  // Loud on purpose: a Payment landed and there is no reservation to account
  // for it, so the event's books are short by one payment.
  return new NotFoundError(
    `Allowance reservation ${id} is not open for confirmation. Payment ${txHash} landed and is ` +
      "not on the event's books.",
    { id, txHash },
  );
}

/** Shared by both implementations: everything the table's CHECKs would refuse. */
function parseReserve(input: AllowanceReserveInput): {
  allowance: bigint;
  topup: bigint;
  amount: bigint;
  budget: bigint;
} {
  assertValidEventId(input.eventId);
  assertValidAddress(input.address, "address");
  assertValidAddress(input.treasuryAddress, "treasury address");
  const allowance = xrpToDropsBigInt(input.allowanceXrp, "allowanceXrp");
  const topup = xrpToDropsBigInt(input.topupXrp, "topupXrp");
  const budget = xrpToDropsBigInt(input.budgetXrp, "budgetXrp");
  const amount = allowance + topup;
  if (amount <= 0n) {
    throw new ValidationError(
      "INVALID_INPUT",
      "An allowance payment must be more than zero. Nothing owed is not a payment.",
      { eventId: input.eventId, address: input.address },
    );
  }
  return { allowance, topup, amount, budget };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface AllowanceRow {
  id: string | number;
  event_id: number;
  address: string;
  allowance_drops: string;
  topup_drops: string;
  amount_drops: string;
  treasury_address: string;
  status: string;
  tx_hash: string | null;
  reserved_at: Date | string;
  confirmed_at: Date | string | null;
}

const COLUMNS =
  "id, event_id, address, allowance_drops::text AS allowance_drops, " +
  "topup_drops::text AS topup_drops, amount_drops::text AS amount_drops, " +
  "treasury_address, status, tx_hash, reserved_at, confirmed_at";

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function rowToAllowance(row: AllowanceRow): AllowanceRecord {
  return {
    id: String(row.id),
    eventId: Number(row.event_id),
    address: row.address,
    allowanceXrp: dropsToXrpString(BigInt(row.allowance_drops)),
    topupXrp: dropsToXrpString(BigInt(row.topup_drops)),
    amountXrp: dropsToXrpString(BigInt(row.amount_drops)),
    treasuryAddress: row.treasury_address,
    status: row.status as AllowanceStatus,
    txHash: row.tx_hash,
    reservedAt: toDate(row.reserved_at),
    confirmedAt: row.confirmed_at === null ? null : toDate(row.confirmed_at),
  };
}

export class PgAllowanceLedger implements AllowanceLedger {
  constructor(private readonly db: Queryable) {}

  async find(eventId: EventId, address: string): Promise<AllowanceRecord | null> {
    if (!isPossibleEventId(eventId)) return null;
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM allowances WHERE event_id = $1 AND address = $2 LIMIT 1`,
      [eventId, address],
    );
    const row = res.rows[0] as AllowanceRow | undefined;
    return row ? rowToAllowance(row) : null;
  }

  /**
   * The budget check and the insert are one statement, inside a transaction
   * that first takes the event's advisory lock. At READ COMMITTED a bare
   * `INSERT ... WHERE (SELECT SUM(...)) + amount <= budget` is NOT atomic: two
   * transactions each read the sum before either commits and both insert. The
   * lock is what makes the second one wait for the first.
   */
  async reserve(input: AllowanceReserveInput): Promise<AllowanceRecord | null> {
    const { allowance, topup, amount, budget } = parseReserve(input);

    let row: AllowanceRow | undefined;
    try {
      row = await withTransaction(this.db, async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock($1::int, $2::int)", [
          ALLOWANCE_LOCK_CLASS,
          input.eventId,
        ]);
        const res = await tx.query(
          `INSERT INTO allowances
             (event_id, address, allowance_drops, topup_drops, amount_drops, treasury_address, status)
           SELECT $1::integer, $2::text, $3::bigint, $4::bigint, $5::bigint, $6::text, 'reserved'
            WHERE (SELECT COALESCE(SUM(amount_drops), 0) FROM allowances WHERE event_id = $1::integer)
                  + $5::bigint <= $7::bigint
           RETURNING ${COLUMNS}`,
          [
            input.eventId,
            input.address,
            allowance.toString(),
            topup.toString(),
            amount.toString(),
            input.treasuryAddress,
            budget.toString(),
          ],
        );
        return res.rows[0] as AllowanceRow | undefined;
      });
    } catch (err) {
      // (event_id, address) is the only unique constraint a NULL tx_hash can hit.
      if (pgCode(err) === UNIQUE_VIOLATION) return null;
      if (pgCode(err) === FOREIGN_KEY_VIOLATION) throw unknownEvent(input.eventId);
      throw err;
    }

    // No row and no error: the WHERE fired, so the budget has no room.
    return row ? rowToAllowance(row) : null;
  }

  async confirm(id: string, txHash: string): Promise<void> {
    if (isAllowanceId(id)) {
      let updated = 0;
      try {
        const res = await this.db.query(
          `UPDATE allowances SET status = 'confirmed', tx_hash = $2, confirmed_at = now()
            WHERE id = $1::bigint AND status = 'reserved'
           RETURNING id`,
          [id, txHash],
        );
        updated = res.rows.length;
      } catch (err) {
        if (pgCode(err) === UNIQUE_VIOLATION && violatesTxHash(err)) throw hashTaken(id, txHash);
        throw err;
      }
      if (updated > 0) return;

      const existing = await this.db.query(
        "SELECT status, tx_hash FROM allowances WHERE id = $1::bigint",
        [id],
      );
      const row = existing.rows[0] as { status: string; tx_hash: string | null } | undefined;
      if (row?.status === "confirmed" && row.tx_hash === txHash) return;
    }
    throw notOpen(id, txHash);
  }

  /** `status = 'reserved'` is load-bearing: a stray release must never erase money that left. */
  async release(id: string): Promise<void> {
    if (!isAllowanceId(id)) return;
    await this.db.query("DELETE FROM allowances WHERE id = $1::bigint AND status = 'reserved'", [id]);
  }

  async summary(eventId: EventId): Promise<AllowanceSummary> {
    if (!isPossibleEventId(eventId)) {
      return { committedXrp: "0", paidXrp: "0", paidCount: 0, inFlightCount: 0 };
    }
    const res = await this.db.query(
      `SELECT COALESCE(SUM(amount_drops), 0)::text AS committed,
              COALESCE(SUM(amount_drops) FILTER (WHERE status = 'confirmed'), 0)::text AS paid,
              COUNT(*) FILTER (WHERE status = 'confirmed')::int AS paid_count,
              COUNT(*) FILTER (WHERE status = 'reserved')::int AS in_flight
         FROM allowances WHERE event_id = $1`,
      [eventId],
    );
    const row = res.rows[0] as
      | { committed: string; paid: string; paid_count: number; in_flight: number }
      | undefined;
    return {
      committedXrp: dropsToXrpString(BigInt(row?.committed ?? "0")),
      paidXrp: dropsToXrpString(BigInt(row?.paid ?? "0")),
      paidCount: Number(row?.paid_count ?? 0),
      inFlightCount: Number(row?.in_flight ?? 0),
    };
  }

  async listByEvent(
    eventId: EventId,
    opts?: { limit?: number; offset?: number; status?: AllowanceStatus },
  ): Promise<AllowanceRecord[]> {
    if (!isPossibleEventId(eventId)) return [];
    const { limit, offset } = normalizePaging(opts);
    const values: unknown[] = [eventId, limit, offset];
    let where = "event_id = $1";
    if (opts?.status !== undefined) {
      values.push(opts.status);
      where += " AND status = $4";
    }
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM allowances WHERE ${where} ORDER BY id DESC LIMIT $2 OFFSET $3`,
      values,
    );
    return (res.rows as AllowanceRow[]).map(rowToAllowance);
  }
}

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

interface StoredAllowance {
  seq: number;
  eventId: EventId;
  address: string;
  allowance: bigint;
  topup: bigint;
  treasuryAddress: string;
  status: AllowanceStatus;
  txHash: string | null;
  reservedAt: Date;
  confirmedAt: Date | null;
}

/**
 * The in-memory twin, held to the same contract suite.
 *
 * Same critical-section rule as every memory store: reserve() runs from its
 * duplicate check to its push with no await in between. The event lookup that
 * stands in for the foreign key is awaited BEFORE that section starts.
 */
export class MemoryAllowanceLedger implements AllowanceLedger {
  private readonly rows: StoredAllowance[] = [];
  private nextId = 1;
  private readonly events: Pick<EventRepository, "find"> | undefined;
  private readonly now: () => Date;

  constructor(opts: { events?: Pick<EventRepository, "find">; now?: () => Date } = {}) {
    this.events = opts.events;
    this.now = opts.now ?? (() => new Date());
  }

  async find(eventId: EventId, address: string): Promise<AllowanceRecord | null> {
    const row = this.rows.find((r) => r.eventId === eventId && r.address === address);
    return row ? toRecord(row) : null;
  }

  async reserve(input: AllowanceReserveInput): Promise<AllowanceRecord | null> {
    const { allowance, topup, amount, budget } = parseReserve(input);
    if (this.events && !(await this.events.find(input.eventId))) throw unknownEvent(input.eventId);

    // ---- no await from here to the push ------------------------------------
    if (this.rows.some((r) => r.eventId === input.eventId && r.address === input.address)) {
      return null;
    }
    if (this.committed(input.eventId) + amount > budget) return null;

    const stored: StoredAllowance = {
      seq: this.nextId++,
      eventId: input.eventId,
      address: input.address,
      allowance,
      topup,
      treasuryAddress: input.treasuryAddress,
      status: "reserved",
      txHash: null,
      reservedAt: this.now(),
      confirmedAt: null,
    };
    this.rows.push(stored);
    // ---- end of critical section --------------------------------------------

    return toRecord(stored);
  }

  async confirm(id: string, txHash: string): Promise<void> {
    const row = this.rows.find((r) => String(r.seq) === id);
    if (row?.status === "reserved") {
      // Stands in for UNIQUE (tx_hash): one Payment is one allowance.
      if (this.rows.some((r) => r !== row && r.txHash === txHash)) throw hashTaken(id, txHash);
      row.status = "confirmed";
      row.txHash = txHash;
      row.confirmedAt = this.now();
      return;
    }
    if (row?.status === "confirmed" && row.txHash === txHash) return;
    throw notOpen(id, txHash);
  }

  async release(id: string): Promise<void> {
    const at = this.rows.findIndex((r) => String(r.seq) === id && r.status === "reserved");
    if (at >= 0) this.rows.splice(at, 1);
  }

  async summary(eventId: EventId): Promise<AllowanceSummary> {
    let paid = 0n;
    let paidCount = 0;
    let inFlightCount = 0;
    for (const r of this.rows) {
      if (r.eventId !== eventId) continue;
      if (r.status === "confirmed") {
        paid += r.allowance + r.topup;
        paidCount += 1;
      } else {
        inFlightCount += 1;
      }
    }
    return {
      committedXrp: dropsToXrpString(this.committed(eventId)),
      paidXrp: dropsToXrpString(paid),
      paidCount,
      inFlightCount,
    };
  }

  async listByEvent(
    eventId: EventId,
    opts?: { limit?: number; offset?: number; status?: AllowanceStatus },
  ): Promise<AllowanceRecord[]> {
    const { limit, offset } = normalizePaging(opts);
    return this.rows
      .filter((r) => r.eventId === eventId && (opts?.status === undefined || r.status === opts.status))
      .sort((a, b) => b.seq - a.seq)
      .slice(offset, offset + limit)
      .map(toRecord);
  }

  /** Reserved and confirmed alike. Synchronous, so reserve() can call it inside its critical section. */
  private committed(eventId: EventId): bigint {
    let total = 0n;
    for (const r of this.rows) if (r.eventId === eventId) total += r.allowance + r.topup;
    return total;
  }
}

function toRecord(row: StoredAllowance): AllowanceRecord {
  return {
    id: String(row.seq),
    eventId: row.eventId,
    address: row.address,
    allowanceXrp: dropsToXrpString(row.allowance),
    topupXrp: dropsToXrpString(row.topup),
    amountXrp: dropsToXrpString(row.allowance + row.topup),
    treasuryAddress: row.treasuryAddress,
    status: row.status,
    txHash: row.txHash,
    reservedAt: new Date(row.reservedAt.getTime()),
    confirmedAt: row.confirmedAt ? new Date(row.confirmedAt.getTime()) : null,
  };
}
