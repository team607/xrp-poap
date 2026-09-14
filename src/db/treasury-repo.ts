/**
 * Where each event's treasury wallet is kept: its address in the clear, its
 * seed sealed.
 *
 * Nothing in this file can open a seal, and nothing here ever puts a sealed
 * seed into an error or a log line. Opening happens in src/treasury/vault.ts,
 * at the moment of paying, and nowhere else.
 */
import { NotFoundError, ValidationError, XrplLayerError } from "../errors.js";
import type { EventId, EventRepository, TreasuryRecord, TreasuryRepository } from "../types.js";
import { assertValidAddress } from "../xrpl/encoding.js";
import { assertValidEventId, isPossibleEventId } from "./event-repo.js";
import type { Queryable } from "./pool.js";

interface TreasuryRow {
  event_id: number;
  address: string;
  sealed_seed: string;
  created_at: Date | string;
}

const COLUMNS = "event_id, address, sealed_seed, created_at";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" ? (err as { code?: string }).code : undefined;
}

function rowToTreasury(row: TreasuryRow): TreasuryRecord {
  return {
    eventId: Number(row.event_id),
    address: row.address,
    sealedSeed: row.sealed_seed,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

function unknownEvent(eventId: EventId): NotFoundError {
  return new NotFoundError(`No event ${eventId} to give a treasury to.`, { eventId });
}

function addressTaken(eventId: EventId, address: string): XrplLayerError {
  return new XrplLayerError(
    "CONFLICT",
    `Treasury address ${address} already belongs to another event.`,
    { eventId, address },
  );
}

/**
 * Shared by both implementations. The seed check is a guard against a caller
 * handing over a plaintext seed by mistake: a treasury row only ever holds a
 * sealed one, and the error deliberately does not echo what it was given.
 */
function assertStorable(record: Omit<TreasuryRecord, "createdAt">): void {
  assertValidEventId(record.eventId);
  assertValidAddress(record.address, "treasury address");
  if (typeof record.sealedSeed !== "string" || !record.sealedSeed.startsWith("v1.")) {
    throw new ValidationError(
      "INVALID_INPUT",
      `The treasury seed for event ${record.eventId} is not sealed. Treasury seeds are only ever stored sealed.`,
      { eventId: record.eventId },
    );
  }
}

export class PgTreasuryRepository implements TreasuryRepository {
  constructor(private readonly db: Queryable) {}

  async find(eventId: EventId): Promise<TreasuryRecord | null> {
    if (!isPossibleEventId(eventId)) return null;
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM event_treasuries WHERE event_id = $1 LIMIT 1`,
      [eventId],
    );
    const row = res.rows[0] as TreasuryRow | undefined;
    return row ? rowToTreasury(row) : null;
  }

  /**
   * `ON CONFLICT (event_id) DO NOTHING`, then read back: two instances
   * backfilling the same event both finish with the row the first one wrote.
   */
  async insertIfAbsent(
    record: Omit<TreasuryRecord, "createdAt">,
  ): Promise<{ record: TreasuryRecord; created: boolean }> {
    assertStorable(record);

    let inserted: TreasuryRow | undefined;
    try {
      const res = await this.db.query(
        `INSERT INTO event_treasuries (event_id, address, sealed_seed)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [record.eventId, record.address, record.sealedSeed],
      );
      inserted = res.rows[0] as TreasuryRow | undefined;
    } catch (err) {
      if (pgCode(err) === FOREIGN_KEY_VIOLATION) throw unknownEvent(record.eventId);
      // Only the address constraint can still fire past ON CONFLICT (event_id).
      if (pgCode(err) === UNIQUE_VIOLATION) throw addressTaken(record.eventId, record.address);
      throw err;
    }

    if (inserted) return { record: rowToTreasury(inserted), created: true };

    const existing = await this.find(record.eventId);
    if (!existing) {
      throw new XrplLayerError(
        "LEDGER_QUERY_FAILED",
        `Event ${record.eventId} has a treasury that could not be read back.`,
        { eventId: record.eventId },
      );
    }
    return { record: existing, created: false };
  }
}

/** The in-memory twin. Same first-writer-wins rule, same foreign key. */
export class MemoryTreasuryRepository implements TreasuryRepository {
  private readonly rows = new Map<EventId, TreasuryRecord>();

  constructor(
    private readonly events?: Pick<EventRepository, "find">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async find(eventId: EventId): Promise<TreasuryRecord | null> {
    const row = this.rows.get(eventId);
    return row ? clone(row) : null;
  }

  /** The foreign-key read is awaited first; the check and the set do not yield. */
  async insertIfAbsent(
    record: Omit<TreasuryRecord, "createdAt">,
  ): Promise<{ record: TreasuryRecord; created: boolean }> {
    assertStorable(record);
    if (this.events && !(await this.events.find(record.eventId))) {
      throw unknownEvent(record.eventId);
    }

    // ---- no await from here to the set -------------------------------------
    const existing = this.rows.get(record.eventId);
    if (existing) return { record: clone(existing), created: false };
    for (const row of this.rows.values()) {
      if (row.address === record.address) throw addressTaken(record.eventId, record.address);
    }
    const stored: TreasuryRecord = {
      eventId: record.eventId,
      address: record.address,
      sealedSeed: record.sealedSeed,
      createdAt: this.now(),
    };
    this.rows.set(record.eventId, stored);
    // ---- end of critical section --------------------------------------------

    return { record: clone(stored), created: true };
  }
}

function clone(record: TreasuryRecord): TreasuryRecord {
  return {
    ...record,
    createdAt: record.createdAt ? new Date(record.createdAt.getTime()) : undefined,
  };
}
