/**
 * In-memory stand-ins for the attendance index, the sponsor ledger and the
 * claim slots.
 *
 * These exist so the API layer and local dev run with no Postgres at all, and
 * so the unit suite never needs a database. They are not a toy: the observable
 * semantics are meant to be identical to the pg implementations — same
 * ordering, same paging clamps, same DUPLICATE_CLAIM on a repeat
 * (event_id, address) *or* a repeat tx_hash, same exact-decimal XRP strings,
 * and the same atomicity. src/db/repo-contract.test.ts runs one shared suite
 * against both, which is the only thing that keeps that claim honest.
 *
 * ATOMICITY IN AN EVENT LOOP. A single-threaded runtime is not automatically
 * safe: every `await` is a yield, and a check-then-insert with an await in the
 * middle interleaves exactly like two uncoordinated Postgres transactions. The
 * previous MemorySponsorLedger.record() awaited its own duplicate check before
 * pushing, so five concurrent sponsorships for one address all passed the check
 * and all pushed. The rule below is therefore mechanical rather than stylistic:
 *
 *   reserve() and open() run from their first read to their write with NO
 *   await in between. Do not add one, and do not make a helper they call
 *   async.
 *
 * The same caveat as the real tables applies: the ledger is the source of
 * truth, this is only an index — and this one also dies with the process.
 */
import { NotFoundError, SponsorshipDeniedError, XrplLayerError } from "../errors.js";
import type {
  AttendanceRecord,
  AttendanceRepository,
  ClaimRecord,
  ClaimRepository,
  EventId,
  SponsorLedger,
  SponsorReservation,
  SponsorReserveInput,
} from "../types.js";
import { normalizePaging } from "./attendance-repo.js";
import { dropsToXrpString, xrpToDropsBigInt } from "./sponsor-ledger.js";

/** Mirrors ORDER BY claimed_at ASC, id ASC. */
function byClaimedAtThenId(a: StoredAttendance, b: StoredAttendance): number {
  const delta = a.claimedAt.getTime() - b.claimedAt.getTime();
  return delta !== 0 ? delta : a.seq - b.seq;
}

interface StoredAttendance {
  seq: number;
  record: AttendanceRecord;
  claimedAt: Date;
}

export class MemoryAttendanceRepository implements AttendanceRepository {
  private readonly rows: StoredAttendance[] = [];
  private nextId = 1;

  async insert(record: AttendanceRecord): Promise<AttendanceRecord> {
    if (!Number.isSafeInteger(record.ledgerIndex)) {
      throw new XrplLayerError(
        "LEDGER_QUERY_FAILED",
        `ledger_index ${record.ledgerIndex} cannot be represented as a JS number without precision loss`,
        { txHash: record.txHash, eventId: record.eventId },
      );
    }

    // Postgres evaluates the inline UNIQUE (event_id, address) before the
    // tx_hash index, so check in that order to report the same constraint.
    const duplicateClaim = this.rows.find(
      (r) => r.record.eventId === record.eventId && r.record.address === record.address,
    );
    if (duplicateClaim) {
      throw new XrplLayerError(
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

    const duplicateTx = this.rows.find((r) => r.record.txHash === record.txHash);
    if (duplicateTx) {
      throw new XrplLayerError(
        "DUPLICATE_CLAIM",
        `Transaction ${record.txHash} is already recorded as an attendance. ` +
          "One NFTokenAcceptOffer is one attendance.",
        {
          constraint: "tx_hash",
          txHash: record.txHash,
          eventId: record.eventId,
          address: record.address,
        },
      );
    }

    const seq = this.nextId++;
    const claimedAt = record.claimedAt ?? new Date();
    const stored: StoredAttendance = {
      seq,
      claimedAt,
      record: {
        id: String(seq),
        eventId: record.eventId,
        // Verbatim: XRPL classic addresses are case-sensitive base58.
        address: record.address,
        nftokenId: record.nftokenId,
        offerId: record.offerId ?? null,
        txHash: record.txHash,
        ledgerIndex: record.ledgerIndex,
        claimedAt,
      },
    };
    this.rows.push(stored);
    return clone(stored.record);
  }

  async findByEventAndAddress(
    eventId: EventId,
    address: string,
  ): Promise<AttendanceRecord | null> {
    const hit = this.rows.find(
      (r) => r.record.eventId === eventId && r.record.address === address,
    );
    return hit ? clone(hit.record) : null;
  }

  async listByEvent(
    eventId: EventId,
    opts?: { limit?: number; offset?: number },
  ): Promise<AttendanceRecord[]> {
    const { limit, offset } = normalizePaging(opts);
    return this.rows
      .filter((r) => r.record.eventId === eventId)
      .sort(byClaimedAtThenId)
      .slice(offset, offset + limit)
      .map((r) => clone(r.record));
  }

  async countByEvent(eventId: EventId): Promise<number> {
    return this.rows.filter((r) => r.record.eventId === eventId).length;
  }

  async listByAddress(address: string): Promise<AttendanceRecord[]> {
    return this.rows
      .filter((r) => r.record.address === address)
      .sort(byClaimedAtThenId)
      .map((r) => clone(r.record));
  }

  /** Test/dev affordance. Not part of AttendanceRepository. */
  clear(): void {
    this.rows.length = 0;
    this.nextId = 1;
  }
}

interface StoredSponsorship {
  id: string;
  eventId: EventId;
  address: string;
  drops: bigint;
  /** Null until confirm() attaches the hash of a Payment that validated. */
  txHash: string | null;
  status: "reserved" | "confirmed";
  sponsoredAt: Date;
}

/** Midnight UTC today, matching date_trunc('day', now() at time zone 'utc'). */
function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export class MemorySponsorLedger implements SponsorLedger {
  private readonly entries: StoredSponsorship[] = [];
  private nextId = 1;

  /** Injectable clock so a cap-rollover test does not have to wait for midnight. */
  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Reserved rows count: an in-flight sponsorship already owns the slot. */
  async hasSponsored(eventId: EventId, address: string): Promise<boolean> {
    return this.findSlot(eventId, address) !== undefined;
  }

  async sponsoredTodayXrp(): Promise<string> {
    return dropsToXrpString(this.spentTodayDrops());
  }

  /**
   * Books a spend. Mirrors PgSponsorLedger.reserve(), including the part that
   * matters: the duplicate check, the cap sum and the insert happen in one
   * synchronous run.
   *
   * The two `xrpToDropsBigInt` calls are deliberately hoisted above the check —
   * they are synchronous, but keeping every input conversion before the
   * critical section makes it obvious that nothing between the check and the
   * push can yield.
   */
  async reserve(input: SponsorReserveInput): Promise<SponsorReservation | null> {
    const drops = xrpToDropsBigInt(input.amountXrp);
    const capDrops = xrpToDropsBigInt(input.dailyCapXrp);

    // ---- no await from here to the push ------------------------------------
    if (this.findSlot(input.eventId, input.address)) return null;
    if (this.spentTodayDrops() + drops > capDrops) return null;

    const id = String(this.nextId++);
    this.entries.push({
      id,
      eventId: input.eventId,
      address: input.address,
      drops,
      txHash: null,
      status: "reserved",
      sponsoredAt: this.now(),
    });
    // ---- end of critical section -------------------------------------------

    return {
      id,
      eventId: input.eventId,
      address: input.address,
      amountXrp: dropsToXrpString(drops),
    };
  }

  async confirm(reservationId: string, txHash: string): Promise<void> {
    const row = this.entries.find((e) => e.id === reservationId);

    if (row?.status === "reserved") {
      // Stands in for the UNIQUE (tx_hash) index: one Payment is one
      // sponsorship, across every event.
      if (this.entries.some((e) => e.id !== reservationId && e.txHash === txHash)) {
        throw new SponsorshipDeniedError(
          `Payment ${txHash} is already recorded as a sponsorship.`,
          "duplicate",
          { constraint: "tx_hash", txHash, reservationId },
        );
      }
      row.status = "confirmed";
      row.txHash = txHash;
      return;
    }

    // Confirming the same hash twice is a no-op, not a fault.
    if (row?.status === "confirmed" && row.txHash === txHash) return;

    throw new NotFoundError(
      `Sponsorship reservation ${reservationId} is not open for confirmation. ` +
        `Payment ${txHash} has landed and is no longer accounted for by the daily cap.`,
      { reservationId, txHash },
    );
  }

  /** Only ever deletes a reservation. A confirmed spend stays on the books. */
  async release(reservationId: string): Promise<void> {
    const at = this.entries.findIndex(
      (e) => e.id === reservationId && e.status === "reserved",
    );
    if (at >= 0) this.entries.splice(at, 1);
  }

  private findSlot(eventId: EventId, address: string): StoredSponsorship | undefined {
    return this.entries.find((e) => e.eventId === eventId && e.address === address);
  }

  /** Reserved and confirmed alike: money in flight is money spent. */
  private spentTodayDrops(): bigint {
    const cutoff = startOfUtcDay(this.now()).getTime();
    let total = 0n;
    for (const e of this.entries) {
      if (e.sponsoredAt.getTime() >= cutoff) total += e.drops;
    }
    return total;
  }

  /** Test/dev affordance. Not part of SponsorLedger. */
  clear(): void {
    this.entries.length = 0;
    this.nextId = 1;
  }
}

interface StoredClaim {
  seq: number;
  record: ClaimRecord;
}

/** Mirrors ORDER BY expires_at ASC, id ASC. */
function byExpiryThenId(a: StoredClaim, b: StoredClaim): number {
  const delta =
    (a.record.expiresAt?.getTime() ?? 0) - (b.record.expiresAt?.getTime() ?? 0);
  return delta !== 0 ? delta : a.seq - b.seq;
}

export class MemoryClaimRepository implements ClaimRepository {
  private readonly rows: StoredClaim[] = [];
  private nextId = 1;

  /**
   * Takes the (eventId, address) slot. Null when it is already taken.
   *
   * Same critical-section rule as reserve(): the lookup and the push run
   * without an await between them, so N concurrent callers produce exactly one
   * winner. An await here would let all N pass the lookup and mint N badges.
   */
  async open(input: {
    eventId: EventId;
    address: string;
    expiresAt?: Date;
  }): Promise<ClaimRecord | null> {
    // ---- no await from here to the push ------------------------------------
    const existing = this.findRow(input.eventId, input.address);
    if (existing) {
      // An abandoned slot is reopened, matching PgClaimRepository. The reaper
      // marks a claim abandoned when the attendee never signed and its offer
      // was cancelled; refusing them would lock a slow attendee out for good.
      if (existing.record.status !== "abandoned") return null;
      existing.record.status = "pending";
      existing.record.nftokenId = null;
      existing.record.offerId = null;
      existing.record.createdAt = new Date();
      existing.record.expiresAt = input.expiresAt ?? null;
      // ---- end of critical section -----------------------------------------
      return cloneClaim(existing.record);
    }

    const seq = this.nextId++;
    const stored: StoredClaim = {
      seq,
      record: {
        id: String(seq),
        eventId: input.eventId,
        // Verbatim: XRPL classic addresses are case-sensitive base58.
        address: input.address,
        nftokenId: null,
        offerId: null,
        status: "pending",
        createdAt: new Date(),
        expiresAt: input.expiresAt ?? null,
      },
    };
    this.rows.push(stored);
    // ---- end of critical section -------------------------------------------

    return cloneClaim(stored.record);
  }

  async find(eventId: EventId, address: string): Promise<ClaimRecord | null> {
    const hit = this.findRow(eventId, address);
    return hit ? cloneClaim(hit.record) : null;
  }

  /** Absent fields leave the stored value alone; neither can be cleared. */
  async attach(id: string, patch: { nftokenId?: string; offerId?: string }): Promise<void> {
    const row = this.mustFind(id, "attach");
    if (patch.nftokenId !== undefined) row.record.nftokenId = patch.nftokenId;
    if (patch.offerId !== undefined) row.record.offerId = patch.offerId;
  }

  async markClaimed(id: string): Promise<void> {
    this.mustFind(id, "markClaimed").record.status = "claimed";
  }

  async markAbandoned(id: string): Promise<void> {
    this.mustFind(id, "markAbandoned").record.status = "abandoned";
  }

  /** Pending, past expiry, and still holding the 0.2 XRP of an open offer. */
  async listExpired(now: Date, limit?: number): Promise<ClaimRecord[]> {
    const { limit: capped } = normalizePaging({ limit });
    return this.rows
      .filter(
        (r) =>
          r.record.status === "pending" &&
          r.record.offerId != null &&
          r.record.expiresAt != null &&
          r.record.expiresAt.getTime() < now.getTime(),
      )
      .sort(byExpiryThenId)
      .slice(0, capped)
      .map((r) => cloneClaim(r.record));
  }

  /** Silent on an id that is already gone, so a retried cleanup cannot fail. */
  async delete(id: string): Promise<void> {
    const at = this.rows.findIndex((r) => r.record.id === id);
    if (at >= 0) this.rows.splice(at, 1);
  }

  /** Test/dev affordance. Not part of ClaimRepository. */
  clear(): void {
    this.rows.length = 0;
    this.nextId = 1;
  }

  private findRow(eventId: EventId, address: string): StoredClaim | undefined {
    return this.rows.find(
      (r) => r.record.eventId === eventId && r.record.address === address,
    );
  }

  private mustFind(id: string, op: string): StoredClaim {
    const row = this.rows.find((r) => r.record.id === id);
    if (!row) throw new NotFoundError(`No claim ${id} to ${op}.`, { id, op });
    return row;
  }
}

function cloneClaim(record: ClaimRecord): ClaimRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt.getTime()),
    expiresAt: record.expiresAt ? new Date(record.expiresAt.getTime()) : record.expiresAt,
  };
}

function clone(record: AttendanceRecord): AttendanceRecord {
  return {
    ...record,
    claimedAt: record.claimedAt ? new Date(record.claimedAt.getTime()) : undefined,
  };
}
