/**
 * Whether a Payment pays for an order. Each test below is a way a transaction
 * could look like payment and not be — and a vendor hands food over on the
 * answer.
 */
import { describe, expect, it } from "vitest";
import { MockGateway, rippledError } from "../../test/helpers/mock-gateway.js";
import { memo } from "./memos.js";
import {
  PURCHASE_MEMO_TYPE,
  findPurchasePayment,
  verifyPurchasePayment,
  type PurchasePaymentInput,
} from "./purchase.js";

const ISSUER = "rBdhYBA2uaVYG7ia2yusmPu5qMS4hE6oQ";
const BUYER = "rPeZcWESwr1Wy64tw6JdVqtKNjhuUzHK2i";
const VENDOR = "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w";
const STRANGER = "rwPy1pJd3RcHrEaqKk1yUiEGCqz8wewJZm";
const ORDER = "2f1c6a4e-8d3b-4a57-9c1e-5b7d9e0f1a2b";
const TX = "9A".repeat(32);
const TAG = 2607210007;

function payment(
  over: { body?: Record<string, unknown>; meta?: Record<string, unknown>; validated?: boolean } = {},
): Record<string, unknown> {
  return {
    result: {
      hash: TX,
      ledger_index: 99_000_001,
      validated: over.validated ?? true,
      tx_json: {
        TransactionType: "Payment",
        Account: BUYER,
        Destination: VENDOR,
        Amount: "4500000",
        SourceTag: TAG,
        Memos: [memo(PURCHASE_MEMO_TYPE, ORDER)],
        ...over.body,
      },
      meta: { TransactionResult: "tesSUCCESS", delivered_amount: "4500000", ...over.meta },
    },
  };
}

function input(over: Partial<PurchasePaymentInput> = {}): PurchasePaymentInput {
  return {
    txHash: TX,
    purchaseId: ORDER,
    buyerAddress: BUYER,
    vendorAddress: VENDOR,
    amountXrp: "4.5",
    sourceTag: TAG,
    ...over,
  };
}

function ledger(response: unknown): MockGateway {
  return new MockGateway({ issuerAddress: ISSUER }).onRequest("tx", response);
}

describe("verifyPurchasePayment", () => {
  it("accepts a validated Payment from the buyer to the vendor, for exactly the order, naming it", async () => {
    const gw = ledger(payment());
    await expect(verifyPurchasePayment(gw, input())).resolves.toEqual({ paid: true, ledgerIndex: 99_000_001 });
    expect(gw.lastRequest("tx")?.transaction).toBe(TX);
  });

  it("reads the hash case-insensitively", async () => {
    const gw = ledger(payment());
    await expect(verifyPurchasePayment(gw, input({ txHash: TX.toLowerCase() }))).resolves.toMatchObject({ paid: true });
  });

  const refusals: Array<[string, Parameters<typeof payment>[0], Partial<PurchasePaymentInput>?]> = [
    ["not a Payment", { body: { TransactionType: "OfferCreate" } }],
    ["sent by somebody else", { body: { Account: STRANGER } }],
    ["paid to somebody else", { body: { Destination: STRANGER } }],
    ["made outside this app", { body: { SourceTag: 1 } }],
    ["made with no source tag at all", { body: { SourceTag: undefined } }],
    ["for a different order", { body: { Memos: [memo(PURCHASE_MEMO_TYPE, "3f1c6a4e-8d3b-4a57-9c1e-5b7d9e0f1a2b")] } }],
    ["with no memo", { body: { Memos: undefined } }],
    ["that failed on the ledger", { meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } }],
    ["a partial payment that delivered less", { meta: { delivered_amount: "1" } }],
    ["one that delivered more than the order", { meta: { delivered_amount: "4500001" } }],
    ["one that delivered a token, not XRP", { meta: { delivered_amount: { currency: "USD", value: "4.5", issuer: STRANGER } } }],
  ];

  for (const [label, shape] of refusals) {
    it(`refuses a transaction ${label}`, async () => {
      const result = await verifyPurchasePayment(ledger(payment(shape)), input());
      expect(result.paid).toBe(false);
      expect(result.notYet).toBeUndefined();
      expect(result.reason).toBeTruthy();
    });
  }

  it("does not ask for a source tag when this server has none", async () => {
    const gw = ledger(payment({ body: { SourceTag: undefined } }));
    const { sourceTag: _unused, ...untagged } = input();
    await expect(verifyPurchasePayment(gw, untagged)).resolves.toMatchObject({ paid: true });
  });

  it("says NOT YET for a payment that succeeded and is not validated, and for one not on this node", async () => {
    const pending = await verifyPurchasePayment(ledger(payment({ validated: false })), input());
    expect(pending).toMatchObject({ paid: false, notYet: true });

    const thrown = await verifyPurchasePayment(ledger(rippledError("txnNotFound")), input());
    expect(thrown).toMatchObject({ paid: false, notYet: true });

    const answered = await verifyPurchasePayment(ledger({ result: { error: "txnNotFound" } }), input());
    expect(answered).toMatchObject({ paid: false, notYet: true });
  });

  it("refuses a hash that is not one without asking the ledger", async () => {
    const gw = new MockGateway({ issuerAddress: ISSUER });
    await expect(verifyPurchasePayment(gw, input({ txHash: "abc" }))).resolves.toMatchObject({ paid: false });
    expect(gw.requests).toHaveLength(0);
  });

  it("throws when the ledger could not be asked at all", async () => {
    await expect(verifyPurchasePayment(ledger(rippledError("tooBusy")), input())).rejects.toMatchObject({
      code: "LEDGER_QUERY_FAILED",
    });
  });
});

describe("findPurchasePayment", () => {
  function history(entries: Record<string, unknown>[]) {
    return new MockGateway({ issuerAddress: ISSUER }).onRequest("account_tx", { result: { transactions: entries } });
  }

  function entry(body: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
    return {
      hash: TX.toLowerCase(),
      meta: { TransactionResult: "tesSUCCESS", ...meta },
      tx_json: {
        TransactionType: "Payment",
        Account: BUYER,
        Destination: VENDOR,
        Memos: [memo(PURCHASE_MEMO_TYPE, ORDER)],
        ...body,
      },
    };
  }

  const wanted = { vendorAddress: VENDOR, buyerAddress: BUYER, purchaseId: ORDER };

  it("finds the order's payment in the vendor's history by its memo", async () => {
    const gw = history([
      entry({ Account: STRANGER }),
      entry({}, { TransactionResult: "tecPATH_DRY" }),
      entry({ Memos: [] }),
      entry(),
    ]);
    await expect(findPurchasePayment(gw, wanted)).resolves.toBe(TX);
    expect(gw.lastRequest("account_tx")?.account).toBe(VENDOR);
  });

  it("finds nothing when it is not there, or the vendor's wallet does not exist", async () => {
    await expect(findPurchasePayment(history([entry({ Memos: [] })]), wanted)).resolves.toBeUndefined();
    const gone = new MockGateway({ issuerAddress: ISSUER }).onRequest("account_tx", rippledError("actNotFound"));
    await expect(findPurchasePayment(gone, wanted)).resolves.toBeUndefined();
  });
});
