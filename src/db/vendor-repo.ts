/**
 * Vendors at an event, and their price lists.
 *
 * A vendor is a name and a wallet. Attendees pay that wallet directly, so the
 * address is checked twice before it is stored: here, that it is an address at
 * all, and in the route, that the ledger will actually accept a payment into it.
 * A price list that points attendees at a wallet nobody can receive into is a
 * queue of people who paid for nothing.
 *
 * NOTHING HERE IS DELETED OUT FROM UNDER AN ORDER. A vendor or an item somebody
 * has ordered is hidden, not deleted; delete() says CONFLICT and why.
 */
import { NotFoundError, ValidationError, XrplLayerError } from "../errors.js";
import { dropsToXrpString, xrpToDropsBigInt } from "../money.js";
import type { EventId, EventRepository, VendorItemRecord, VendorRecord, VendorRepository } from "../types.js";
import { assertValidAddress } from "../xrpl/encoding.js";
import { assertValidEventId, isPossibleEventId } from "./event-repo.js";
import type { Queryable } from "./pool.js";

export const MAX_NAME_LENGTH = 120;
/** Enough for any real counter; small enough that a typo of three extra zeros is refused. */
export const MAX_STOCK = 1_000_000;

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" ? (err as { code?: string }).code : undefined;
}

/** Ids are bigserial rendered as text. Anything else names no row. */
export function isRowId(id: string): boolean {
  return typeof id === "string" && /^[1-9]\d{0,17}$/.test(id);
}

// ---------------------------------------------------------------------------
// Validation, shared by both implementations
// ---------------------------------------------------------------------------

export function normalizeName(raw: unknown, label: string): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name === "" || name.length > MAX_NAME_LENGTH) {
    throw new ValidationError(
      "INVALID_INPUT",
      `A ${label} name is required, and at most ${MAX_NAME_LENGTH} characters.`,
      { label, length: name.length },
    );
  }
  return name;
}

/** Decimal XRP, more than zero, in the one spelling both stores keep. */
export function normalizePrice(raw: unknown): string {
  const drops = xrpToDropsBigInt(String(raw ?? ""), "priceXrp");
  if (drops <= 0n) {
    throw new ValidationError("INVALID_INPUT", "A price must be more than zero.", { priceXrp: raw });
  }
  return dropsToXrpString(drops);
}

export function normalizeStock(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_STOCK) {
    throw new ValidationError(
      "INVALID_INPUT",
      `Stock is a whole number from 0 to ${MAX_STOCK}, or empty for no limit.`,
      { stock: raw },
    );
  }
  return raw;
}

function walletTaken(eventId: EventId, walletAddress: string): XrplLayerError {
  return new XrplLayerError(
    "CONFLICT",
    "That wallet is already a vendor at this event. Each vendor needs a wallet of its own, or " +
      "they would see each other's orders.",
    { eventId, walletAddress },
  );
}

function hasOrders(kind: "vendor" | "item", id: string): XrplLayerError {
  return new XrplLayerError(
    "CONFLICT",
    `This ${kind} has orders, so it cannot be deleted. Hide it instead: it stops selling and keeps ` +
      "its history.",
    { kind, id },
  );
}

function noVendor(id: string): NotFoundError {
  return new NotFoundError(`No vendor ${id}.`, { vendorId: id });
}

function noItem(id: string): NotFoundError {
  return new NotFoundError(`No item ${id}.`, { itemId: id });
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface VendorRow {
  id: string | number;
  event_id: number;
  name: string;
  wallet_address: string;
  active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ItemRow {
  id: string | number;
  vendor_id: string | number;
  event_id: number;
  name: string;
  price_drops: string;
  stock: number | null;
  active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

const VENDOR_COLUMNS = "id, event_id, name, wallet_address, active, created_at, updated_at";
const ITEM_COLUMNS =
  "id, vendor_id, event_id, name, price_drops::text AS price_drops, stock, active, created_at, updated_at";

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function rowToVendor(row: VendorRow): VendorRecord {
  return {
    id: String(row.id),
    eventId: Number(row.event_id),
    name: row.name,
    walletAddress: row.wallet_address,
    active: row.active,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function rowToItem(row: ItemRow): VendorItemRecord {
  return {
    id: String(row.id),
    vendorId: String(row.vendor_id),
    eventId: Number(row.event_id),
    name: row.name,
    priceXrp: dropsToXrpString(BigInt(row.price_drops)),
    stock: row.stock === null ? null : Number(row.stock),
    active: row.active,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

export class PgVendorRepository implements VendorRepository {
  constructor(private readonly db: Queryable) {}

  async createVendor(input: {
    eventId: EventId;
    name: string;
    walletAddress: string;
    active?: boolean;
  }): Promise<VendorRecord> {
    assertValidEventId(input.eventId);
    const name = normalizeName(input.name, "vendor");
    assertValidAddress(input.walletAddress, "vendor wallet");

    try {
      const res = await this.db.query(
        `INSERT INTO vendors (event_id, name, wallet_address, active)
         VALUES ($1, $2, $3, $4) RETURNING ${VENDOR_COLUMNS}`,
        [input.eventId, name, input.walletAddress, input.active ?? true],
      );
      return rowToVendor(res.rows[0] as VendorRow);
    } catch (err) {
      if (pgCode(err) === FOREIGN_KEY_VIOLATION) {
        throw new NotFoundError(`No event ${input.eventId} to add a vendor to.`, { eventId: input.eventId });
      }
      if (pgCode(err) === UNIQUE_VIOLATION) throw walletTaken(input.eventId, input.walletAddress);
      throw err;
    }
  }

  async updateVendor(
    id: string,
    patch: { name?: string; walletAddress?: string; active?: boolean },
  ): Promise<VendorRecord> {
    if (!isRowId(id)) throw noVendor(id);
    const sets: string[] = [];
    const values: unknown[] = [id];
    if (patch.name !== undefined) {
      values.push(normalizeName(patch.name, "vendor"));
      sets.push(`name = $${values.length}`);
    }
    if (patch.walletAddress !== undefined) {
      assertValidAddress(patch.walletAddress, "vendor wallet");
      values.push(patch.walletAddress);
      sets.push(`wallet_address = $${values.length}`);
    }
    if (patch.active !== undefined) {
      values.push(Boolean(patch.active));
      sets.push(`active = $${values.length}`);
    }
    if (sets.length === 0) {
      const current = await this.findVendor(id);
      if (!current) throw noVendor(id);
      return current;
    }
    sets.push("updated_at = now()");

    try {
      const res = await this.db.query(
        `UPDATE vendors SET ${sets.join(", ")} WHERE id = $1::bigint RETURNING ${VENDOR_COLUMNS}`,
        values,
      );
      const row = res.rows[0] as VendorRow | undefined;
      if (!row) throw noVendor(id);
      return rowToVendor(row);
    } catch (err) {
      if (pgCode(err) === UNIQUE_VIOLATION) {
        const current = await this.findVendor(id);
        throw walletTaken(current?.eventId ?? 0, patch.walletAddress ?? "");
      }
      throw err;
    }
  }

  async deleteVendor(id: string): Promise<boolean> {
    if (!isRowId(id)) return false;
    try {
      const res = await this.db.query("DELETE FROM vendors WHERE id = $1::bigint RETURNING id", [id]);
      return res.rows.length > 0;
    } catch (err) {
      if (pgCode(err) === FOREIGN_KEY_VIOLATION) throw hasOrders("vendor", id);
      throw err;
    }
  }

  async findVendor(id: string): Promise<VendorRecord | null> {
    if (!isRowId(id)) return null;
    const res = await this.db.query(`SELECT ${VENDOR_COLUMNS} FROM vendors WHERE id = $1::bigint`, [id]);
    const row = res.rows[0] as VendorRow | undefined;
    return row ? rowToVendor(row) : null;
  }

  async listVendors(eventId: EventId): Promise<VendorRecord[]> {
    if (!isPossibleEventId(eventId)) return [];
    const res = await this.db.query(
      `SELECT ${VENDOR_COLUMNS} FROM vendors WHERE event_id = $1 ORDER BY id ASC`,
      [eventId],
    );
    return (res.rows as VendorRow[]).map(rowToVendor);
  }

  async listVendorsByWallet(walletAddress: string): Promise<VendorRecord[]> {
    const res = await this.db.query(
      `SELECT ${VENDOR_COLUMNS} FROM vendors WHERE wallet_address = $1 ORDER BY id ASC`,
      [walletAddress],
    );
    return (res.rows as VendorRow[]).map(rowToVendor);
  }

  async createItem(input: {
    vendorId: string;
    name: string;
    priceXrp: string;
    stock?: number | null;
    active?: boolean;
  }): Promise<VendorItemRecord> {
    const name = normalizeName(input.name, "item");
    const price = xrpToDropsBigInt(normalizePrice(input.priceXrp), "priceXrp");
    const stock = normalizeStock(input.stock);
    if (!isRowId(input.vendorId)) throw noVendor(input.vendorId);

    const res = await this.db.query(
      `INSERT INTO vendor_items (vendor_id, event_id, name, price_drops, stock, active)
       SELECT v.id, v.event_id, $2, $3::bigint, $4::integer, $5
         FROM vendors v WHERE v.id = $1::bigint
       RETURNING ${ITEM_COLUMNS}`,
      [input.vendorId, name, price.toString(), stock, input.active ?? true],
    );
    const row = res.rows[0] as ItemRow | undefined;
    if (!row) throw noVendor(input.vendorId);
    return rowToItem(row);
  }

  async updateItem(
    id: string,
    patch: { name?: string; priceXrp?: string; stock?: number | null; active?: boolean },
  ): Promise<VendorItemRecord> {
    if (!isRowId(id)) throw noItem(id);
    const sets: string[] = [];
    const values: unknown[] = [id];
    if (patch.name !== undefined) {
      values.push(normalizeName(patch.name, "item"));
      sets.push(`name = $${values.length}`);
    }
    if (patch.priceXrp !== undefined) {
      values.push(xrpToDropsBigInt(normalizePrice(patch.priceXrp), "priceXrp").toString());
      sets.push(`price_drops = $${values.length}::bigint`);
    }
    if (patch.stock !== undefined) {
      values.push(normalizeStock(patch.stock));
      sets.push(`stock = $${values.length}::integer`);
    }
    if (patch.active !== undefined) {
      values.push(Boolean(patch.active));
      sets.push(`active = $${values.length}`);
    }
    if (sets.length === 0) {
      const current = await this.findItem(id);
      if (!current) throw noItem(id);
      return current;
    }
    sets.push("updated_at = now()");

    const res = await this.db.query(
      `UPDATE vendor_items SET ${sets.join(", ")} WHERE id = $1::bigint RETURNING ${ITEM_COLUMNS}`,
      values,
    );
    const row = res.rows[0] as ItemRow | undefined;
    if (!row) throw noItem(id);
    return rowToItem(row);
  }

  async deleteItem(id: string): Promise<boolean> {
    if (!isRowId(id)) return false;
    try {
      const res = await this.db.query("DELETE FROM vendor_items WHERE id = $1::bigint RETURNING id", [id]);
      return res.rows.length > 0;
    } catch (err) {
      if (pgCode(err) === FOREIGN_KEY_VIOLATION) throw hasOrders("item", id);
      throw err;
    }
  }

  async findItem(id: string): Promise<VendorItemRecord | null> {
    if (!isRowId(id)) return null;
    const res = await this.db.query(`SELECT ${ITEM_COLUMNS} FROM vendor_items WHERE id = $1::bigint`, [id]);
    const row = res.rows[0] as ItemRow | undefined;
    return row ? rowToItem(row) : null;
  }

  async listItems(eventId: EventId): Promise<VendorItemRecord[]> {
    if (!isPossibleEventId(eventId)) return [];
    const res = await this.db.query(
      `SELECT ${ITEM_COLUMNS} FROM vendor_items WHERE event_id = $1 ORDER BY id ASC`,
      [eventId],
    );
    return (res.rows as ItemRow[]).map(rowToItem);
  }
}

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

/**
 * What the in-memory store asks before deleting, where Postgres has a foreign
 * key from purchases. Bound by createMemoryStores() once the purchase store
 * exists; with nothing bound, nothing counts as having orders.
 */
export interface OrderReferences {
  vendorHasOrders(vendorId: string): boolean;
  itemHasOrders(itemId: string): boolean;
}

export class MemoryVendorRepository implements VendorRepository {
  private readonly vendors: VendorRecord[] = [];
  private readonly items: VendorItemRecord[] = [];
  private vendorSeq = 0;
  private itemSeq = 0;
  private orders: OrderReferences | undefined;

  constructor(
    private readonly events?: Pick<EventRepository, "find">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  bindOrders(orders: OrderReferences): void {
    this.orders = orders;
  }

  async createVendor(input: {
    eventId: EventId;
    name: string;
    walletAddress: string;
    active?: boolean;
  }): Promise<VendorRecord> {
    assertValidEventId(input.eventId);
    const name = normalizeName(input.name, "vendor");
    assertValidAddress(input.walletAddress, "vendor wallet");
    if (this.events && !(await this.events.find(input.eventId))) {
      throw new NotFoundError(`No event ${input.eventId} to add a vendor to.`, { eventId: input.eventId });
    }

    // ---- no await from here to the push ------------------------------------
    if (this.vendors.some((v) => v.eventId === input.eventId && v.walletAddress === input.walletAddress)) {
      throw walletTaken(input.eventId, input.walletAddress);
    }
    const at = this.now();
    const vendor: VendorRecord = {
      id: String(++this.vendorSeq),
      eventId: input.eventId,
      name,
      walletAddress: input.walletAddress,
      active: input.active ?? true,
      createdAt: at,
      updatedAt: at,
    };
    this.vendors.push(vendor);
    return { ...vendor };
  }

  async updateVendor(
    id: string,
    patch: { name?: string; walletAddress?: string; active?: boolean },
  ): Promise<VendorRecord> {
    const vendor = this.vendors.find((v) => v.id === id);
    if (!vendor) throw noVendor(id);
    const name = patch.name === undefined ? undefined : normalizeName(patch.name, "vendor");
    if (patch.walletAddress !== undefined) {
      assertValidAddress(patch.walletAddress, "vendor wallet");
      const clash = this.vendors.some(
        (v) => v !== vendor && v.eventId === vendor.eventId && v.walletAddress === patch.walletAddress,
      );
      if (clash) throw walletTaken(vendor.eventId, patch.walletAddress);
    }

    let touched = false;
    if (name !== undefined) {
      vendor.name = name;
      touched = true;
    }
    if (patch.walletAddress !== undefined) {
      vendor.walletAddress = patch.walletAddress;
      touched = true;
    }
    if (patch.active !== undefined) {
      vendor.active = Boolean(patch.active);
      touched = true;
    }
    if (touched) vendor.updatedAt = this.now();
    return { ...vendor };
  }

  async deleteVendor(id: string): Promise<boolean> {
    const at = this.vendors.findIndex((v) => v.id === id);
    if (at < 0) return false;
    const itemIds = this.items.filter((i) => i.vendorId === id).map((i) => i.id);
    if (this.orders?.vendorHasOrders(id) || itemIds.some((itemId) => this.orders?.itemHasOrders(itemId))) {
      throw hasOrders("vendor", id);
    }
    this.vendors.splice(at, 1);
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i]?.vendorId === id) this.items.splice(i, 1);
    }
    return true;
  }

  async findVendor(id: string): Promise<VendorRecord | null> {
    const vendor = this.vendors.find((v) => v.id === id);
    return vendor ? { ...vendor } : null;
  }

  async listVendors(eventId: EventId): Promise<VendorRecord[]> {
    return this.vendors.filter((v) => v.eventId === eventId).map((v) => ({ ...v }));
  }

  async listVendorsByWallet(walletAddress: string): Promise<VendorRecord[]> {
    return this.vendors.filter((v) => v.walletAddress === walletAddress).map((v) => ({ ...v }));
  }

  async createItem(input: {
    vendorId: string;
    name: string;
    priceXrp: string;
    stock?: number | null;
    active?: boolean;
  }): Promise<VendorItemRecord> {
    const name = normalizeName(input.name, "item");
    const priceXrp = normalizePrice(input.priceXrp);
    const stock = normalizeStock(input.stock);
    const vendor = this.vendors.find((v) => v.id === input.vendorId);
    if (!vendor) throw noVendor(input.vendorId);

    const at = this.now();
    const item: VendorItemRecord = {
      id: String(++this.itemSeq),
      vendorId: vendor.id,
      eventId: vendor.eventId,
      name,
      priceXrp,
      stock,
      active: input.active ?? true,
      createdAt: at,
      updatedAt: at,
    };
    this.items.push(item);
    return { ...item };
  }

  async updateItem(
    id: string,
    patch: { name?: string; priceXrp?: string; stock?: number | null; active?: boolean },
  ): Promise<VendorItemRecord> {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw noItem(id);
    const name = patch.name === undefined ? undefined : normalizeName(patch.name, "item");
    const priceXrp = patch.priceXrp === undefined ? undefined : normalizePrice(patch.priceXrp);
    const stock = patch.stock === undefined ? undefined : normalizeStock(patch.stock);

    let touched = false;
    if (name !== undefined) {
      item.name = name;
      touched = true;
    }
    if (priceXrp !== undefined) {
      item.priceXrp = priceXrp;
      touched = true;
    }
    if (stock !== undefined) {
      item.stock = stock;
      touched = true;
    }
    if (patch.active !== undefined) {
      item.active = Boolean(patch.active);
      touched = true;
    }
    if (touched) item.updatedAt = this.now();
    return { ...item };
  }

  async deleteItem(id: string): Promise<boolean> {
    const at = this.items.findIndex((i) => i.id === id);
    if (at < 0) return false;
    if (this.orders?.itemHasOrders(id)) throw hasOrders("item", id);
    this.items.splice(at, 1);
    return true;
  }

  async findItem(id: string): Promise<VendorItemRecord | null> {
    const item = this.items.find((i) => i.id === id);
    return item ? { ...item } : null;
  }

  async listItems(eventId: EventId): Promise<VendorItemRecord[]> {
    return this.items.filter((i) => i.eventId === eventId).map((i) => ({ ...i }));
  }
}
