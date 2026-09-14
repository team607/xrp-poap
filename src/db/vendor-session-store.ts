/**
 * Vendor sessions: which wallet has proved itself in Xaman on this browser.
 *
 * The same two rules as admin sessions (session-store.ts), for the same
 * reasons — the row is the session, and only a hash of the cookie is stored —
 * and one more: this is a different table. A vendor cookie is a bearer token for
 * a vendor's order screen, and it must never be a value the admin guard could be
 * handed and look up. Separate storage makes that structural rather than a
 * matter of every caller being careful.
 */
import { XrplLayerError } from "../errors.js";
import type { VendorSessionRecord, VendorSessionStore } from "../types.js";
import { assertValidAddress } from "../xrpl/encoding.js";
import type { Queryable } from "./pool.js";
import { hashSessionId, newSessionId, normalizeTtlMs } from "./session-store.js";

interface VendorSessionRow {
  wallet_address: string;
  created_at: Date | string;
  expires_at: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export class PgVendorSessionStore implements VendorSessionStore {
  constructor(private readonly db: Queryable) {}

  async create(walletAddress: string, ttlMs: number): Promise<VendorSessionRecord> {
    assertValidAddress(walletAddress, "vendor wallet");
    const ttl = normalizeTtlMs(ttlMs);
    const rawId = newSessionId();
    const res = await this.db.query(
      `INSERT INTO vendor_sessions (id, wallet_address, created_at, expires_at)
       VALUES ($1, $2, now(), now() + ($3::bigint * interval '1 millisecond'))
       RETURNING wallet_address, created_at, expires_at`,
      [hashSessionId(rawId), walletAddress, String(ttl)],
    );
    const row = res.rows[0] as VendorSessionRow | undefined;
    if (!row) throw new XrplLayerError("LEDGER_QUERY_FAILED", "INSERT INTO vendor_sessions returned no row", {});
    return {
      id: rawId,
      walletAddress: row.wallet_address,
      createdAt: toDate(row.created_at),
      expiresAt: toDate(row.expires_at),
    };
  }

  /** Expiry is the database's clock, in the statement. */
  async get(id: string): Promise<VendorSessionRecord | null> {
    if (typeof id !== "string" || id === "") return null;
    const res = await this.db.query(
      `SELECT wallet_address, created_at, expires_at FROM vendor_sessions
        WHERE id = $1 AND expires_at > now()`,
      [hashSessionId(id)],
    );
    const row = res.rows[0] as VendorSessionRow | undefined;
    return row
      ? { id, walletAddress: row.wallet_address, createdAt: toDate(row.created_at), expiresAt: toDate(row.expires_at) }
      : null;
  }

  async revoke(id: string): Promise<void> {
    if (typeof id !== "string" || id === "") return;
    await this.db.query("DELETE FROM vendor_sessions WHERE id = $1", [hashSessionId(id)]);
  }

  /** Not part of VendorSessionStore: lets the contract suite check no raw id is kept. */
  async storedIds(): Promise<string[]> {
    const res = await this.db.query("SELECT id FROM vendor_sessions");
    return (res.rows as { id: string }[]).map((r) => r.id);
  }
}

export class MemoryVendorSessionStore implements VendorSessionStore {
  private readonly rows = new Map<string, { walletAddress: string; createdAt: Date; expiresAt: Date }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(walletAddress: string, ttlMs: number): Promise<VendorSessionRecord> {
    assertValidAddress(walletAddress, "vendor wallet");
    const ttl = normalizeTtlMs(ttlMs);
    const rawId = newSessionId();
    const at = this.now();
    const row = { walletAddress, createdAt: at, expiresAt: new Date(at.getTime() + ttl) };
    this.rows.set(hashSessionId(rawId), row);
    return { id: rawId, walletAddress, createdAt: new Date(at.getTime()), expiresAt: new Date(row.expiresAt.getTime()) };
  }

  async get(id: string): Promise<VendorSessionRecord | null> {
    if (typeof id !== "string" || id === "") return null;
    const row = this.rows.get(hashSessionId(id));
    if (!row || row.expiresAt.getTime() <= this.now().getTime()) return null;
    return {
      id,
      walletAddress: row.walletAddress,
      createdAt: new Date(row.createdAt.getTime()),
      expiresAt: new Date(row.expiresAt.getTime()),
    };
  }

  async revoke(id: string): Promise<void> {
    if (typeof id !== "string" || id === "") return;
    this.rows.delete(hashSessionId(id));
  }

  /** Not part of VendorSessionStore: lets the contract suite check no raw id is kept. */
  storedIds(): string[] {
    return [...this.rows.keys()];
  }
}
