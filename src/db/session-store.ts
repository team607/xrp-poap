/**
 * Admin sessions.
 *
 * ---------------------------------------------------------------------------
 * THE ROW IS THE SESSION, AND THE STORED ID IS A HASH OF THE COOKIE.
 *
 * Two decisions, both of which the API layer depends on:
 *
 * 1. Server-side state, not a JWT. Deleting the row ends the session. A signed
 *    token cannot be revoked before it expires, and "log out everywhere, now"
 *    is the entire remedy after a leaked admin cookie.
 *
 * 2. THE CALLER PASSES THE RAW ID; THIS STORE HASHES IT. `create()` mints a
 *    256-bit random id, returns it, and writes only sha256(id). `get()`,
 *    `revoke()` and everything else take that same raw value and hash it
 *    again before touching the table.
 *
 *    The raw id is a bearer token — whoever holds it is the admin, no password
 *    required. Storing it verbatim would mean a leaked backup, a `SELECT *` in
 *    a debug log, or read-only SQL injection anywhere in the app hands over
 *    live sessions. A leak of the hashed table yields hex strings that cannot
 *    be replayed. The id is random and 256 bits wide, so an unsalted single
 *    sha256 is right here: there is no dictionary to attack, and every request
 *    pays this cost. None of that reasoning transfers to passwords.
 *
 *    Corollary for callers: the raw id exists exactly twice — in the cookie and
 *    in the return value of create(). Never log it, and there is no way to
 *    recover it from the database if you drop it.
 * ---------------------------------------------------------------------------
 *
 * EXPIRY IS THE DATABASE'S CLOCK. Every read compares expires_at against the
 * server's now() inside SQL. A caller-supplied "now" is never trusted for that
 * decision: a client with a wrong — or dishonest — clock must not be able to
 * extend a session past its end.
 */
import { createHash, randomBytes } from "node:crypto";
import { ValidationError, XrplLayerError } from "../errors.js";
import type { SessionRecord, SessionStore } from "../types.js";
import type { Queryable } from "./pool.js";

interface SessionRow {
  id: string;
  email: string;
  created_at: Date | string;
  expires_at: Date | string;
  last_seen_at: Date | string | null;
}

const COLUMNS = "id, email, created_at, expires_at, last_seen_at";

/** 256 bits. Wide enough that the store never has to worry about a collision. */
const ID_BYTES = 32;

/**
 * The one hash function, shared by every implementation.
 *
 * Both stores import this rather than each rolling their own, so a session
 * minted against the in-memory store is stored under exactly the same digest
 * Postgres would have written. The contract suite asserts on it directly: the
 * raw id must not appear in the store, and the digest must.
 */
export function hashSessionId(rawId: string): string {
  return createHash("sha256").update(rawId, "utf8").digest("hex");
}

/** A fresh cookie value. Base64url so it needs no escaping in a Set-Cookie. */
export function newSessionId(): string {
  return randomBytes(ID_BYTES).toString("base64url");
}

export function assertValidSessionEmail(email: unknown): asserts email is string {
  if (typeof email !== "string" || email.trim() === "") {
    throw new ValidationError("INVALID_INPUT", "a session needs an email", { email });
  }
}

/**
 * TTL in whole milliseconds.
 *
 * A non-positive TTL is allowed and mints a session that is already expired —
 * get() will refuse it immediately. That is a coherent answer to "log me in for
 * zero seconds" and it is the only way for a test to produce an expired session
 * without reaching past the interface. NaN and Infinity are not: they would
 * reach Postgres as an interval it cannot build.
 */
export function normalizeTtlMs(ttlMs: number): number {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs)) {
    throw new ValidationError("INVALID_INPUT", `session ttlMs must be a finite number, got ${ttlMs}`, {
      ttlMs,
    });
  }
  return Math.trunc(ttlMs);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Row -> record, with the RAW id put back in place of the stored digest.
 *
 * The caller handed us the secret; handing back the hash instead would make
 * `record.id` useless as a cookie and, worse, tempt someone into writing the
 * digest into one.
 */
function rowToSession(row: SessionRow, rawId: string): SessionRecord {
  return {
    id: rawId,
    email: row.email,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
    lastSeenAt: row.last_seen_at === null ? undefined : toDate(row.last_seen_at),
  };
}

export class PgSessionStore implements SessionStore {
  constructor(private readonly db: Queryable) {}

  /**
   * Mints a session. The returned `id` is the raw secret for the cookie; the
   * table only ever sees its sha256.
   *
   * expires_at is computed in SQL as now() + ttl, so the lifetime is measured
   * by the database and not by whichever process happened to serve the login.
   */
  async create(email: string, ttlMs: number): Promise<SessionRecord> {
    assertValidSessionEmail(email);
    const ttl = normalizeTtlMs(ttlMs);
    const rawId = newSessionId();

    const res = await this.db.query(
      `INSERT INTO sessions (id, email, created_at, expires_at, last_seen_at)
       VALUES ($1, $2, now(), now() + ($3::bigint * interval '1 millisecond'), now())
       RETURNING ${COLUMNS}`,
      [hashSessionId(rawId), email, String(ttl)],
    );

    const row = res.rows[0] as SessionRow | undefined;
    if (!row) {
      throw new XrplLayerError(
        "LEDGER_QUERY_FAILED",
        "INSERT INTO sessions returned no row",
        // Never the id, raw or hashed, and never anything else about the
        // session that would be useful to somebody reading a log.
        {},
      );
    }
    return rowToSession(row, rawId);
  }

  /**
   * Looks up a live session and touches last_seen_at, in one statement.
   *
   * `expires_at > now()` is inside the UPDATE for two reasons. It keeps the
   * decision on the database's clock — the caller cannot pass a "now" that
   * revives a dead session — and it means an expired row is never refreshed on
   * the way to being rejected, which would otherwise make last_seen_at read
   * later than the expiry it failed.
   *
   * Unknown, expired and revoked all return null, deliberately
   * indistinguishably: the caller's response to all three is the same login
   * page, and telling them apart would tell an attacker which guessed ids exist.
   */
  async get(id: string): Promise<SessionRecord | null> {
    if (typeof id !== "string" || id === "") return null;

    const res = await this.db.query(
      `UPDATE sessions SET last_seen_at = now()
        WHERE id = $1 AND expires_at > now()
       RETURNING ${COLUMNS}`,
      [hashSessionId(id)],
    );
    const row = res.rows[0] as SessionRow | undefined;
    return row ? rowToSession(row, id) : null;
  }

  /** Deletes the row. Silent on an id that is already gone or never existed. */
  async revoke(id: string): Promise<void> {
    if (typeof id !== "string" || id === "") return;
    await this.db.query("DELETE FROM sessions WHERE id = $1", [hashSessionId(id)]);
  }

  /**
   * Log out everywhere. The remedy after a leaked cookie, so it matches on
   * email exactly as it was stored — normalising an address is the auth
   * layer's job, done once at the edge, and doing it differently here is how
   * a revoke-all silently misses the session it was called to kill.
   */
  async revokeAll(email: string): Promise<void> {
    assertValidSessionEmail(email);
    await this.db.query("DELETE FROM sessions WHERE email = $1", [email]);
  }

  /**
   * Housekeeping. Safe on a timer, returns how many rows went.
   *
   * Unlike get(), this honours an explicit `now`: it is an operator-supplied
   * cutoff on a maintenance call rather than a claim about the current time
   * arriving with a request, and the worst a wrong one can do is delete
   * sessions early. Omitted — the normal case — means the server's clock.
   */
  async purgeExpired(now?: Date): Promise<number> {
    const res = await this.db.query(
      "DELETE FROM sessions WHERE expires_at <= COALESCE($1::timestamptz, now()) RETURNING id",
      [now ?? null],
    );
    return res.rows.length;
  }

  /**
   * Every stored id, which is to say every digest. Not part of SessionStore:
   * it exists so the contract suite can assert that a raw cookie value is
   * nowhere in the table. Do not build application behaviour on it.
   */
  async storedIds(): Promise<string[]> {
    const res = await this.db.query("SELECT id FROM sessions");
    return (res.rows as { id: string }[]).map((r) => r.id);
  }
}
