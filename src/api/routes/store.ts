/**
 * The event store, from the attendee's side.
 *
 *   GET  /api/events/:eventId/store                    who sells what, and what is left
 *   GET  /api/events/:eventId/store/wallets/:address   what this wallet can spend, and its orders
 *   POST /api/events/:eventId/purchases                order, and get a Payment to approve
 *   GET  /api/purchases/:purchaseId                    has it been paid?
 *   POST /api/purchases/:purchaseId/confirm            it was paid, here is the hash
 *
 * PUBLIC, LIKE THE PASS THAT CALLS THEM. Nothing here moves money: an order is
 * a request for the buyer to pay, and only a Payment the buyer signs in their
 * own wallet ever does. The protections are about stock, not XRP — an order
 * holds stock, so ordering is rate limited, limited to the event's attendees,
 * and capped at a few unpaid orders per wallet.
 *
 * A VENDOR'S WALLET ADDRESS IS NOT PUBLISHED. The buyer sees it in Xaman when
 * they approve, which is the moment it matters; a public list of every
 * vendor's wallet is not something the store needs to be.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { NotFoundError } from "../../errors.js";
import type { AccountSnapshot } from "../../xrpl/account.js";
import { readAllowanceStatus } from "../allowance.js";
import type { ApiDeps } from "../deps.js";
import {
  addressSchema,
  eventIdParamsSchema,
  eventIdSchema,
  sendError,
  txHashSchema,
  type EventIdParams,
} from "../http-errors.js";
import {
  MAX_ORDER_QUANTITY,
  buyerStanding,
  placeOrder,
  settlerFor,
  toPurchaseView,
} from "../purchases.js";

const ORDER_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;
const POLL_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

/** How many unpaid orders one read will go and settle, so a poll stays quick. */
const SETTLE_PER_READ = 5;

const ROW_ID = /^[1-9]\d{0,17}$/;

const walletParamsSchema = z.object({ eventId: eventIdSchema, address: addressSchema });
const purchaseParamsSchema = z.object({ purchaseId: z.uuid() });
const orderBodySchema = z
  .object({
    address: addressSchema,
    itemId: z.string().regex(ROW_ID),
    quantity: z.number().int().min(1).max(MAX_ORDER_QUANTITY).default(1),
    returnUrl: z.string().url().max(2000).optional(),
  })
  .strict();
const confirmBodySchema = z.object({ txHash: txHashSchema }).strict();

type WalletParams = z.infer<typeof walletParamsSchema>;
type PurchaseParams = z.infer<typeof purchaseParamsSchema>;
type OrderBody = z.infer<typeof orderBodySchema>;
type ConfirmBody = z.infer<typeof confirmBodySchema>;

export function registerStoreRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { events, vendors, purchases } = deps;
  if (!events || !vendors || !purchases) return;
  const settler = settlerFor(deps);

  const limitsOff = deps.rateLimit?.enabled === false;
  const orderLimit = limitsOff ? false : ORDER_RATE_LIMIT;
  const pollLimit = limitsOff ? false : POLL_RATE_LIMIT;

  /** A public event, or 404 — a draft answers exactly like one that does not exist. */
  const publicEvent = async (eventId: number) => {
    const event = await events.find(eventId);
    if (!event || event.status === "draft") throw new NotFoundError(`No event ${eventId}.`, { eventId });
    return event;
  };

  /**
   * GET /api/events/:eventId/store
   *
   * Active vendors with at least one active item. `open` is true only while
   * the event is live: before, the price list is there to look at; after, the
   * counters are packed up.
   */
  app.get<{ Params: EventIdParams }>(
    "/api/events/:eventId/store",
    { schema: { params: eventIdParamsSchema }, config: { rateLimit: pollLimit } },
    async (request, reply) => {
      const { eventId } = request.params;
      const event = await publicEvent(eventId);
      const [rows, items, taken] = await Promise.all([
        vendors.listVendors(eventId),
        vendors.listItems(eventId),
        purchases.unitsTaken(eventId),
      ]);

      const stalls = rows
        .filter((vendor) => vendor.active)
        .map((vendor) => ({
          id: vendor.id,
          name: vendor.name,
          items: items
            .filter((item) => item.vendorId === vendor.id && item.active)
            .map((item) => {
              const remaining = item.stock === null ? null : Math.max(0, item.stock - (taken[item.id] ?? 0));
              return {
                id: item.id,
                name: item.name,
                priceXrp: item.priceXrp,
                remaining,
                soldOut: remaining === 0,
              };
            }),
        }))
        .filter((stall) => stall.items.length > 0);

      return reply.code(200).send({
        eventId,
        name: event.name,
        status: event.status,
        open: event.status === "live",
        allowanceXrp: event.allowanceXrp ?? "0",
        vendors: stalls,
      });
    },
  );

  /**
   * GET /api/events/:eventId/store/wallets/:address
   *
   * What the pass needs to draw the store for one wallet: what it can spend,
   * whether it may buy, its allowance, and its orders — with any still waiting
   * for payment settled against the ledger first.
   */
  app.get<{ Params: WalletParams }>(
    "/api/events/:eventId/store/wallets/:address",
    { schema: { params: walletParamsSchema }, config: { rateLimit: pollLimit } },
    async (request, reply) => {
      const { eventId, address } = request.params;
      await publicEvent(eventId);

      let account: AccountSnapshot | null = null;
      try {
        account = await deps.chain.readAccount(deps.gateway, address);
      } catch (err) {
        request.log.warn({ err, eventId }, "could not read a buyer's wallet");
      }

      const [standing, allowance, rows] = await Promise.all([
        buyerStanding(deps, eventId, address),
        account ? readAllowanceStatus(deps, eventId, address, account.balanceXrp) : Promise.resolve(null),
        purchases.list({ eventId, buyerAddress: address, limit: 50 }),
      ]);

      let budget = SETTLE_PER_READ;
      const settled = await Promise.all(
        rows.map((row) => {
          if (row.status !== "reserved" || budget <= 0) return row;
          budget -= 1;
          return settler.settle(row, request.log);
        }),
      );

      return reply.code(200).send({
        eventId,
        address,
        account: account
          ? { activated: account.activated, balanceXrp: account.balanceXrp, spendableXrp: account.spendableXrp }
          : null,
        eligible: standing.eligible,
        ...(standing.reason && !standing.eligible ? { reason: standing.reason } : {}),
        allowance,
        purchases: settled.map(toPurchaseView),
      });
    },
  );

  /**
   * POST /api/events/:eventId/purchases { address, itemId, quantity, returnUrl? }
   *
   * 201 { purchase, xaman } | 400 | 403 not an attendee | 404
   * 409 closed, sold out, too little to spend, too many unpaid orders
   * 429 | 503 no Xaman
   */
  app.post<{ Params: EventIdParams; Body: OrderBody }>(
    "/api/events/:eventId/purchases",
    {
      schema: { params: eventIdParamsSchema, body: orderBodySchema },
      config: { rateLimit: orderLimit },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const { address, itemId, quantity, returnUrl } = request.body;
      const placed = await placeOrder(
        deps,
        { eventId, address, itemId, quantity, ...(returnUrl ? { returnUrl } : {}) },
        request.log,
      );
      return reply.code(201).send({ purchase: toPurchaseView(placed.purchase), xaman: placed.xaman });
    },
  );

  /** GET /api/purchases/:purchaseId — the order, settled against the ledger first. */
  app.get<{ Params: PurchaseParams }>(
    "/api/purchases/:purchaseId",
    { schema: { params: purchaseParamsSchema }, config: { rateLimit: pollLimit } },
    async (request, reply) => {
      const found = await purchases.find(request.params.purchaseId);
      if (!found) return sendError(reply, 404, "NOT_FOUND", "No such order.");
      const settled = await settler.settle(found, request.log);
      return reply.code(200).send({ purchase: toPurchaseView(settled) });
    },
  );

  /**
   * POST /api/purchases/:purchaseId/confirm { txHash }
   *
   * For a buyer who paid some other way than the Xaman request. The hash is a
   * hint; the transaction is read back and checked exactly as any other.
   *
   * 200 paid | 404 | 422 does not pay for this order (notYet when it may)
   */
  app.post<{ Params: PurchaseParams; Body: ConfirmBody }>(
    "/api/purchases/:purchaseId/confirm",
    {
      schema: { params: purchaseParamsSchema, body: confirmBodySchema },
      config: { rateLimit: orderLimit },
    },
    async (request, reply) => {
      const found = await purchases.find(request.params.purchaseId);
      if (!found) return sendError(reply, 404, "NOT_FOUND", "No such order.");
      if (found.status === "paid") return reply.code(200).send({ purchase: toPurchaseView(found) });

      const { purchase, check } = await settler.confirm(found, request.body.txHash, request.log);
      if (!check.paid) {
        return sendError(
          reply,
          422,
          "VERIFICATION_FAILED",
          check.reason ?? "That transaction does not pay for this order.",
          { purchaseId: found.id, ...(check.notYet ? { notYet: true } : {}) },
        );
      }
      return reply.code(200).send({ purchase: toPurchaseView(purchase) });
    },
  );
}
