/**
 * Purchases: a reservation of stock, then a payment the ledger confirms.
 *
 * THE RESERVATION IS THE STOCK GUARD. Two phones tapping "buy" on the last
 * pizza at the same moment must not both be sent to Xaman, so the stock check,
 * the per-buyer cap and the insert are one decision: under two advisory locks
 * in Postgres (the buyer, then the item — always that order, so two locks can
 * never deadlock), and with no await between them in memory.
 *
 * A RESERVATION HOLDS STOCK UNTIL IT EXPIRES, and no longer. Nothing sweeps
 * expired rows: "units taken" simply stops counting a reservation past its
 * expiry, so stock comes back on its own even if nobody ever looks at the
 * order again.
 *
 * PAID IS ONE-WAY, AND LATE MONEY STILL COUNTS. An order that expired and then
 * turns out to have been paid — the attendee signed at the last second — is
 * marked paid. The vendor has the XRP; the record has to say so.
 */
import { NotFoundError, ValidationError, XrplLayerError } from "../errors.js";
import { dropsToXrpString, xrpToDropsBigInt } from "../money.js";
import type {
  EventId,
  PurchaseListOptions,
  PurchaseRecord,
  PurchaseRepository,
  PurchaseReserveInput,
  PurchaseReserveOutcome,
  PurchaseStatus,
  VendorRepository,
  VendorSales,
} from "../types.js";
import { assertValidAddress } from "../xrpl/encoding.js";
import { normalizePaging } from "./attendance-repo.js";
import { assertValidEventId, isPossibleEventId } from "./event-repo.js";
import { withTransaction, type Queryable } from "./pool.js";
import { isRowId } from "./vendor-repo.js";

export const MAX_QUANTITY = 100;

/** Advisory-lock classes: "PBUY" and "PITM" in ASCII, both inside an int4. */
export const BUYER_LOCK_CLASS = 0x50425559;
export const ITEM_LOCK_CLASS = 0x5049544d;

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" ? (err as { code?: string }).code : undefined;
}

export function isPurchaseId(id: string): boolean {
  return typeof id === "string" && UUID.test(id);
}

function noPurchase(id: string): NotFoundError {
  return new NotFoundError(`No order ${id}.`, { purchaseId: id });
}

function noItem(input: PurchaseReserveInput): NotFoundError {
  return new NotFoundError(`Item ${input.itemId} is not sold by vendor ${input.vendorId} at event ${input.eventId}.`, {
    itemId: input.itemId,
    vendorId: input.vendorId,
    eventId: input.eventId,
  });
}

function hashUsed(id: string, txHash: string): XrplLayerError {
  return new XrplLayerError("CONFLICT", `Payment ${txHash} already paid for a different order.`, {
    purchaseId: id,
    txHash,
  });
}

function notPaid(id: string, status: PurchaseStatus): XrplLayerError {
  return new XrplLayerError(
    "CONFLICT",
    status === "reserved"
      ? "This order has not been paid yet, so it cannot be handed over."
      : "This order was never paid, so there is nothing to hand over.",
    { purchaseId: id, status },
  );
}

/** Everything the table's CHECKs would refuse, checked where it produces a sentence. */
function parseReserve(input: PurchaseReserveInput): { unit: bigint; amount: bigint } {
  if (!isPurchaseId(input.id)) {
    throw new ValidationError("INVALID_INPUT", "An order id is a uuid.", { purchaseId: input.id });
  }
  assertValidEventId(input.eventId);
  assertValidAddress(input.buyerAddress, "buyer");
  assertValidAddress(input.vendorAddress, "vendor wallet");
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_QUANTITY) {
    throw new ValidationError("INVALID_INPUT", `Quantity is a whole number from 1 to ${MAX_QUANTITY}.`, {
      quantity: input.quantity,
    });
  }
  if (!Number.isInteger(input.maxOpenPerBuyer) || input.maxOpenPerBuyer < 1) {
    throw new ValidationError("INVALID_INPUT", "maxOpenPerBuyer must be at least 1.", {
      maxOpenPerBuyer: input.maxOpenPerBuyer,
    });
  }
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
    throw new ValidationError("INVALID_INPUT", "An order needs an expiry.", {});
  }
  const unit = xrpToDropsBigInt(input.unitPriceXrp, "unitPriceXrp");
  if (unit <= 0n) {
    throw new ValidationError("INVALID_INPUT", "A price must be more than zero.", { unitPriceXrp: input.unitPriceXrp });
  }
  return { unit, amount: unit * BigInt(input.quantity) };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface PurchaseRow {
  id: string;
  event_id: number;
  vendor_id: string | number;
  item_id: string | number;
  buyer_address: string;
  vendor_address: string;
  vendor_name: string;
  item_name: string;
  quantity: number;
  unit_price_drops: string;
  amount_drops: string;
  status: string;
  xaman_uuid: string | null;
  tx_hash: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  paid_at: Date | string | null;
  handed_over_at: Date | string | null;
}

const COLUMNS =
  "id, event_id, vendor_id, item_id, buyer_address, vendor_address, vendor_name, item_name, quantity, " +
  "unit_price_drops::text AS unit_price_drops, amount_drops::text AS amount_drops, status, xaman_uuid, " +
  "tx_hash, created_at, expires_at, paid_at, handed_over_at";

/** Stock is spoken for by a payment, or by a reservation that has not run out. */
const TAKEN = "(status = 'paid' OR (status = 'reserved' AND expires_at > now()))";

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function rowToPurchase(row: PurchaseRow): PurchaseRecord {
  return {
    id: String(row.id),
    eventId: Number(row.event_id),
    vendorId: String(row.vendor_id),
    itemId: String(row.item_id),
    buyerAddress: row.buyer_address,
    vendorAddress: row.vendor_address,
    vendorName: row.vendor_name,
    itemName: row.item_name,
    quantity: Number(row.quantity),
    unitPriceXrp: dropsToXrpString(BigInt(row.unit_price_drops)),
    amountXrp: dropsToXrpString(BigInt(row.amount_drops)),
    status: row.status as PurchaseStatus,
    xamanUuid: row.xaman_uuid,
    txHash: row.tx_hash,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
    paidAt: row.paid_at === null ? null : toDate(row.paid_at),
    handedOverAt: row.handed_over_at === null ? null : toDate(row.handed_over_at),
  };
}

/** WHERE clauses for list() and count(). Every value is a parameter. */
function filters(opts: Omit<PurchaseListOptions, "limit" | "offset"> | undefined): {
  where: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (opts?.eventId !== undefined) {
    values.push(opts.eventId);
    clauses.push(`event_id = $${values.length}`);
  }
  if (opts?.vendorId !== undefined) {
    values.push(opts.vendorId);
    clauses.push(`vendor_id = $${values.length}::bigint`);
  }
  if (opts?.buyerAddress !== undefined) {
    values.push(opts.buyerAddress);
    clauses.push(`buyer_address = $${values.length}`);
  }
  if (opts?.status !== undefined) {
    values.push(opts.status);
    clauses.push(`status = $${values.length}`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

/** A filter that can only match nothing: an id no row can have. */
function impossible(opts: Omit<PurchaseListOptions, "limit" | "offset"> | undefined): boolean {
  if (opts?.vendorId !== undefined && !isRowId(opts.vendorId)) return true;
  if (opts?.eventId !== undefined && !isPossibleEventId(opts.eventId)) return true;
  return false;
}

export class PgPurchaseRepository implements PurchaseRepository {
  constructor(private readonly db: Queryable) {}

  async reserve(input: PurchaseReserveInput): Promise<PurchaseReserveOutcome> {
    const { unit, amount } = parseReserve(input);
    if (!isRowId(input.itemId) || !isRowId(input.vendorId)) throw noItem(input);

    try {
      return await withTransaction(this.db, async (tx) => {
        // Buyer first, then item. Every reserve takes them in this order, so
        // no two can each hold the lock the other is waiting for.
        await tx.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [
          BUYER_LOCK_CLASS,
          input.buyerAddress,
        ]);
        await tx.query("SELECT pg_advisory_xact_lock($1::int, ($2::bigint % 2147483647)::int)", [
          ITEM_LOCK_CLASS,
          input.itemId,
        ]);

        const itemRes = await tx.query(
          "SELECT stock, vendor_id, event_id FROM vendor_items WHERE id = $1::bigint",
          [input.itemId],
        );
        const item = itemRes.rows[0] as { stock: number | null; vendor_id: string | number; event_id: number } | undefined;
        if (!item || String(item.vendor_id) !== input.vendorId || Number(item.event_id) !== input.eventId) {
          throw noItem(input);
        }

        if (item.stock !== null) {
          const takenRes = await tx.query(
            `SELECT COALESCE(SUM(quantity), 0)::int AS taken FROM purchases WHERE item_id = $1::bigint AND ${TAKEN}`,
            [input.itemId],
          );
          const taken = Number((takenRes.rows[0] as { taken: number } | undefined)?.taken ?? 0);
          if (taken + input.quantity > Number(item.stock)) {
            return { ok: false, reason: "sold_out", remaining: Math.max(0, Number(item.stock) - taken) } as const;
          }
        }

        const openRes = await tx.query(
          `SELECT COUNT(*)::int AS open FROM purchases
            WHERE event_id = $1 AND buyer_address = $2 AND status = 'reserved' AND expires_at > now()`,
          [input.eventId, input.buyerAddress],
        );
        const open = Number((openRes.rows[0] as { open: number } | undefined)?.open ?? 0);
        if (open >= input.maxOpenPerBuyer) return { ok: false, reason: "too_many_open", open } as const;

        const res = await tx.query(
          `INSERT INTO purchases
             (id, event_id, vendor_id, item_id, buyer_address, vendor_address, vendor_name, item_name,
              quantity, unit_price_drops, amount_drops, status, expires_at)
           VALUES ($1::uuid, $2, $3::bigint, $4::bigint, $5, $6, $7, $8, $9, $10::bigint, $11::bigint, 'reserved', $12)
           RETURNING ${COLUMNS}`,
          [
            input.id,
            input.eventId,
            input.vendorId,
            input.itemId,
            input.buyerAddress,
            input.vendorAddress,
            input.vendorName,
            input.itemName,
            input.quantity,
            unit.toString(),
            amount.toString(),
            input.expiresAt,
          ],
        );
        return { ok: true, purchase: rowToPurchase(res.rows[0] as PurchaseRow) } as const;
      });
    } catch (err) {
      if (pgCode(err) === UNIQUE_VIOLATION) {
        throw new XrplLayerError("CONFLICT", `Order ${input.id} already exists.`, { purchaseId: input.id });
      }
      if (pgCode(err) === FOREIGN_KEY_VIOLATION) throw noItem(input);
      throw err;
    }
  }

  async attachPayload(id: string, xamanUuid: string): Promise<void> {
    if (!isPurchaseId(id)) throw noPurchase(id);
    const res = await this.db.query("UPDATE purchases SET xaman_uuid = $2 WHERE id = $1::uuid RETURNING id", [
      id,
      xamanUuid,
    ]);
    if (res.rows.length === 0) throw noPurchase(id);
  }

  async markPaid(id: string, txHash: string): Promise<PurchaseRecord> {
    if (!isPurchaseId(id)) throw noPurchase(id);
    try {
      const res = await this.db.query(
        `UPDATE purchases SET status = 'paid', tx_hash = $2, paid_at = now()
          WHERE id = $1::uuid AND status IN ('reserved', 'expired')
         RETURNING ${COLUMNS}`,
        [id, txHash],
      );
      const row = res.rows[0] as PurchaseRow | undefined;
      if (row) return rowToPurchase(row);
    } catch (err) {
      if (pgCode(err) === UNIQUE_VIOLATION) throw hashUsed(id, txHash);
      throw err;
    }

    const current = await this.find(id);
    if (!current) throw noPurchase(id);
    if (current.txHash === txHash) return current;
    throw new XrplLayerError("CONFLICT", `Order ${id} was already paid by a different payment.`, {
      purchaseId: id,
      txHash,
      paidWith: current.txHash,
    });
  }

  async markExpired(id: string): Promise<PurchaseRecord | null> {
    if (!isPurchaseId(id)) return null;
    const res = await this.db.query(
      `UPDATE purchases SET status = 'expired' WHERE id = $1::uuid AND status = 'reserved' RETURNING ${COLUMNS}`,
      [id],
    );
    const row = res.rows[0] as PurchaseRow | undefined;
    return row ? rowToPurchase(row) : null;
  }

  async find(id: string): Promise<PurchaseRecord | null> {
    if (!isPurchaseId(id)) return null;
    const res = await this.db.query(`SELECT ${COLUMNS} FROM purchases WHERE id = $1::uuid`, [id]);
    const row = res.rows[0] as PurchaseRow | undefined;
    return row ? rowToPurchase(row) : null;
  }

  async list(opts?: PurchaseListOptions): Promise<PurchaseRecord[]> {
    if (impossible(opts)) return [];
    const { limit, offset } = normalizePaging(opts);
    const { where, values } = filters(opts);
    values.push(limit, offset);
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM purchases ${where}
        ORDER BY created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return (res.rows as PurchaseRow[]).map(rowToPurchase);
  }

  async count(opts?: Omit<PurchaseListOptions, "limit" | "offset">): Promise<number> {
    if (impossible(opts)) return 0;
    const { where, values } = filters(opts);
    const res = await this.db.query(`SELECT COUNT(*)::int AS n FROM purchases ${where}`, values);
    return Number((res.rows[0] as { n: number } | undefined)?.n ?? 0);
  }

  async setHandedOver(id: string, handedOver: boolean): Promise<PurchaseRecord> {
    if (!isPurchaseId(id)) throw noPurchase(id);
    const res = await this.db.query(
      `UPDATE purchases
          SET handed_over_at = CASE WHEN $2::boolean THEN COALESCE(handed_over_at, now()) ELSE NULL END
        WHERE id = $1::uuid AND status = 'paid'
       RETURNING ${COLUMNS}`,
      [id, handedOver],
    );
    const row = res.rows[0] as PurchaseRow | undefined;
    if (row) return rowToPurchase(row);
    const current = await this.find(id);
    if (!current) throw noPurchase(id);
    throw notPaid(id, current.status);
  }

  async unitsTaken(eventId: EventId): Promise<Record<string, number>> {
    if (!isPossibleEventId(eventId)) return {};
    const res = await this.db.query(
      `SELECT item_id::text AS item_id, SUM(quantity)::int AS taken
         FROM purchases WHERE event_id = $1 AND ${TAKEN} GROUP BY item_id`,
      [eventId],
    );
    const out: Record<string, number> = {};
    for (const row of res.rows as Array<{ item_id: string; taken: number }>) out[row.item_id] = Number(row.taken);
    return out;
  }

  async salesByVendor(opts?: { eventId?: EventId }): Promise<VendorSales[]> {
    if (opts?.eventId !== undefined && !isPossibleEventId(opts.eventId)) return [];
    const values: unknown[] = [];
    let where = "p.status = 'paid'";
    if (opts?.eventId !== undefined) {
      values.push(opts.eventId);
      where += " AND p.event_id = $1";
    }
    const res = await this.db.query(
      `SELECT p.vendor_id::text AS vendor_id, p.event_id, v.name AS vendor_name,
              COUNT(*)::int AS orders, SUM(p.quantity)::int AS units,
              SUM(p.amount_drops)::text AS total_drops, COUNT(p.handed_over_at)::int AS handed_over
         FROM purchases p JOIN vendors v ON v.id = p.vendor_id
        WHERE ${where}
        GROUP BY p.vendor_id, p.event_id, v.name
        ORDER BY p.event_id ASC, v.name ASC, p.vendor_id ASC`,
      values,
    );
    return (
      res.rows as Array<{
        vendor_id: string;
        event_id: number;
        vendor_name: string;
        orders: number;
        units: number;
        total_drops: string;
        handed_over: number;
      }>
    ).map((row) => ({
      vendorId: row.vendor_id,
      eventId: Number(row.event_id),
      vendorName: row.vendor_name,
      orders: Number(row.orders),
      units: Number(row.units),
      totalXrp: dropsToXrpString(BigInt(row.total_drops)),
      handedOver: Number(row.handed_over),
    }));
  }
}

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

interface StoredPurchase {
  seq: number;
  record: PurchaseRecord;
}

/**
 * The in-memory twin. It reads the item's stock from the vendor store the way
 * the Postgres version reads vendor_items, and it answers the vendor store's
 * "does this have orders" question the way a foreign key would.
 */
export class MemoryPurchaseRepository implements PurchaseRepository {
  private readonly rows: StoredPurchase[] = [];
  private seq = 0;

  constructor(
    private readonly vendors: Pick<VendorRepository, "findItem" | "findVendor">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  vendorHasOrders(vendorId: string): boolean {
    return this.rows.some((r) => r.record.vendorId === vendorId);
  }

  itemHasOrders(itemId: string): boolean {
    return this.rows.some((r) => r.record.itemId === itemId);
  }

  /** The item lookup stands in for the foreign key and is awaited FIRST. */
  async reserve(input: PurchaseReserveInput): Promise<PurchaseReserveOutcome> {
    const { unit, amount } = parseReserve(input);
    const item = await this.vendors.findItem(input.itemId);
    if (!item || item.vendorId !== input.vendorId || item.eventId !== input.eventId) throw noItem(input);

    // ---- no await from here to the push ------------------------------------
    if (this.rows.some((r) => r.record.id === input.id)) {
      throw new XrplLayerError("CONFLICT", `Order ${input.id} already exists.`, { purchaseId: input.id });
    }
    const at = this.now();
    if (item.stock !== null) {
      const taken = this.taken(input.itemId, at);
      if (taken + input.quantity > item.stock) {
        return { ok: false, reason: "sold_out", remaining: Math.max(0, item.stock - taken) };
      }
    }
    const open = this.rows.filter(
      (r) =>
        r.record.eventId === input.eventId &&
        r.record.buyerAddress === input.buyerAddress &&
        r.record.status === "reserved" &&
        r.record.expiresAt.getTime() > at.getTime(),
    ).length;
    if (open >= input.maxOpenPerBuyer) return { ok: false, reason: "too_many_open", open };

    const record: PurchaseRecord = {
      id: input.id,
      eventId: input.eventId,
      vendorId: input.vendorId,
      itemId: input.itemId,
      buyerAddress: input.buyerAddress,
      vendorAddress: input.vendorAddress,
      vendorName: input.vendorName,
      itemName: input.itemName,
      quantity: input.quantity,
      unitPriceXrp: dropsToXrpString(unit),
      amountXrp: dropsToXrpString(amount),
      status: "reserved",
      xamanUuid: null,
      txHash: null,
      createdAt: at,
      expiresAt: new Date(input.expiresAt.getTime()),
      paidAt: null,
      handedOverAt: null,
    };
    this.rows.push({ seq: ++this.seq, record });
    // ---- end of critical section --------------------------------------------

    return { ok: true, purchase: clone(record) };
  }

  async attachPayload(id: string, xamanUuid: string): Promise<void> {
    const row = this.row(id);
    if (!row) throw noPurchase(id);
    row.record.xamanUuid = xamanUuid;
  }

  async markPaid(id: string, txHash: string): Promise<PurchaseRecord> {
    const row = this.row(id);
    if (!row) throw noPurchase(id);
    if (row.record.status === "paid") {
      if (row.record.txHash === txHash) return clone(row.record);
      throw new XrplLayerError("CONFLICT", `Order ${id} was already paid by a different payment.`, {
        purchaseId: id,
        txHash,
        paidWith: row.record.txHash,
      });
    }
    if (this.rows.some((r) => r !== row && r.record.txHash === txHash)) throw hashUsed(id, txHash);
    row.record.status = "paid";
    row.record.txHash = txHash;
    row.record.paidAt = this.now();
    return clone(row.record);
  }

  async markExpired(id: string): Promise<PurchaseRecord | null> {
    const row = this.row(id);
    if (!row || row.record.status !== "reserved") return null;
    row.record.status = "expired";
    return clone(row.record);
  }

  async find(id: string): Promise<PurchaseRecord | null> {
    const row = this.row(id);
    return row ? clone(row.record) : null;
  }

  async list(opts?: PurchaseListOptions): Promise<PurchaseRecord[]> {
    const { limit, offset } = normalizePaging(opts);
    return this.matching(opts)
      .sort((a, b) => b.record.createdAt.getTime() - a.record.createdAt.getTime() || b.seq - a.seq)
      .slice(offset, offset + limit)
      .map((r) => clone(r.record));
  }

  async count(opts?: Omit<PurchaseListOptions, "limit" | "offset">): Promise<number> {
    return this.matching(opts).length;
  }

  async setHandedOver(id: string, handedOver: boolean): Promise<PurchaseRecord> {
    const row = this.row(id);
    if (!row) throw noPurchase(id);
    if (row.record.status !== "paid") throw notPaid(id, row.record.status);
    row.record.handedOverAt = handedOver ? (row.record.handedOverAt ?? this.now()) : null;
    return clone(row.record);
  }

  async unitsTaken(eventId: EventId): Promise<Record<string, number>> {
    const at = this.now();
    const out: Record<string, number> = {};
    for (const { record } of this.rows) {
      if (record.eventId !== eventId || !isTaken(record, at)) continue;
      out[record.itemId] = (out[record.itemId] ?? 0) + record.quantity;
    }
    return out;
  }

  async salesByVendor(opts?: { eventId?: EventId }): Promise<VendorSales[]> {
    const byVendor = new Map<string, { eventId: EventId; orders: number; units: number; total: bigint; handedOver: number }>();
    for (const { record } of this.rows) {
      if (record.status !== "paid") continue;
      if (opts?.eventId !== undefined && record.eventId !== opts.eventId) continue;
      const entry = byVendor.get(record.vendorId) ?? {
        eventId: record.eventId,
        orders: 0,
        units: 0,
        total: 0n,
        handedOver: 0,
      };
      entry.orders += 1;
      entry.units += record.quantity;
      entry.total += xrpToDropsBigInt(record.amountXrp);
      if (record.handedOverAt) entry.handedOver += 1;
      byVendor.set(record.vendorId, entry);
    }

    const out: VendorSales[] = [];
    for (const [vendorId, entry] of byVendor) {
      // The vendor's name as it is now, as the join does.
      const vendor = await this.vendors.findVendor(vendorId);
      out.push({
        vendorId,
        eventId: entry.eventId,
        vendorName: vendor?.name ?? "",
        orders: entry.orders,
        units: entry.units,
        totalXrp: dropsToXrpString(entry.total),
        handedOver: entry.handedOver,
      });
    }
    return out.sort(
      (a, b) =>
        a.eventId - b.eventId ||
        (a.vendorName < b.vendorName ? -1 : a.vendorName > b.vendorName ? 1 : 0) ||
        Number(a.vendorId) - Number(b.vendorId),
    );
  }

  private row(id: string): StoredPurchase | undefined {
    return this.rows.find((r) => r.record.id === id);
  }

  private taken(itemId: string, at: Date): number {
    let total = 0;
    for (const { record } of this.rows) {
      if (record.itemId === itemId && isTaken(record, at)) total += record.quantity;
    }
    return total;
  }

  private matching(opts: Omit<PurchaseListOptions, "limit" | "offset"> | undefined): StoredPurchase[] {
    return this.rows.filter(
      ({ record }) =>
        (opts?.eventId === undefined || record.eventId === opts.eventId) &&
        (opts?.vendorId === undefined || record.vendorId === opts.vendorId) &&
        (opts?.buyerAddress === undefined || record.buyerAddress === opts.buyerAddress) &&
        (opts?.status === undefined || record.status === opts.status),
    );
  }
}

function isTaken(record: PurchaseRecord, at: Date): boolean {
  return record.status === "paid" || (record.status === "reserved" && record.expiresAt.getTime() > at.getTime());
}

function clone(record: PurchaseRecord): PurchaseRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt.getTime()),
    expiresAt: new Date(record.expiresAt.getTime()),
    paidAt: record.paidAt ? new Date(record.paidAt.getTime()) : null,
    handedOverAt: record.handedOverAt ? new Date(record.handedOverAt.getTime()) : null,
  };
}
