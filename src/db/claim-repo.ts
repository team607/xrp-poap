/**
 * The claim slot (finding 2): taken before anything is minted.
 *
 * ---------------------------------------------------------------------------
 * THIS TABLE IS THE MINT GUARD. THE ATTENDANCE TABLE CANNOT BE.
 *
 * Attendance is written only after the attendee signs the NFTokenAcceptOffer,
 * which is minutes after the mint and may never happen at all. Deduping a
 * claim request against it therefore dedupes nothing: six unconfirmed claims
 * for one (event, address) minted six badges, opened six offers, wrote zero
 * attendance rows and returned six 201s. Each open NFTokenOffer locks 0.2 XRP
 * of the issuer's reserve (brief section 7), so a 10 XRP float is gone after
 * fifty unfinished claims.
 *
 * `open()` takes the slot first, and UNIQUE (event_id, address) decides the
 * race. A null return is the expected answer for the losers, not an error:
 * find() the existing claim and hand back the offer it already has. Never mint
 * a second badge for a slot that is taken.
 * ---------------------------------------------------------------------------
 *
 * Unlike the attendance index this is not a cache of the ledger — it is our own
 * workflow state, and `offer_id` here is the only record of an abandoned offer
 * that the sweeper can cancel to get the 0.2 XRP back.
 */
import { NotFoundError } from "../errors.js";
import type { ClaimRecord, ClaimRepository, ClaimStatus, EventId } from "../types.js";
import { normalizePaging } from "./attendance-repo.js";
import type { Queryable } from "./pool.js";

interface ClaimRow {
  id: string | number;
  event_id: number;
  address: string;
  nftoken_id: string | null;
  offer_id: string | null;
  status: string;
  created_at: Date | string;
  expires_at: Date | string | null;
}

const COLUMNS =
  "id, event_id, address, nftoken_id, offer_id, status, created_at, expires_at";

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    !!err && typeof err === "object" && (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/** Ids are `claims.id` (bigserial) as text; anything else cannot name a row. */
function isClaimId(id: string): boolean {
  return /^\d+$/.test(id);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function rowToRecord(row: ClaimRow): ClaimRecord {
  return {
    id: String(row.id),
    eventId: row.event_id,
    // Verbatim: XRPL classic addresses are case-sensitive base58.
    address: row.address,
    nftokenId: row.nftoken_id,
    offerId: row.offer_id,
    status: row.status as ClaimStatus,
    createdAt: toDate(row.created_at),
    expiresAt: row.expires_at === null ? null : toDate(row.expires_at),
  };
}

export class PgClaimRepository implements ClaimRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Takes the (eventId, address) slot, atomically.
   *
   * Returns null when the slot is already taken. That is the constraint doing
   * its job under concurrency, so it is a value and not a throw — the caller
   * reuses the existing claim's offer rather than minting again.
   */
  async open(input: {
    eventId: EventId;
    address: string;
    expiresAt?: Date;
  }): Promise<ClaimRecord | null> {
    try {
      // ON CONFLICT reopens an abandoned slot in the same statement, so it
      // stays atomic against a concurrent caller. A claim the reaper closed
      // out means the attendee never signed in time and their offer was
      // cancelled — refusing them here would lock a slow attendee out of the
      // event permanently. Live rows (pending/claimed) are left untouched and
      // the DO UPDATE does not match, so open() returns null for those.
      const res = await this.db.query(
        `INSERT INTO claims (event_id, address, expires_at)
         VALUES ($1, $2, $3::timestamptz)
         ON CONFLICT (event_id, address) DO UPDATE
           SET status     = 'pending',
               expires_at = EXCLUDED.expires_at,
               nftoken_id = NULL,
               offer_id   = NULL,
               created_at = now()
           WHERE claims.status = 'abandoned'
         RETURNING ${COLUMNS}`,
        [input.eventId, input.address, input.expiresAt ?? null],
      );
      const row = res.rows[0] as ClaimRow | undefined;
      return row ? rowToRecord(row) : null;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async find(eventId: EventId, address: string): Promise<ClaimRecord | null> {
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM claims WHERE event_id = $1 AND address = $2 LIMIT 1`,
      [eventId, address],
    );
    const row = res.rows[0] as ClaimRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Records what the mint and the offer produced.
   *
   * COALESCE, not assignment: an absent field leaves the stored value alone, so
   * attaching the offer id later cannot blank the nftoken id. Neither field can
   * be cleared through here, which is deliberate — an offer id is the handle on
   * 0.2 XRP and losing it strands the reserve.
   */
  async attach(id: string, patch: { nftokenId?: string; offerId?: string }): Promise<void> {
    await this.mustUpdate(
      id,
      `UPDATE claims
          SET nftoken_id = COALESCE($2, nftoken_id),
              offer_id   = COALESCE($3, offer_id)
        WHERE id = $1::bigint
       RETURNING id`,
      [id, patch.nftokenId ?? null, patch.offerId ?? null],
      "attach",
    );
  }

  async markClaimed(id: string): Promise<void> {
    await this.mustUpdate(
      id,
      "UPDATE claims SET status = 'claimed' WHERE id = $1::bigint RETURNING id",
      [id],
      "markClaimed",
    );
  }

  async markAbandoned(id: string): Promise<void> {
    await this.mustUpdate(
      id,
      "UPDATE claims SET status = 'abandoned' WHERE id = $1::bigint RETURNING id",
      [id],
      "markAbandoned",
    );
  }

  /**
   * Pending claims past expiry whose offer is still open.
   *
   * `offer_id IS NOT NULL` is not a nicety: those are precisely the rows that
   * each hold 0.2 XRP of the issuer's reserve hostage. A pending claim that
   * never got as far as an offer costs nothing and is not the sweeper's
   * problem. Oldest first, so a capped sweep frees the longest-held reserves.
   */
  async listExpired(now: Date, limit?: number): Promise<ClaimRecord[]> {
    const { limit: capped } = normalizePaging({ limit });
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM claims
        WHERE status = 'pending'
          AND offer_id IS NOT NULL
          AND expires_at IS NOT NULL
          AND expires_at < $1::timestamptz
        ORDER BY expires_at ASC, id ASC
        LIMIT $2`,
      [now, capped],
    );
    return (res.rows as ClaimRow[]).map(rowToRecord);
  }

  /**
   * Frees the slot. Used when the mint itself failed — without this the
   * attendee is locked out of their badge by a row describing nothing.
   * Silent on an id that is already gone, so a retried cleanup cannot fail.
   */
  async delete(id: string): Promise<void> {
    if (!isClaimId(id)) return;
    await this.db.query("DELETE FROM claims WHERE id = $1::bigint", [id]);
  }

  /**
   * Runs a mutation that must hit a row. A missing claim here means the caller
   * is holding an id for something that no longer exists, which is a bug worth
   * a stack trace rather than a silent no-op.
   */
  private async mustUpdate(
    id: string,
    sql: string,
    values: unknown[],
    op: string,
  ): Promise<void> {
    if (isClaimId(id)) {
      const res = await this.db.query(sql, values);
      if (res.rows.length > 0) return;
    }
    throw new NotFoundError(`No claim ${id} to ${op}.`, { id, op });
  }
}
