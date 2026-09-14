/**
 * Vendors, their price lists, and what they sold — from the organiser's side.
 *
 *   GET    /admin/api/events/:eventId/vendors       vendors, items, stock left
 *   POST   /admin/api/events/:eventId/vendors       add a vendor
 *   PATCH  /admin/api/vendors/:vendorId             rename, rewallet, hide
 *   DELETE /admin/api/vendors/:vendorId             only with no orders
 *   POST   /admin/api/vendors/:vendorId/items       add an item
 *   PATCH  /admin/api/items/:itemId                 price, stock, hide
 *   DELETE /admin/api/items/:itemId                 only with no orders
 *   GET    /admin/api/purchases                     every order, filterable
 *   GET    /admin/api/sales                         paid orders, added up per vendor
 *
 * A VENDOR'S WALLET IS CHECKED AGAINST THE LEDGER BEFORE IT IS SAVED. Attendees
 * are about to be sent to pay it, and two kinds of address accept an address
 * field and then bounce every payment: one that insists on a destination tag
 * (an exchange), and one that only takes payments it has authorised. Each is
 * refused here, with the reason, rather than discovered at the counter by a
 * queue of people.
 *
 * A wallet that does not exist on the ledger yet is fine. A vendor only
 * receives, and the first payment of at least the base reserve creates the
 * account. The ledger will not deliver less than that to it, so placeOrder()
 * refuses a smaller order until the wallet exists.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { NotFoundError, XrplLayerError } from "../../errors.js";
import { dropsToXrpString, isXrpAmount, xrpToDropsBigInt } from "../../money.js";
import type { EventId, VendorItemRecord, VendorRecord } from "../../types.js";
import type { ApiDeps } from "../deps.js";
import { addressSchema, eventIdParamsSchema, sendError, type EventIdParams } from "../http-errors.js";
import { toPurchaseView } from "../purchases.js";
import { adminGuard } from "./events.js";

const ROW_ID = /^[1-9]\d{0,17}$/;

const vendorParamsSchema = z.object({ vendorId: z.string().regex(ROW_ID) });
const itemParamsSchema = z.object({ itemId: z.string().regex(ROW_ID) });
type VendorParams = z.infer<typeof vendorParamsSchema>;
type ItemParams = z.infer<typeof itemParamsSchema>;

const nameSchema = z.string().trim().min(1).max(120);
const priceSchema = z
  .string()
  .trim()
  .max(24)
  .refine(isXrpAmount, "A plain XRP amount with at most six decimal places, like 2.5")
  .refine((v) => !isXrpAmount(v) || xrpToDropsBigInt(v) > 0n, "A price must be more than zero");
const stockSchema = z.number().int().min(0).max(1_000_000).nullable();

const createVendorSchema = z.object({ name: nameSchema, walletAddress: addressSchema }).strict();
const updateVendorSchema = z
  .object({ name: nameSchema.optional(), walletAddress: addressSchema.optional(), active: z.boolean().optional() })
  .strict();
const createItemSchema = z
  .object({ name: nameSchema, priceXrp: priceSchema, stock: stockSchema.optional() })
  .strict();
const updateItemSchema = z
  .object({
    name: nameSchema.optional(),
    priceXrp: priceSchema.optional(),
    stock: stockSchema.optional(),
    active: z.boolean().optional(),
  })
  .strict();

const purchasesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  eventId: z.coerce.number().int().min(0).optional(),
  vendorId: z.string().regex(ROW_ID).optional(),
  status: z.enum(["reserved", "paid", "expired"]).optional(),
});
const salesQuerySchema = z.object({ eventId: z.coerce.number().int().min(0).optional() });

type CreateVendorBody = z.infer<typeof createVendorSchema>;
type UpdateVendorBody = z.infer<typeof updateVendorSchema>;
type CreateItemBody = z.infer<typeof createItemSchema>;
type UpdateItemBody = z.infer<typeof updateItemSchema>;
type PurchasesQuery = z.infer<typeof purchasesQuerySchema>;
type SalesQuery = z.infer<typeof salesQuerySchema>;

export function vendorView(vendor: VendorRecord) {
  return {
    id: vendor.id,
    eventId: vendor.eventId,
    name: vendor.name,
    walletAddress: vendor.walletAddress,
    active: vendor.active,
    createdAt: vendor.createdAt?.toISOString() ?? null,
    updatedAt: vendor.updatedAt?.toISOString() ?? null,
  };
}

export function itemView(item: VendorItemRecord, taken: number) {
  return {
    id: item.id,
    vendorId: item.vendorId,
    name: item.name,
    priceXrp: item.priceXrp,
    stock: item.stock,
    /** Paid, plus reservations still waiting to be paid. */
    taken,
    remaining: item.stock === null ? null : Math.max(0, item.stock - taken),
    active: item.active,
  };
}

/**
 * Refuse a wallet attendees could not actually pay. Throws CONFLICT, with a
 * sentence the organiser can act on.
 */
export async function assertPayableWallet(deps: ApiDeps, eventId: EventId, walletAddress: string): Promise<void> {
  if (walletAddress === deps.gateway.issuerAddress) {
    throw new XrplLayerError("CONFLICT", "That is the issuer's wallet. A vendor needs a wallet of its own.", {
      walletAddress,
    });
  }
  const treasury = deps.treasuries ? await deps.treasuries.find(eventId) : null;
  if (treasury?.address === walletAddress) {
    throw new XrplLayerError("CONFLICT", "That is this event's treasury. A vendor needs a wallet of its own.", {
      walletAddress,
    });
  }

  // A wallet that does not exist yet has neither flag, and passes.
  const account = await deps.chain.readAccount(deps.gateway, walletAddress);
  if (account.requireDestTag) {
    throw new XrplLayerError(
      "CONFLICT",
      "That wallet only accepts payments with a destination tag, which usually means it belongs to an " +
        "exchange. A vendor needs a wallet they hold themselves, such as Xaman.",
      { walletAddress, reason: "requires_destination_tag" },
    );
  }
  if (account.depositAuth) {
    throw new XrplLayerError(
      "CONFLICT",
      "That wallet only accepts payments from accounts it has authorised, so attendees could not pay it.",
      { walletAddress, reason: "deposit_auth" },
    );
  }
}

export function registerVendorRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { events, vendors } = deps;
  if (!events || !vendors) return;
  const guard = adminGuard(deps);

  const eventOr404 = async (eventId: EventId) => {
    const event = await events.find(eventId);
    if (!event) throw new NotFoundError(`No event ${eventId}.`, { eventId });
    return event;
  };

  const vendorOr404 = async (vendorId: string) => {
    const vendor = await vendors.findVendor(vendorId);
    if (!vendor) throw new NotFoundError(`No vendor ${vendorId}.`, { vendorId });
    return vendor;
  };

  /** One event's vendors, each with its items and what is left of them. */
  const eventVendors = async (eventId: EventId) => {
    const [rows, items, taken] = await Promise.all([
      vendors.listVendors(eventId),
      vendors.listItems(eventId),
      deps.purchases ? deps.purchases.unitsTaken(eventId) : Promise.resolve({} as Record<string, number>),
    ]);
    return rows.map((vendor) => ({
      ...vendorView(vendor),
      items: items.filter((i) => i.vendorId === vendor.id).map((i) => itemView(i, taken[i.id] ?? 0)),
    }));
  };

  app.get<{ Params: EventIdParams }>(
    "/admin/api/events/:eventId/vendors",
    { schema: { params: eventIdParamsSchema }, preHandler: guard },
    async (request, reply) => {
      const { eventId } = request.params;
      await eventOr404(eventId);
      return reply.code(200).send({ eventId, vendors: await eventVendors(eventId) });
    },
  );

  app.post<{ Params: EventIdParams; Body: CreateVendorBody }>(
    "/admin/api/events/:eventId/vendors",
    { schema: { params: eventIdParamsSchema, body: createVendorSchema }, preHandler: guard },
    async (request, reply) => {
      const { eventId } = request.params;
      await eventOr404(eventId);
      await assertPayableWallet(deps, eventId, request.body.walletAddress);
      const vendor = await vendors.createVendor({ eventId, ...request.body });
      request.log.info({ eventId, vendorId: vendor.id, admin: request.admin?.email }, "vendor added");
      return reply.code(201).send({ vendor: { ...vendorView(vendor), items: [] } });
    },
  );

  app.patch<{ Params: VendorParams; Body: UpdateVendorBody }>(
    "/admin/api/vendors/:vendorId",
    { schema: { params: vendorParamsSchema, body: updateVendorSchema }, preHandler: guard },
    async (request, reply) => {
      const current = await vendorOr404(request.params.vendorId);
      const body = request.body;
      if (Object.keys(body).length === 0) {
        return sendError(reply, 400, "INVALID_INPUT", "Nothing to update. Send name, walletAddress or active.");
      }
      if (body.walletAddress !== undefined && body.walletAddress !== current.walletAddress) {
        await assertPayableWallet(deps, current.eventId, body.walletAddress);
      }
      const vendor = await vendors.updateVendor(current.id, body);
      return reply.code(200).send({ vendor: vendorView(vendor) });
    },
  );

  app.delete<{ Params: VendorParams }>(
    "/admin/api/vendors/:vendorId",
    { schema: { params: vendorParamsSchema }, preHandler: guard },
    async (request, reply) => {
      const removed = await vendors.deleteVendor(request.params.vendorId);
      if (!removed) return sendError(reply, 404, "NOT_FOUND", `No vendor ${request.params.vendorId}.`);
      return reply.code(200).send({ removed: true, id: request.params.vendorId });
    },
  );

  app.post<{ Params: VendorParams; Body: CreateItemBody }>(
    "/admin/api/vendors/:vendorId/items",
    { schema: { params: vendorParamsSchema, body: createItemSchema }, preHandler: guard },
    async (request, reply) => {
      await vendorOr404(request.params.vendorId);
      const item = await vendors.createItem({ vendorId: request.params.vendorId, ...request.body });
      return reply.code(201).send({ item: itemView(item, 0) });
    },
  );

  app.patch<{ Params: ItemParams; Body: UpdateItemBody }>(
    "/admin/api/items/:itemId",
    { schema: { params: itemParamsSchema, body: updateItemSchema }, preHandler: guard },
    async (request, reply) => {
      const current = await vendors.findItem(request.params.itemId);
      if (!current) return sendError(reply, 404, "NOT_FOUND", `No item ${request.params.itemId}.`);
      if (Object.keys(request.body).length === 0) {
        return sendError(reply, 400, "INVALID_INPUT", "Nothing to update. Send name, priceXrp, stock or active.");
      }
      const item = await vendors.updateItem(current.id, request.body);
      const taken = deps.purchases ? await deps.purchases.unitsTaken(item.eventId) : {};
      return reply.code(200).send({ item: itemView(item, taken[item.id] ?? 0) });
    },
  );

  app.delete<{ Params: ItemParams }>(
    "/admin/api/items/:itemId",
    { schema: { params: itemParamsSchema }, preHandler: guard },
    async (request, reply) => {
      const removed = await vendors.deleteItem(request.params.itemId);
      if (!removed) return sendError(reply, 404, "NOT_FOUND", `No item ${request.params.itemId}.`);
      return reply.code(200).send({ removed: true, id: request.params.itemId });
    },
  );

  const purchases = deps.purchases;
  if (!purchases) return;

  /**
   * GET /admin/api/purchases?eventId=&vendorId=&status=&limit=&offset=
   *
   * Every order, newest first. `total` counts the filter, so the pager is honest.
   */
  app.get<{ Querystring: PurchasesQuery }>(
    "/admin/api/purchases",
    { schema: { querystring: purchasesQuerySchema }, preHandler: guard },
    async (request, reply) => {
      const { limit, offset, eventId, vendorId, status } = request.query;
      const filter = {
        ...(eventId === undefined ? {} : { eventId }),
        ...(vendorId === undefined ? {} : { vendorId }),
        ...(status === undefined ? {} : { status }),
      };
      const [rows, total] = await Promise.all([
        purchases.list({ ...filter, limit, offset }),
        purchases.count(filter),
      ]);
      return reply.code(200).send({
        limit,
        offset,
        eventId: eventId ?? null,
        total,
        purchases: rows.map(toPurchaseView),
      });
    },
  );

  /**
   * GET /admin/api/sales?eventId=
   *
   * Paid orders only, added up per vendor. What each counter took, in XRP that
   * went straight to its own wallet, and how much of it has left the counter.
   */
  app.get<{ Querystring: SalesQuery }>(
    "/admin/api/sales",
    { schema: { querystring: salesQuerySchema }, preHandler: guard },
    async (request, reply) => {
      const { eventId } = request.query;
      const rows = await purchases.salesByVendor(eventId === undefined ? {} : { eventId });
      let total = 0n;
      let orders = 0;
      let units = 0;
      let handedOver = 0;
      for (const row of rows) {
        total += xrpToDropsBigInt(row.totalXrp);
        orders += row.orders;
        units += row.units;
        handedOver += row.handedOver;
      }
      return reply.code(200).send({
        eventId: eventId ?? null,
        vendors: rows,
        totals: { orders, units, totalXrp: dropsToXrpString(total), handedOver },
      });
    },
  );
}
