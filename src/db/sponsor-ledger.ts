/**
 * Backing store for the sponsorship guards in brief section 5.4.
 *
 * "Anyone who can hit it with an arbitrary address can drain the issuer wallet
 * 1.5 XRP at a time." Two guards stand between an open endpoint and an empty
 * issuer, and both are answered from this table:
 *
 *   1. one sponsorship per event code per address  -> UNIQUE (event_id, address)
 *   2. a hard daily cap on total sponsored XRP     -> SUM over the UTC day
 *
 * ---------------------------------------------------------------------------
 * TWO-PHASE, AND THE ORDER IS THE WHOLE POINT.
 *
 * The obvious shape — check the guards, send the Payment, record the row — is
 * a drain. Both guards are reads, so N concurrent callers all read the
 * pre-payment state, all pass, and all pay. Measured against a real Postgres:
 * five simultaneous claims for one new address sent five Payments and recorded
 * one row (6 XRP gone, invisible to the cap, four callers told "already
 * sponsored"); twenty simultaneous claims for distinct addresses against a
 * 3 XRP cap sent 30 XRP.
 *
 * So the row is written BEFORE the money moves:
 *
 *   reserve()  books the spend. Atomic, cap included. Payment not yet sent.
 *   confirm()  attaches the hash of a Payment that validated.
 *   release()  deletes a reservation whose Payment never landed.
 *
 * A reserved row counts against the cap exactly like a confirmed one. Money in
 * flight is money spent, and a lost race must cost headroom rather than XRP.
 * ---------------------------------------------------------------------------
 *
 * Unlike the attendance index this is not a cache of the ledger. Sponsorship
 * spend is genuinely gone from the issuer's control (section 7), so this table
 * is the only place the running total lives.
 *
 * Money is handled as integer drops in BigInt from end to end. No floats.
 */
import { xrpToDrops } from "xrpl";
import { NotFoundError, SponsorshipDeniedError, ValidationError } from "../errors.js";
import type {
  EventId,
  SponsorLedger,
  SponsorReservation,
  SponsorReserveInput,
} from "../types.js";
import { withTransaction, type Queryable } from "./pool.js";

export const DROPS_PER_XRP = 1_000_000n;

/**
 * Exact drops -> decimal XRP string.
 *
 * `dropsToXrp` from xrpl returns a **number**. That is a float, and this value
 * is compared against a spend cap, so we render the digits from the BigInt
 * instead: 1500000 + 1500000 drops must read "3", never "2.9999999999999996",
 * and 100000 + 200000 must read "0.3". The float is fine for a log line and
 * wrong for a guard.
 *
 * `xrpToDrops` from xrpl is still used on the way in — it does the decimal
 * parse and rejects sub-drop precision, which is exactly the part worth
 * borrowing.
 */
export function dropsToXrpString(drops: bigint): string {
  const negative = drops < 0n;
  const abs = negative ? -drops : drops;

  const whole = abs / DROPS_PER_XRP;
  const fraction = abs % DROPS_PER_XRP;

  let out = whole.toString();
  if (fraction > 0n) {
    out += `.${fraction.toString().padStart(6, "0").replace(/0+$/, "")}`;
  }
  return negative ? `-${out}` : out;
}

/** Decimal XRP string -> integer drops. Rejects anything that is not money. */
export function xrpToDropsBigInt(amountXrp: string): bigint {
  let drops: string;
  try {
    drops = xrpToDrops(amountXrp);
  } catch (err) {
    throw new ValidationError(
      "INVALID_INPUT",
      `sponsorship amountXrp "${amountXrp}" is not a valid XRP decimal amount`,
      { amountXrp, cause: (err as Error).message },
    );
  }

  const value = BigInt(drops);
  if (value < 0n) {
    throw new ValidationError(
      "INVALID_INPUT",
      `sponsorship amountXrp "${amountXrp}" is negative`,
      { amountXrp },
    );
  }
  return value;
}

/**
 * Start of the current UTC day, as a timestamptz-comparable expression.
 *
 * `date_trunc('day', now() at time zone 'utc')` yields a *naive* timestamp.
 * Comparing that against a timestamptz column makes Postgres reinterpret it in
 * the session TimeZone, which silently shifts the window on any server that is
 * not set to UTC. The trailing `at time zone 'utc'` converts it back to an
 * instant, which is what the cap actually means.
 */
const UTC_DAY_START = "(date_trunc('day', now() at time zone 'utc') at time zone 'utc')";

/**
 * Advisory-lock key for the daily-cap path.
 *
 * The value is arbitrary; that every reserve() in every process takes THE SAME
 * key is not. 0x53504F4E53 spells "SPONS" in ASCII, so a collision with some
 * other subsystem's key is recognisable at a glance in pg_locks.
 */
export const SPONSOR_CAP_LOCK_KEY = 0x53504f4e53n;

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    !!err && typeof err === "object" && (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

function violatedTxHash(err: unknown): boolean {
  const pg = (err ?? {}) as { constraint?: string; detail?: string };
  const constraint = pg.constraint ?? "";
  if (constraint.includes("tx_hash")) return true;
  if (constraint.includes("event_id") || constraint.includes("event_address")) return false;
  return /key \(tx_hash\)/i.test(pg.detail ?? "");
}

/**
 * Reservation ids are `sponsorship.id` (bigserial) rendered as text. Anything
 * else cannot name a row, and feeding it to `$1::bigint` would raise a syntax
 * error where "no such reservation" is the honest answer.
 */
function isReservationId(id: string): boolean {
  return /^\d+$/.test(id);
}

/** SUM over the current UTC day, counting reserved and confirmed alike. */
const SPENT_TODAY_DROPS = `(SELECT COALESCE(SUM(amount_drops), 0) FROM sponsorship
                             WHERE sponsored_at >= ${UTC_DAY_START})`;

export class PgSponsorLedger implements SponsorLedger {
  constructor(private readonly db: Queryable) {}

  /** Guard one. Addresses are compared verbatim — base58 is case-sensitive. */
  async hasSponsored(eventId: EventId, address: string): Promise<boolean> {
    // Reserved rows count. An in-flight sponsorship has already claimed this
    // address's slot, and reporting it as free is how a second Payment gets
    // sent while the first is still on the wire.
    const res = await this.db.query(
      "SELECT 1 FROM sponsorship WHERE event_id = $1 AND address = $2 LIMIT 1",
      [eventId, address],
    );
    return res.rows.length > 0;
  }

  /** Guard two. Sums drops, returns exact decimal XRP. */
  async sponsoredTodayXrp(): Promise<string> {
    const res = await this.db.query(
      // ::text keeps the numeric SUM out of a JS float on the way home.
      `SELECT ${SPENT_TODAY_DROPS}::text AS drops`,
    );
    const row = res.rows[0] as { drops: string } | undefined;
    return dropsToXrpString(BigInt(row?.drops ?? "0"));
  }

  /**
   * Books a spend. Returns null when the address already holds a slot for this
   * event, or when the cap would be crossed.
   *
   * ATOMICITY, both halves:
   *
   *   per-address — UNIQUE (event_id, address). The database decides the race;
   *   the loser gets 23505, which is the expected outcome and not an error.
   *
   *   cap — `INSERT ... SELECT ... WHERE (SELECT SUM(...)) + amt <= cap` looks
   *   atomic and is not. At READ COMMITTED, two transactions each read the sum
   *   before either commits, both see headroom, and both insert; the statement
   *   is atomic with respect to the rows it *reads*, and the rows the other
   *   transaction is about to write are not visible to be read. Nothing in the
   *   statement makes them wait for each other. So reserve() takes a
   *   transaction-scoped advisory lock on one fixed key first, which serialises
   *   the sum-and-insert across every process pointed at this database. It is
   *   held until COMMIT or ROLLBACK, so it cannot be leaked by a crash.
   *
   * Serialising every reservation behind one lock is fine here and deliberate:
   * sponsorships are rare, each one is followed by a network round trip that
   * dwarfs the lock, and a queue is the correct behaviour for a shared budget.
   */
  async reserve(input: SponsorReserveInput): Promise<SponsorReservation | null> {
    const drops = xrpToDropsBigInt(input.amountXrp);
    const capDrops = xrpToDropsBigInt(input.dailyCapXrp);

    let id: string | null;
    try {
      id = await withTransaction(this.db, async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          SPONSOR_CAP_LOCK_KEY.toString(),
        ]);

        const res = await tx.query(
          `INSERT INTO sponsorship (event_id, address, amount_drops, tx_hash, status)
           SELECT $1::integer, $2::text, $3::bigint, NULL, 'reserved'
            WHERE ${SPENT_TODAY_DROPS} + $3::bigint <= $4::bigint
           RETURNING id`,
          // bigint parameters as text: a JS number would cap out at 2^53.
          [input.eventId, input.address, drops.toString(), capDrops.toString()],
        );

        const row = res.rows[0] as { id: string | number } | undefined;
        return row ? String(row.id) : null;
      });
    } catch (err) {
      // The only unique constraint an insert with a NULL tx_hash can hit is
      // (event_id, address): this address already holds a slot, reserved or
      // confirmed. A lost race is the expected case, not a fault.
      if (isUniqueViolation(err)) return null;
      throw err;
    }

    if (id === null) return null; // the WHERE fired: no cap headroom.

    return {
      id,
      eventId: input.eventId,
      address: input.address,
      // Normalised through drops, so "1.50" and "1.5" read back identically.
      amountXrp: dropsToXrpString(drops),
    };
  }

  /**
   * Attaches the hash of a Payment that validated.
   *
   * Idempotent for a repeat of the same hash. A reservation that has vanished
   * is not: the Payment landed, so the spend is real and is now missing from
   * the cap, which is an accounting hole an operator needs told about.
   */
  async confirm(reservationId: string, txHash: string): Promise<void> {
    if (isReservationId(reservationId)) {
      let updated = 0;
      try {
        const res = await this.db.query(
          `UPDATE sponsorship SET status = 'confirmed', tx_hash = $2
            WHERE id = $1::bigint AND status = 'reserved'
           RETURNING id`,
          [reservationId, txHash],
        );
        updated = res.rows.length;
      } catch (err) {
        if (isUniqueViolation(err) && violatedTxHash(err)) {
          throw new SponsorshipDeniedError(
            `Payment ${txHash} is already recorded as a sponsorship.`,
            "duplicate",
            { constraint: "tx_hash", txHash, reservationId },
          );
        }
        throw err;
      }
      if (updated > 0) return;

      const existing = await this.db.query(
        "SELECT status, tx_hash FROM sponsorship WHERE id = $1::bigint",
        [reservationId],
      );
      const row = existing.rows[0] as { status: string; tx_hash: string | null } | undefined;
      if (row?.status === "confirmed" && row.tx_hash === txHash) return;
    }

    throw new NotFoundError(
      `Sponsorship reservation ${reservationId} is not open for confirmation. ` +
        `Payment ${txHash} has landed and is no longer accounted for by the daily cap.`,
      { reservationId, txHash },
    );
  }

  /**
   * Rolls back a reservation whose Payment never landed, freeing both the
   * address slot and the cap headroom.
   *
   * `status = 'reserved'` in the predicate is load-bearing: a stray or repeated
   * release must never erase a confirmed spend from the cap. Silent on an id
   * that is already gone, so a retried cleanup path cannot fail.
   */
  async release(reservationId: string): Promise<void> {
    if (!isReservationId(reservationId)) return;
    await this.db.query(
      "DELETE FROM sponsorship WHERE id = $1::bigint AND status = 'reserved'",
      [reservationId],
    );
  }
}
