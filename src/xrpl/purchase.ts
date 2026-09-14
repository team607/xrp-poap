/**
 * Did the buyer pay for this order? Only the ledger can say.
 *
 * A vendor hands over a pizza on the strength of what this module answers, so
 * it answers from the transaction itself and nothing else: not from Xaman
 * saying "signed", not from a hash a phone posted, not from a webhook body.
 * Each of those is a hint about WHICH transaction to read. The six things
 * checked below are what make it payment for this order:
 *
 *   1. it is a Payment
 *   2. from the buyer
 *   3. to the vendor's wallet
 *   4. carrying this app's source tag, when one is configured
 *   5. carrying this order's id in its memo
 *   6. validated, tesSUCCESS, and DELIVERED exactly the order's amount
 *
 * The last reads `delivered_amount`, never `Amount`: a partial payment names a
 * large Amount and delivers a small one, and the difference is somebody's
 * lunch.
 *
 * A mismatch is a return value, not an exception. Throws are for a ledger that
 * could not be asked.
 */
import { XrplLayerError } from "../errors.js";
import { xrpToDropsBigInt } from "../money.js";
import type { XrplGateway } from "../types.js";
import { isRippledError } from "./client.js";
import { hasMemo, PURCHASE_MEMO_TYPE } from "./memos.js";
import { unwrapResult } from "./roster.js";

export { PURCHASE_MEMO_TYPE } from "./memos.js";

const HASH_RE = /^[0-9A-F]{64}$/;
const HISTORY_LIMIT = 200;

export interface PurchasePaymentInput {
  txHash: string;
  purchaseId: string;
  buyerAddress: string;
  vendorAddress: string;
  amountXrp: string;
  /** When set, the Payment must carry it. Every payment made through this app does. */
  sourceTag?: number;
}

export interface PurchasePaymentCheck {
  paid: boolean;
  /**
   * The payment may be real and this node has not caught up with it. Never set
   * on a transaction that contradicts the order, so it is safe to ask again on
   * this and only on this.
   */
  notYet?: boolean;
  reason?: string;
  ledgerIndex?: number;
}

export async function verifyPurchasePayment(
  gateway: XrplGateway,
  input: PurchasePaymentInput,
): Promise<PurchasePaymentCheck> {
  const hash = String(input.txHash ?? "").trim().toUpperCase();
  if (!HASH_RE.test(hash)) {
    return { paid: false, reason: `"${input.txHash}" is not a 64-character transaction hash.` };
  }

  let result: Record<string, any>;
  try {
    result = unwrapResult(await gateway.request({ command: "tx", transaction: hash }));
  } catch (err) {
    if (isRippledError(err, "txnNotFound")) {
      return { paid: false, notYet: true, reason: `Transaction ${hash} is not on this ledger yet.` };
    }
    throw new XrplLayerError(
      "LEDGER_QUERY_FAILED",
      `tx lookup for ${hash} failed: ${err instanceof Error ? err.message : String(err)}`,
      { method: "tx", txHash: hash },
    );
  }
  if (result.error === "txnNotFound") {
    return { paid: false, notYet: true, reason: `Transaction ${hash} is not on this ledger yet.` };
  }
  if (typeof result.error === "string") {
    throw new XrplLayerError("LEDGER_QUERY_FAILED", `tx lookup for ${hash} failed: ${result.error}`, {
      method: "tx",
      txHash: hash,
    });
  }

  const body: Record<string, any> =
    result.tx_json && typeof result.tx_json === "object" ? result.tx_json : result;
  const meta: Record<string, any> | undefined =
    (result.meta ?? body.meta ?? result.metaData) && typeof (result.meta ?? body.meta ?? result.metaData) === "object"
      ? (result.meta ?? body.meta ?? result.metaData)
      : undefined;
  const ledgerIndex =
    typeof (result.ledger_index ?? body.ledger_index) === "number"
      ? (result.ledger_index ?? body.ledger_index)
      : undefined;
  const found = ledgerIndex === undefined ? {} : { ledgerIndex };

  if (body.TransactionType !== "Payment") {
    return { paid: false, reason: `Transaction ${hash} is a ${String(body.TransactionType)}, not a Payment.`, ...found };
  }
  if (body.Account !== input.buyerAddress) {
    return { paid: false, reason: `Transaction ${hash} was sent by ${String(body.Account)}, not by the buyer.`, ...found };
  }
  if (body.Destination !== input.vendorAddress) {
    return { paid: false, reason: `Transaction ${hash} paid ${String(body.Destination)}, not this vendor.`, ...found };
  }
  if (input.sourceTag !== undefined && body.SourceTag !== input.sourceTag) {
    return { paid: false, reason: `Transaction ${hash} was not made through this app.`, ...found };
  }
  if (!hasMemo(body, PURCHASE_MEMO_TYPE, input.purchaseId)) {
    return { paid: false, reason: `Transaction ${hash} does not name this order.`, ...found };
  }

  const engineResult = meta?.TransactionResult;
  const validated = (result.validated ?? body.validated) === true;
  if (engineResult === "tesSUCCESS" && !validated) {
    return { paid: false, notYet: true, reason: `Transaction ${hash} is not validated yet.`, ...found };
  }
  if (engineResult !== "tesSUCCESS" || !validated) {
    return {
      paid: false,
      reason: `Transaction ${hash} did not succeed on a validated ledger (${String(engineResult)}).`,
      ...found,
    };
  }

  const delivered = meta?.delivered_amount ?? meta?.DeliveredAmount;
  const expected = xrpToDropsBigInt(input.amountXrp);
  if (typeof delivered !== "string" || !/^\d+$/.test(delivered) || BigInt(delivered) !== expected) {
    return {
      paid: false,
      reason: `Transaction ${hash} delivered ${typeof delivered === "string" ? delivered : "something other than XRP"} drops; the order is ${expected.toString()}.`,
      ...found,
    };
  }

  return { paid: true, ...found };
}

/**
 * The Payment for an order nobody told us about, looked for in the vendor's own
 * history by its memo. A hint only: whatever it returns goes through
 * verifyPurchasePayment before anything is recorded.
 */
export async function findPurchasePayment(
  gateway: XrplGateway,
  input: { vendorAddress: string; buyerAddress: string; purchaseId: string },
): Promise<string | undefined> {
  let result: Record<string, any>;
  try {
    result = unwrapResult(
      await gateway.request({
        command: "account_tx",
        account: input.vendorAddress,
        ledger_index_min: -1,
        ledger_index_max: -1,
        limit: HISTORY_LIMIT,
        forward: false,
      }),
    );
  } catch (err) {
    if (isRippledError(err, "actNotFound")) return undefined;
    throw new XrplLayerError(
      "LEDGER_QUERY_FAILED",
      `account_tx for vendor ${input.vendorAddress} failed: ${err instanceof Error ? err.message : String(err)}`,
      { method: "account_tx", address: input.vendorAddress },
    );
  }

  const entries: Record<string, any>[] = Array.isArray(result.transactions) ? result.transactions : [];
  for (const entry of entries) {
    const body: Record<string, any> = entry.tx_json ?? entry.tx ?? {};
    if (body.TransactionType !== "Payment") continue;
    if (body.Account !== input.buyerAddress || body.Destination !== input.vendorAddress) continue;
    const meta = entry.meta ?? entry.metaData;
    if (!meta || typeof meta !== "object" || meta.TransactionResult !== "tesSUCCESS") continue;
    if (!hasMemo(body, PURCHASE_MEMO_TYPE, input.purchaseId)) continue;
    const hash = typeof entry.hash === "string" ? entry.hash : body.hash;
    if (typeof hash === "string" && HASH_RE.test(hash.toUpperCase())) return hash.toUpperCase();
  }
  return undefined;
}
