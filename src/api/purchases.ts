/**
 * Buying at an event, and finding out whether it was paid.
 *
 * TWO HALVES, and they never trust each other:
 *
 *   placeOrder()  checks the buyer can buy, holds the stock, and asks Xaman
 *                 for a Payment the buyer approves on their phone.
 *   settle()      decides what happened, from the ledger. Xaman saying
 *                 "signed" is only where to look; the transaction itself has
 *                 to be a validated Payment from the buyer to the vendor, for
 *                 exactly the amount, naming the order.
 *
 * settle() runs whenever anybody looks: the buyer's pass polling its order, the
 * vendor's screen listing its orders, a Xaman webhook. Nothing depends on the
 * buyer coming back to the page after approving — the vendor's screen finds the
 * payment on its own, which is what lets a vendor hand the item over while the
 * buyer is still putting their phone away.
 */
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { NotFoundError, ValidationError, XrplLayerError } from "../errors.js";
import { dropsToXrpString, xrpToDropsBigInt } from "../money.js";
import type { EventId, PurchaseRecord } from "../types.js";
import type { XamanClaimRequest } from "../xaman/client.js";
import { PURCHASE_PAYLOAD_EXPIRE_MINUTES } from "../xaman/payloads.js";
import type { PurchasePaymentCheck } from "../xrpl/purchase.js";
import { BASE_RESERVE_XRP } from "../xrpl/reserve.js";
import type { ApiDeps } from "./deps.js";

/** Units in one order. A queue of twenty is a lot of pizza; a hundred is a typo. */
export const MAX_ORDER_QUANTITY = 20;

/** Unpaid orders one buyer may hold at once. Enough to change their mind; not enough to empty a counter. */
export const MAX_OPEN_ORDERS_PER_BUYER = 3;

/** How long an order holds stock: the payload's life, and a minute for the Payment to validate. */
export const ORDER_HOLD_MS = (PURCHASE_PAYLOAD_EXPIRE_MINUTES + 1) * 60_000;

/** The ledger and Xaman are not asked about one order more often than this. */
const SETTLE_EVERY_MS = 2_000;

export interface PurchaseView {
  id: string;
  eventId: EventId;
  vendorId: string;
  vendorName: string;
  itemId: string;
  itemName: string;
  quantity: number;
  unitPriceXrp: string;
  amountXrp: string;
  status: PurchaseRecord["status"];
  buyerAddress: string;
  txHash: string | null;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  handedOverAt: string | null;
}

/** Everything but the Xaman payload id, which is a handle and nobody else's business. */
export function toPurchaseView(p: PurchaseRecord): PurchaseView {
  return {
    id: p.id,
    eventId: p.eventId,
    vendorId: p.vendorId,
    vendorName: p.vendorName,
    itemId: p.itemId,
    itemName: p.itemName,
    quantity: p.quantity,
    unitPriceXrp: p.unitPriceXrp,
    amountXrp: p.amountXrp,
    status: p.status,
    buyerAddress: p.buyerAddress,
    txHash: p.txHash,
    createdAt: p.createdAt.toISOString(),
    expiresAt: p.expiresAt.toISOString(),
    paidAt: p.paidAt ? p.paidAt.toISOString() : null,
    handedOverAt: p.handedOverAt ? p.handedOverAt.toISOString() : null,
  };
}

/**
 * May this wallet buy at this event?
 *
 * The store is for the event's attendees: a wallet that holds the event's
 * badge, or that the event has already paid an allowance to. Anyone else could
 * still pay a vendor from their own wallet — the ledger does not care — but
 * they cannot hold this counter's stock hostage with orders they never pay for.
 */
export async function buyerStanding(
  deps: ApiDeps,
  eventId: EventId,
  address: string,
): Promise<{ eligible: boolean; reason?: string }> {
  const [badge, allowance] = await Promise.all([
    deps.attendance.findByEventAndAddress(eventId, address),
    deps.allowances ? deps.allowances.find(eventId, address) : Promise.resolve(null),
  ]);
  if (badge || allowance?.status === "confirmed") return { eligible: true };
  return {
    eligible: false,
    reason: "The store is for this event's attendees. Collect your badge at the desk first.",
  };
}

export interface PlaceOrderInput {
  eventId: EventId;
  address: string;
  itemId: string;
  quantity: number;
  /** Where Xaman sends the buyer back to after approving. */
  returnUrl?: string;
}

export interface PlacedOrder {
  purchase: PurchaseRecord;
  xaman: XamanClaimRequest;
}

export async function placeOrder(
  deps: ApiDeps,
  input: PlaceOrderInput,
  log?: FastifyBaseLogger,
): Promise<PlacedOrder> {
  const { events, vendors, purchases } = deps;
  if (!events || !vendors || !purchases) {
    throw new XrplLayerError("SERVICE_UNAVAILABLE", "The store is not set up on this server.");
  }
  const xaman = deps.xaman;
  if (!xaman || !deps.config.xumm.apiKey || !deps.config.xumm.apiSecret) {
    throw new XrplLayerError(
      "SERVICE_UNAVAILABLE",
      "Paying at the store needs Xaman, and it is not configured on this server.",
    );
  }

  const event = await events.find(input.eventId);
  if (!event || event.status === "draft") {
    throw new NotFoundError(`No event ${input.eventId}.`, { eventId: input.eventId });
  }
  if (event.status !== "live") {
    throw new XrplLayerError(
      "CONFLICT",
      event.status === "closed" ? "This event is over, and so is its store." : "The store opens when the event does.",
      { eventId: input.eventId, status: event.status },
    );
  }

  const item = await vendors.findItem(input.itemId);
  if (!item || item.eventId !== input.eventId) {
    throw new NotFoundError("That item is not sold at this event.", { eventId: input.eventId, itemId: input.itemId });
  }
  const vendor = await vendors.findVendor(item.vendorId);
  if (!vendor || !vendor.active || !item.active) {
    throw new XrplLayerError("CONFLICT", `${item.name} is not on sale any more.`, { itemId: item.id });
  }

  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_ORDER_QUANTITY) {
    throw new ValidationError("INVALID_INPUT", `Order between 1 and ${MAX_ORDER_QUANTITY} at a time.`, {
      quantity: input.quantity,
    });
  }
  if (input.address === vendor.walletAddress) {
    throw new ValidationError("INVALID_INPUT", "A vendor cannot buy from their own counter.", {
      address: input.address,
    });
  }

  const standing = await buyerStanding(deps, input.eventId, input.address);
  if (!standing.eligible) {
    throw new XrplLayerError("FORBIDDEN", standing.reason ?? "This wallet cannot buy at this event.", {
      eventId: input.eventId,
      address: input.address,
    });
  }

  // Refused here rather than by the ledger, because the ledger's refusal comes
  // after the buyer has been sent to Xaman and back for nothing.
  const amount = xrpToDropsBigInt(item.priceXrp) * BigInt(input.quantity);
  const account = await deps.chain.readAccount(deps.gateway, input.address);
  if (xrpToDropsBigInt(account.spendableXrp) < amount) {
    throw new XrplLayerError(
      "CONFLICT",
      `This costs ${dropsToXrpString(amount)} XRP and your wallet has ${account.spendableXrp} XRP to spend.`,
      { reason: "insufficient", amountXrp: dropsToXrpString(amount), spendableXrp: account.spendableXrp },
    );
  }

  // A vendor's wallet need not exist yet: the first payment of at least the
  // base reserve creates it. The ledger refuses anything smaller to a wallet
  // that does not exist (tecNO_DST_INSUF_XRP), and only after the buyer has
  // signed, so a smaller order is refused here instead.
  if (amount < xrpToDropsBigInt(BASE_RESERVE_XRP)) {
    const counter = await deps.chain.readAccount(deps.gateway, vendor.walletAddress);
    if (!counter.activated) {
      throw new XrplLayerError(
        "CONFLICT",
        `${vendor.name} cannot take less than ${BASE_RESERVE_XRP} XRP yet: their wallet is new, and the ` +
          `ledger will not deliver a smaller first payment to it. Order ${BASE_RESERVE_XRP} XRP or more.`,
        { reason: "vendor_not_activated", minimumXrp: BASE_RESERVE_XRP, amountXrp: dropsToXrpString(amount) },
      );
    }
  }

  const id = randomUUID();
  const outcome = await purchases.reserve({
    id,
    eventId: input.eventId,
    vendorId: vendor.id,
    itemId: item.id,
    buyerAddress: input.address,
    vendorAddress: vendor.walletAddress,
    vendorName: vendor.name,
    itemName: item.name,
    quantity: input.quantity,
    unitPriceXrp: item.priceXrp,
    expiresAt: new Date(Date.now() + ORDER_HOLD_MS),
    maxOpenPerBuyer: MAX_OPEN_ORDERS_PER_BUYER,
  });

  if (!outcome.ok) {
    if (outcome.reason === "sold_out") {
      throw new XrplLayerError(
        "CONFLICT",
        outcome.remaining === 0 ? `${item.name} is sold out.` : `Only ${outcome.remaining} ${item.name} left.`,
        { reason: "sold_out", remaining: outcome.remaining, itemId: item.id },
      );
    }
    throw new XrplLayerError(
      "CONFLICT",
      `You have ${outcome.open} orders waiting to be paid. Pay for one, or let it lapse, before starting another.`,
      { reason: "too_many_open", open: outcome.open },
    );
  }

  try {
    const request = await xaman.createPurchaseRequest({
      purchaseId: id,
      eventId: input.eventId,
      buyerAddress: input.address,
      vendorAddress: vendor.walletAddress,
      amountDrops: amount.toString(),
      vendorName: vendor.name,
      itemName: item.name,
      quantity: input.quantity,
      ...(deps.config.sourceTag === undefined ? {} : { sourceTag: deps.config.sourceTag }),
      ...(input.returnUrl ? { returnUrl: { web: input.returnUrl } } : {}),
    });
    await purchases.attachPayload(id, request.uuid);

    log?.info(
      { eventId: input.eventId, purchaseId: id, vendorId: vendor.id, itemId: item.id, quantity: input.quantity },
      "order placed",
    );
    return { purchase: { ...outcome.purchase, xamanUuid: request.uuid }, xaman: request };
  } catch (err) {
    // Nothing can pay for this order now, so the stock goes straight back.
    try {
      await purchases.markExpired(id);
    } catch {
      // It lapses on its own at its expiry either way.
    }
    throw err;
  }
}

/**
 * Settles orders against the ledger. One per server, so the throttle is
 * shared by every screen polling the same order.
 */
export class PurchaseSettler {
  readonly #lastTried = new Map<string, number>();

  constructor(private readonly deps: ApiDeps) {}

  /**
   * What the ledger says about one order, recorded. Returns the order as it
   * stands afterwards. Never throws for a ledger or Xaman that could not be
   * asked — the order is simply returned unchanged, to be asked about again.
   *
   * `force` skips the throttle; the webhook uses it, because a delivery is the
   * moment a payment is most likely to be there.
   */
  async settle(
    purchase: PurchaseRecord,
    log?: FastifyBaseLogger,
    opts: { force?: boolean } = {},
  ): Promise<PurchaseRecord> {
    const purchases = this.deps.purchases;
    if (!purchases || purchase.status === "paid") return purchase;
    if (purchase.status === "expired" && !opts.force) return purchase;

    const now = Date.now();
    if (!opts.force) {
      const last = this.#lastTried.get(purchase.id);
      if (last !== undefined && now - last < SETTLE_EVERY_MS) return purchase;
    }
    this.#lastTried.set(purchase.id, now);
    this.#prune(now);

    let candidate: string | undefined;
    let declined = false;

    if (purchase.xamanUuid && this.deps.xaman) {
      try {
        const status = await this.deps.xaman.getPayload(purchase.xamanUuid);
        if (status.signed && status.txHash) candidate = status.txHash;
        else if (status.rejected) declined = true;
      } catch (err) {
        log?.warn({ err, purchaseId: purchase.id }, "could not ask Xaman about an order's payment");
      }
    }

    const lapsed = now > purchase.expiresAt.getTime();
    if (!candidate && (lapsed || declined || opts.force)) {
      // Paid another way, or Xaman has forgotten the payload: the vendor's own
      // history is the last place to look before giving the stock back.
      try {
        candidate = await this.deps.chain.findPurchasePayment(this.deps.gateway, {
          vendorAddress: purchase.vendorAddress,
          buyerAddress: purchase.buyerAddress,
          purchaseId: purchase.id,
        });
      } catch (err) {
        log?.warn({ err, purchaseId: purchase.id }, "could not search the vendor's history for an order's payment");
        return purchase;
      }
    }

    if (candidate) {
      const settled = await this.#record(purchase, candidate, log);
      if (settled) return settled;
    }

    if (purchase.status === "reserved" && (lapsed || declined)) {
      return (await purchases.markExpired(purchase.id)) ?? (await purchases.find(purchase.id)) ?? purchase;
    }
    return purchase;
  }

  /**
   * A hash somebody offered — a buyer who paid from another wallet app. Checked
   * exactly as a Xaman one is.
   */
  async confirm(
    purchase: PurchaseRecord,
    txHash: string,
    log?: FastifyBaseLogger,
  ): Promise<{ purchase: PurchaseRecord; check: PurchasePaymentCheck }> {
    const check = await this.#check(purchase, txHash);
    if (!check.paid) return { purchase, check };
    const purchases = this.deps.purchases;
    if (!purchases) return { purchase, check };
    const paid = await purchases.markPaid(purchase.id, txHash.trim().toUpperCase());
    log?.info({ purchaseId: purchase.id, txHash }, "order paid, confirmed by hash");
    return { purchase: paid, check };
  }

  async #record(
    purchase: PurchaseRecord,
    txHash: string,
    log?: FastifyBaseLogger,
  ): Promise<PurchaseRecord | undefined> {
    const purchases = this.deps.purchases;
    if (!purchases) return undefined;

    let check: PurchasePaymentCheck;
    try {
      check = await this.#check(purchase, txHash);
    } catch (err) {
      log?.warn({ err, purchaseId: purchase.id, txHash }, "could not read an order's payment from the ledger");
      return purchase;
    }

    if (check.paid) {
      try {
        const paid = await purchases.markPaid(purchase.id, txHash.trim().toUpperCase());
        log?.info({ purchaseId: purchase.id, txHash, vendorId: purchase.vendorId }, "order paid");
        return paid;
      } catch (err) {
        log?.error({ err, purchaseId: purchase.id, txHash }, "an order's payment verified but could not be recorded");
        return (await purchases.find(purchase.id)) ?? purchase;
      }
    }
    // The payment may be real and not visible yet: leave the order as it is.
    if (check.notYet) return purchase;

    log?.warn(
      { purchaseId: purchase.id, txHash, reason: check.reason },
      "a payment offered for an order does not pay for it",
    );
    return undefined;
  }

  #check(purchase: PurchaseRecord, txHash: string): Promise<PurchasePaymentCheck> {
    return this.deps.chain.verifyPurchasePayment(this.deps.gateway, {
      txHash,
      purchaseId: purchase.id,
      buyerAddress: purchase.buyerAddress,
      vendorAddress: purchase.vendorAddress,
      amountXrp: purchase.amountXrp,
      ...(this.deps.config.sourceTag === undefined ? {} : { sourceTag: this.deps.config.sourceTag }),
    });
  }

  #prune(now: number): void {
    if (this.#lastTried.size < 5_000) return;
    for (const [id, at] of this.#lastTried) {
      if (now - at > 60_000) this.#lastTried.delete(id);
    }
  }
}

const settlers = new WeakMap<ApiDeps, PurchaseSettler>();

/** The one settler for this server's deps. */
export function settlerFor(deps: ApiDeps): PurchaseSettler {
  let settler = settlers.get(deps);
  if (!settler) {
    settler = new PurchaseSettler(deps);
    settlers.set(deps, settler);
  }
  return settler;
}
