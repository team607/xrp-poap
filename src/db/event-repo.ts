/**
 * Events, which are also taxons.
 *
 * ---------------------------------------------------------------------------
 * `eventId` IS THE NFTokenTaxon, AND IT IS IMMUTABLE.
 *
 * There is no surrogate key. The number in this table's primary key is the
 * number that was written into every NFTokenMint for this event, and the
 * ledger has no idea this row exists. So:
 *
 *   * the id is chosen by the operator, never generated;
 *   * it is bounded by the protocol's reserved range, not by our schema;
 *   * update() refuses to change it. Renumbering a row whose badges are
 *     already on chain does not move those badges — it orphans them, and the
 *     only symptom is an attendee whose real badge stops verifying;
 *   * hasBadges() is how an admin UI finds out whether an edit is destructive
 *     before offering it.
 *
 * Everything else about an event is editable, because nothing else about it is
 * on chain.
 * ---------------------------------------------------------------------------
 */
import { NotFoundError, ValidationError, XrplLayerError } from "../errors.js";
import { dropsToXrpString, normalizeXrp, xrpToDropsBigInt } from "../money.js";
import {
  MAX_TAXON,
  type EventId,
  type EventRecord,
  type EventRepository,
  type EventStatus,
} from "../types.js";
import { normalizePaging } from "./attendance-repo.js";
import type { Queryable } from "./pool.js";

/** Shape of a row as pg hands it back. `event_date` arrives as text — see below. */
interface EventRow {
  event_id: number;
  name: string;
  description: string | null;
  event_date: string | Date | null;
  venue: string | null;
  metadata_uri: string | null;
  status: string;
  /** bigint columns, cast to text so they never pass through a JS number. */
  allowance_drops?: string | null;
  budget_drops?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * `to_char(event_date, ...)`, not a bare `event_date`, and this is not a style
 * choice.
 *
 * node-postgres parses a `date` column into a JS Date at LOCAL midnight. In any
 * positive UTC offset that Date's ISO form is the previous day — an event on
 * 2026-05-01 is read back as "2026-04-30" by a server in Berlin and as
 * "2026-05-01" by the same code in New York. A calendar day has no zone, so it
 * must not travel as an instant at all: Postgres renders the text and no Date
 * is ever constructed.
 */
const COLUMNS =
  "event_id, name, description, to_char(event_date, 'YYYY-MM-DD') AS event_date, " +
  "venue, metadata_uri, status, allowance_drops::text AS allowance_drops, " +
  "budget_drops::text AS budget_drops, created_at, updated_at";

/** The two money fields, stored as drops and carried as decimal XRP. */
const DROPS_COLUMNS: ReadonlySet<string> = new Set(["allowance_drops", "budget_drops"]);

/**
 * Ordered by the primary key.
 *
 * event_date would read better in an admin list, but it is nullable and not
 * unique, which makes it a paging hazard: rows that tie can swap between two
 * queries, so a page boundary repeats one row and drops another. event_id is
 * the PK, so it is total, stable and never null.
 */
const ORDER_BY = "ORDER BY event_id ASC";

const STATUSES: readonly EventStatus[] = ["draft", "open", "live", "closed"];

/** Postgres unique_violation / check_violation. */
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" ? (err as { code?: string }).code : undefined;
}

/**
 * The taxon range, checked here as well as by the CHECK in 005_events.sql.
 *
 * Shared by both implementations on purpose. A rule enforced only by the
 * database is a rule the in-memory store does not have, and the contract suite
 * exists to stop those two drifting.
 */
export function assertValidEventId(eventId: EventId): void {
  if (!Number.isInteger(eventId) || eventId < 0 || eventId > MAX_TAXON) {
    throw new ValidationError(
      "INVALID_TAXON",
      `eventId ${eventId} is not a usable NFTokenTaxon. It must be an integer in 0..${MAX_TAXON}; ` +
        "values above that are reserved by the protocol.",
      { eventId, maxTaxon: MAX_TAXON },
    );
  }
}

/**
 * Whether this number could name a row at all.
 *
 * The CHECK in 005_events.sql means no event outside the taxon range exists,
 * so a caller asking about one is asking about a row that is not there. Worth
 * a predicate rather than a throw because the answer on the read paths is
 * "nothing found", and because handing 3e9 or 1.5 to an `integer` column earns
 * a raw 22003 or 22P02 from Postgres where the in-memory store would simply
 * have missed.
 */
export function isPossibleEventId(eventId: EventId): boolean {
  return Number.isInteger(eventId) && eventId >= 0 && eventId <= MAX_TAXON;
}

export function assertValidStatus(status: unknown): asserts status is EventStatus {
  if (typeof status !== "string" || !STATUSES.includes(status as EventStatus)) {
    throw new ValidationError(
      "INVALID_INPUT",
      `event status must be one of ${STATUSES.join(" | ")}, got ${JSON.stringify(status)}`,
      { status },
    );
  }
}

export function assertValidEventName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new ValidationError("INVALID_INPUT", "event name is required and cannot be blank", {
      name,
    });
  }
}

/**
 * A calendar date, as YYYY-MM-DD. Rejected here rather than by Postgres so the
 * caller gets a typed error instead of a 22008 nobody can trace, and so the
 * in-memory store cannot accept a value the real table would refuse.
 */
export function assertValidEventDate(eventDate: unknown): void {
  if (eventDate === null || eventDate === undefined) return;
  const ok =
    typeof eventDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(eventDate) &&
    !Number.isNaN(Date.parse(`${eventDate}T00:00:00Z`)) &&
    // Date.parse accepts 2026-02-31 by rolling over; compare the round trip.
    new Date(`${eventDate}T00:00:00Z`).toISOString().slice(0, 10) === eventDate;
  if (!ok) {
    throw new ValidationError(
      "INVALID_INPUT",
      `eventDate must be a calendar date as YYYY-MM-DD, got ${JSON.stringify(eventDate)}`,
      { eventDate },
    );
  }
}

/**
 * The allowance and the budget, as the organiser typed them, in the one
 * spelling both stores keep: "2.50" becomes "2.5". Throws INVALID_INPUT for
 * anything that is not a plain XRP amount. Whether an allowance is too large
 * for this server is a question for the route, which knows the ceiling.
 */
export function normalizeEventAmounts<T extends { allowanceXrp?: string; budgetXrp?: string }>(
  input: T,
): T {
  const out = { ...input };
  if (input.allowanceXrp !== undefined) {
    out.allowanceXrp = normalizeXrp(input.allowanceXrp, "allowanceXrp");
  }
  if (input.budgetXrp !== undefined) {
    out.budgetXrp = normalizeXrp(input.budgetXrp, "budgetXrp");
  }
  return out;
}

/** Validates everything 005_events.sql and 011 constrain, in one place. */
export function assertValidEvent(input: {
  eventId: EventId;
  name: unknown;
  status: unknown;
  eventDate?: unknown;
  allowanceXrp?: string;
  budgetXrp?: string;
}): void {
  assertValidEventId(input.eventId);
  assertValidEventName(input.name);
  assertValidStatus(input.status);
  assertValidEventDate(input.eventDate);
  normalizeEventAmounts(input);
}

/** The duplicate an operator hits by reusing a taxon that is already an event. */
export function duplicateEventError(eventId: EventId): XrplLayerError {
  return new XrplLayerError(
    "DUPLICATE_CLAIM",
    `Event ${eventId} already exists. An event id is an NFTokenTaxon and cannot be reused: ` +
      "badges already minted under it belong to the existing event.",
    { constraint: "event_id", eventId },
  );
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * `to_char` means this is already text. The Date branch is a guard for a
 * caller that swapped in their own Queryable without the cast: node-postgres
 * builds those at LOCAL midnight, so the local parts — not the UTC ones — are
 * the day the operator typed.
 */
function toIsoDate(value: string | Date | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function rowToEvent(row: EventRow): EventRecord {
  return {
    eventId: row.event_id,
    name: row.name,
    description: row.description,
    eventDate: toIsoDate(row.event_date),
    venue: row.venue,
    metadataUri: row.metadata_uri,
    status: row.status as EventStatus,
    allowanceXrp: dropsToXrpString(BigInt(row.allowance_drops ?? "0")),
    budgetXrp: dropsToXrpString(BigInt(row.budget_drops ?? "0")),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

/**
 * Patch key -> column. Anything not in here cannot be written by update(),
 * which is what keeps event_id, created_at and a stray field from a JSON body
 * out of the SET list. Exported so the in-memory store applies exactly the
 * same set of fields.
 */
export const EVENT_PATCH_COLUMNS = {
  name: "name",
  description: "description",
  eventDate: "event_date",
  venue: "venue",
  metadataUri: "metadata_uri",
  status: "status",
  allowanceXrp: "allowance_drops",
  budgetXrp: "budget_drops",
} as const;

export type EventPatch = Partial<Omit<EventRecord, "eventId" | "createdAt" | "updatedAt">>;

type UpdatablePatch = EventPatch;

/**
 * Refuses an attempt to renumber an event.
 *
 * TypeScript already omits `eventId` from the patch type, which stops exactly
 * nobody: the patch that reaches this layer is usually a parsed JSON body, and
 * an admin form that round-trips the whole record posts the id straight back.
 * An id equal to the target is that harmless round trip and is ignored; a
 * different one is a renumber, and a renumber orphans every badge already
 * minted under the old taxon.
 *
 * Shared by both implementations.
 */
export function assertNotRenumbering(eventId: EventId, patch: UpdatablePatch): void {
  const attempted = (patch as { eventId?: unknown }).eventId;
  if (attempted === undefined || attempted === eventId) return;
  throw new ValidationError(
    "INVALID_INPUT",
    `Cannot change eventId ${eventId} to ${String(attempted)}. The event id is the ` +
      "NFTokenTaxon carried by every badge already minted for this event; renumbering the " +
      "row would orphan them. Create a new event instead.",
    { eventId, attempted },
  );
}

/** Validates the fields a patch actually carries. Shared by both implementations. */
export function assertValidPatch(patch: UpdatablePatch): void {
  if (patch.name !== undefined) assertValidEventName(patch.name);
  if (patch.status !== undefined) assertValidStatus(patch.status);
  if (patch.eventDate !== undefined) assertValidEventDate(patch.eventDate);
  normalizeEventAmounts(patch);
}

export class PgEventRepository implements EventRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: Omit<EventRecord, "createdAt" | "updatedAt">): Promise<EventRecord> {
    const status = input.status ?? "draft";
    assertValidEvent({ ...input, status });

    try {
      const res = await this.db.query(
        `INSERT INTO events
           (event_id, name, description, event_date, venue, metadata_uri, status,
            allowance_drops, budget_drops)
         VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8::bigint, $9::bigint)
         RETURNING ${COLUMNS}`,
        [
          input.eventId,
          input.name,
          input.description ?? null,
          input.eventDate ?? null,
          input.venue ?? null,
          input.metadataUri ?? null,
          status,
          // Text, not a JS number: a bigint parameter must not pass through 2^53.
          xrpToDropsBigInt(input.allowanceXrp ?? "0", "allowanceXrp").toString(),
          xrpToDropsBigInt(input.budgetXrp ?? "0", "budgetXrp").toString(),
        ],
      );
      const row = res.rows[0] as EventRow | undefined;
      if (!row) {
        throw new XrplLayerError("LEDGER_QUERY_FAILED", "INSERT INTO events returned no row", {
          eventId: input.eventId,
        });
      }
      return rowToEvent(row);
    } catch (err) {
      // The only unique constraint on this table is the primary key, so a
      // 23505 can only mean the taxon is taken. That is an operator mistake
      // worth naming, not a 500.
      if (pgCode(err) === UNIQUE_VIOLATION) throw duplicateEventError(input.eventId);
      // Belt and braces: the JS validation above should have caught anything
      // the CHECKs would reject, so this only fires if the two drift.
      if (pgCode(err) === CHECK_VIOLATION) {
        throw new ValidationError(
          "INVALID_INPUT",
          `Event ${input.eventId} violates a table constraint: ` +
            String((err as { constraint?: string }).constraint ?? "unknown"),
          { eventId: input.eventId, constraint: (err as { constraint?: string }).constraint },
        );
      }
      throw err;
    }
  }

  /**
   * Applies only the fields the patch carries.
   *
   * The SET list is built from the keys that are present rather than with
   * COALESCE, because the nullable columns have to be clearable: COALESCE
   * cannot tell "leave the venue alone" from "the venue is now unknown", and
   * an operator who blanks a field expects it blank.
   */
  async update(eventId: EventId, patch: UpdatablePatch): Promise<EventRecord> {
    assertValidEventId(eventId);
    assertNotRenumbering(eventId, patch);
    assertValidPatch(patch);

    const sets: string[] = [];
    const values: unknown[] = [eventId];

    for (const [key, column] of Object.entries(EVENT_PATCH_COLUMNS)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      const drops = DROPS_COLUMNS.has(column);
      values.push(drops ? xrpToDropsBigInt(String(value), key).toString() : value);
      // event_date and the two drops columns need their types spelled out; the
      // rest are text and pg infers them from the column.
      const cast = column === "event_date" ? "::date" : drops ? "::bigint" : "";
      sets.push(`${column} = $${values.length}${cast}`);
    }

    // An empty patch is a read. Nothing changed, so updated_at must not move.
    if (sets.length === 0) {
      const current = await this.find(eventId);
      if (!current) throw new NotFoundError(`No event ${eventId} to update.`, { eventId });
      return current;
    }

    sets.push("updated_at = now()");

    const res = await this.db.query(
      `UPDATE events SET ${sets.join(", ")} WHERE event_id = $1 RETURNING ${COLUMNS}`,
      values,
    );
    const row = res.rows[0] as EventRow | undefined;
    if (!row) throw new NotFoundError(`No event ${eventId} to update.`, { eventId });
    return rowToEvent(row);
  }

  async find(eventId: EventId): Promise<EventRecord | null> {
    if (!isPossibleEventId(eventId)) return null;
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM events WHERE event_id = $1 LIMIT 1`,
      [eventId],
    );
    const row = res.rows[0] as EventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  async list(opts?: {
    status?: EventStatus;
    limit?: number;
    offset?: number;
  }): Promise<EventRecord[]> {
    const { limit, offset } = normalizePaging(opts);
    if (opts?.status !== undefined) assertValidStatus(opts.status);

    const where = opts?.status !== undefined ? "WHERE status = $3" : "";
    const values: unknown[] = [limit, offset];
    if (opts?.status !== undefined) values.push(opts.status);

    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM events ${where} ${ORDER_BY} LIMIT $1 OFFSET $2`,
      values,
    );
    return (res.rows as EventRow[]).map(rowToEvent);
  }

  /**
   * Whether any badge has been minted for this event.
   *
   * Counted from the attendance index, which is the only record we keep of a
   * badge that actually reached an attendee. It can lag the ledger (a claim
   * that landed while the writer was down), so a `false` means "we have not
   * seen one", never "the ledger has none" — which is why this gates an
   * admin's destructive edit rather than a mint.
   */
  async hasBadges(eventId: EventId): Promise<boolean> {
    if (!isPossibleEventId(eventId)) return false;
    const res = await this.db.query(
      "SELECT 1 FROM attendance WHERE event_id = $1 LIMIT 1",
      [eventId],
    );
    return res.rows.length > 0;
  }
}
