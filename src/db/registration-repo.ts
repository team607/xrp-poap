/**
 * Registrations: who signed up, and who a volunteer waved through the door.
 *
 * ---------------------------------------------------------------------------
 * THREE DIFFERENT FACTS, THREE DIFFERENT TABLES.
 *
 *   registrations  — an intention. Someone said they were coming and gave us
 *                    an address, ideally one a Xaman SignIn proved they hold.
 *   checked_in_at  — an observation. A human at a desk saw them arrive.
 *   attendance     — a transaction. The ledger says they accepted a badge.
 *
 * None of the three implies another and none can be derived from another. A
 * registration with no check-in is a no-show; a check-in with no attendance is
 * someone whose wallet failed at the desk and who an organiser still owes a
 * badge. Collapsing any pair of them destroys the answer to a question that
 * gets asked the morning after every event.
 * ---------------------------------------------------------------------------
 *
 * Addresses are stored verbatim. XRPL classic addresses are case-sensitive
 * base58 — see the note in 006_registrations.sql. Nothing here folds case.
 */
import { NotFoundError, ValidationError, XrplLayerError } from "../errors.js";
import type {
  AddressProof,
  EventId,
  RegistrationRecord,
  RegistrationRepository,
} from "../types.js";
import { normalizePaging } from "./attendance-repo.js";
import { isPossibleEventId } from "./event-repo.js";
import type { Queryable } from "./pool.js";

interface RegistrationRow {
  id: string | number;
  event_id: number;
  address: string;
  address_proof: string;
  display_name: string | null;
  email: string | null;
  signin_payload_uuid: string | null;
  registered_at: Date | string;
  checked_in_at: Date | string | null;
}

const COLUMNS =
  "id, event_id, address, address_proof, display_name, email, signin_payload_uuid, " +
  "registered_at, checked_in_at";

/**
 * Sign-up order, with a stable tie-break on id. registered_at alone is not
 * enough: two people can register in the same millisecond, and a page boundary
 * that lands between them would repeat one and skip the other.
 */
const ORDER_BY = "ORDER BY registered_at ASC, id ASC";

const PROOFS: readonly AddressProof[] = ["xaman_signin", "self_declared"];

/** Postgres unique_violation / foreign_key_violation. */
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" ? (err as { code?: string }).code : undefined;
}

/** Ids are `registrations.id` (bigserial) as text; anything else names no row. */
export function isRegistrationId(id: string): boolean {
  return /^\d+$/.test(id);
}

export function assertValidAddressProof(proof: unknown): asserts proof is AddressProof {
  if (typeof proof !== "string" || !PROOFS.includes(proof as AddressProof)) {
    throw new ValidationError(
      "INVALID_INPUT",
      `addressProof must be one of ${PROOFS.join(" | ")}, got ${JSON.stringify(proof)}`,
      { addressProof: proof },
    );
  }
}

export function assertRegistrationAddress(address: unknown): asserts address is string {
  if (typeof address !== "string" || address.trim() === "") {
    throw new ValidationError("INVALID_INPUT", "registration address is required", { address });
  }
}

/**
 * A second sign-up for the same wallet at the same event.
 *
 * Expected, not exceptional: a refreshed form, a double-tapped button, a
 * retried request after a timeout. The API layer turns this into "you are
 * already registered" and a 409, never a 500.
 */
export function duplicateRegistrationError(
  eventId: EventId,
  address: string,
): XrplLayerError {
  return new XrplLayerError(
    "DUPLICATE_CLAIM",
    `Address ${address} is already registered for event ${eventId}.`,
    { constraint: "event_id,address", eventId, address },
  );
}

/** The foreign key firing: there is no such event to register for. */
export function unknownEventError(eventId: EventId): NotFoundError {
  return new NotFoundError(
    `No event ${eventId} to register for. Create the event before taking sign-ups.`,
    { eventId, constraint: "registrations_event_id_fkey" },
  );
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function rowToRegistration(row: RegistrationRow): RegistrationRecord {
  return {
    id: String(row.id),
    eventId: row.event_id,
    // Verbatim: XRPL classic addresses are case-sensitive base58.
    address: row.address,
    addressProof: row.address_proof as AddressProof,
    displayName: row.display_name,
    email: row.email,
    signinPayloadUuid: row.signin_payload_uuid,
    registeredAt: toDate(row.registered_at),
    checkedInAt: row.checked_in_at === null ? null : toDate(row.checked_in_at),
  };
}

export class PgRegistrationRepository implements RegistrationRepository {
  constructor(private readonly db: Queryable) {}

  async create(
    input: Omit<RegistrationRecord, "id" | "registeredAt" | "checkedInAt">,
  ): Promise<RegistrationRecord> {
    assertRegistrationAddress(input.address);
    assertValidAddressProof(input.addressProof);
    // An id outside the taxon range cannot name an event — 005's CHECK forbids
    // one — so it is a missing event, answered here rather than as the 22003
    // an `integer` column would raise. The in-memory store misses on the same
    // input and must report the same thing.
    if (!isPossibleEventId(input.eventId)) throw unknownEventError(input.eventId);

    try {
      const res = await this.db.query(
        `INSERT INTO registrations
           (event_id, address, address_proof, display_name, email, signin_payload_uuid)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [
          input.eventId,
          input.address,
          input.addressProof,
          input.displayName ?? null,
          input.email ?? null,
          input.signinPayloadUuid ?? null,
        ],
      );
      const row = res.rows[0] as RegistrationRow | undefined;
      if (!row) {
        throw new XrplLayerError(
          "LEDGER_QUERY_FAILED",
          "INSERT INTO registrations returned no row",
          { eventId: input.eventId },
        );
      }
      return rowToRegistration(row);
    } catch (err) {
      // The only unique constraint here is (event_id, address).
      if (pgCode(err) === UNIQUE_VIOLATION) {
        throw duplicateRegistrationError(input.eventId, input.address);
      }
      // And the only foreign key is event_id -> events. A typo in an event id
      // is a 404, not a database error leaking out of the persistence layer.
      if (pgCode(err) === FOREIGN_KEY_VIOLATION) throw unknownEventError(input.eventId);
      throw err;
    }
  }

  async findByAddress(
    eventId: EventId,
    address: string,
  ): Promise<RegistrationRecord | null> {
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM registrations WHERE event_id = $1 AND address = $2 LIMIT 1`,
      [eventId, address],
    );
    const row = res.rows[0] as RegistrationRow | undefined;
    return row ? rowToRegistration(row) : null;
  }

  async findById(id: string): Promise<RegistrationRecord | null> {
    if (!isRegistrationId(id)) return null;
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM registrations WHERE id = $1::bigint LIMIT 1`,
      [id],
    );
    const row = res.rows[0] as RegistrationRow | undefined;
    return row ? rowToRegistration(row) : null;
  }

  /**
   * The desk list. `checkedIn` splits it into the two questions a volunteer
   * actually asks: who is still expected (false) and who is already in (true).
   * Omitted means everyone.
   */
  async listByEvent(
    eventId: EventId,
    opts?: { limit?: number; offset?: number; checkedIn?: boolean },
  ): Promise<RegistrationRecord[]> {
    const { limit, offset } = normalizePaging(opts);
    const filter =
      opts?.checkedIn === undefined
        ? ""
        : opts.checkedIn
          ? "AND checked_in_at IS NOT NULL"
          : "AND checked_in_at IS NULL";

    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM registrations
        WHERE event_id = $1 ${filter}
        ${ORDER_BY} LIMIT $2 OFFSET $3`,
      [eventId, limit, offset],
    );
    return (res.rows as RegistrationRow[]).map(rowToRegistration);
  }

  /** Both numbers in one round trip: the desk shows them side by side. */
  async countByEvent(eventId: EventId): Promise<{ total: number; checkedIn: number }> {
    const res = await this.db.query(
      `SELECT count(*)::text AS total, count(checked_in_at)::text AS checked_in
         FROM registrations WHERE event_id = $1`,
      [eventId],
    );
    const row = res.rows[0] as { total: string; checked_in: string } | undefined;
    return {
      total: Number(row?.total ?? "0"),
      checkedIn: Number(row?.checked_in ?? "0"),
    };
  }

  /**
   * Marks an arrival. IDEMPOTENT BY CONSTRUCTION.
   *
   * The outer COALESCE is the whole point: a volunteer scanning the same badge
   * twice is a double-tap on a phone at a noisy door, not a second arrival, and
   * it must neither fail nor move the recorded time. The first scan is the one
   * that happened. A plain `SET checked_in_at = now()` would quietly rewrite
   * history every time someone leaned on the button.
   *
   * A missing row is still an error: the caller is holding an id for a
   * registration that does not exist, and telling them "checked in" would be a
   * lie the desk acts on.
   */
  async markCheckedIn(id: string, at?: Date): Promise<void> {
    if (isRegistrationId(id)) {
      const res = await this.db.query(
        `UPDATE registrations
            SET checked_in_at = COALESCE(checked_in_at, COALESCE($2::timestamptz, now()))
          WHERE id = $1::bigint
         RETURNING id`,
        [id, at ?? null],
      );
      if (res.rows.length > 0) return;
    }
    throw new NotFoundError(`No registration ${id} to check in.`, { id });
  }
}
