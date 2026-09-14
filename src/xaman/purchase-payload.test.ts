/**
 * What a buyer is asked to sign, and what a vendor signs in with.
 *
 * The Payment is built here, from data, so exactly what lands on somebody's
 * phone is pinned by a test: who pays, who is paid, how much, the order it
 * settles, and nothing else.
 */
import { describe, expect, it } from "vitest";
import { readMemos } from "../xrpl/memos.js";
import { PURCHASE_MEMO_TYPE } from "../xrpl/purchase.js";
import { XummXamanService, type XummSdkLike } from "./client.js";
import {
  PURCHASE_PAYLOAD_EXPIRE_MINUTES,
  buildPurchaseSignRequest,
  parseXamanPurchaseMeta,
  type PurchaseSignRequestParams,
} from "./payloads.js";
import { buildVendorSignInRequest } from "./signin.js";

const BUYER = "rPeZcWESwr1Wy64tw6JdVqtKNjhuUzHK2i";
const VENDOR = "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w";
const ORDER = "2f1c6a4e-8d3b-4a57-9c1e-5b7d9e0f1a2b";

function params(over: Partial<PurchaseSignRequestParams> = {}): PurchaseSignRequestParams {
  return {
    purchaseId: ORDER,
    eventId: 700012,
    buyerAddress: BUYER,
    vendorAddress: VENDOR,
    amountDrops: "4500000",
    vendorName: "Dominos",
    itemName: "Garlic bread",
    quantity: 3,
    ...over,
  };
}

describe("buildPurchaseSignRequest", () => {
  it("asks for exactly one Payment: buyer to vendor, the whole amount, naming the order", () => {
    const request = buildPurchaseSignRequest(params({ sourceTag: 2607210007 }));

    expect(Object.keys(request.txjson).sort()).toEqual(
      ["Account", "Amount", "Destination", "Memos", "SourceTag", "TransactionType"].sort(),
    );
    expect(request.txjson).toMatchObject({
      TransactionType: "Payment",
      Account: BUYER,
      Destination: VENDOR,
      Amount: "4500000",
      SourceTag: 2607210007,
    });
    expect(readMemos(request.txjson as unknown as Record<string, unknown>)).toEqual([
      { type: PURCHASE_MEMO_TYPE, data: ORDER },
    ]);
  });

  it("leaves the tag off entirely when none is configured, never sending 0", () => {
    expect("SourceTag" in buildPurchaseSignRequest(params()).txjson).toBe(false);
  });

  it("has Xaman submit it, expire quickly, and say in words what it is", () => {
    const request = buildPurchaseSignRequest(params({ returnUrl: { web: "https://poap.example/attend/700012" } }));

    expect(request.options).toEqual({
      submit: true,
      expire: PURCHASE_PAYLOAD_EXPIRE_MINUTES,
      return_url: { web: "https://poap.example/attend/700012" },
    });
    expect(request.custom_meta.identifier).toBe("poap-buy-2f1c6a4e");
    expect(request.custom_meta.blob).toEqual({ kind: "poap-purchase", eventId: 700012, purchaseId: ORDER });
    expect(request.custom_meta.instruction).toBe("Pay Dominos 4.5 XRP for 3 × Garlic bread.");
  });

  it("keeps the instruction short however long the names are", () => {
    const request = buildPurchaseSignRequest(params({ vendorName: "V".repeat(500), itemName: "I".repeat(500) }));
    expect(request.custom_meta.instruction.length).toBeLessThanOrEqual(200);
  });

  it("refuses anything it could not honestly ask somebody to sign", () => {
    const bad: Array<Partial<PurchaseSignRequestParams>> = [
      { buyerAddress: "rNope" },
      { vendorAddress: "rNope" },
      { vendorAddress: BUYER },
      { purchaseId: "not-an-order" },
      { amountDrops: "0" },
      { amountDrops: "4.5" },
      { amountDrops: "-1" },
      { quantity: 0 },
      { eventId: -1 },
    ];
    for (const over of bad) {
      expect(() => buildPurchaseSignRequest(params(over)), JSON.stringify(over)).toThrow();
    }
  });
});

describe("parseXamanPurchaseMeta", () => {
  it("reads the order out of a delivery's blob, as an object or as a string", () => {
    const blob = { kind: "poap-purchase", eventId: 700012, purchaseId: ORDER.toUpperCase() };
    expect(parseXamanPurchaseMeta({ custom_meta: { blob } })).toEqual({ purchaseId: ORDER, eventId: 700012 });
    expect(parseXamanPurchaseMeta({ custom_meta: { blob: JSON.stringify(blob) } })).toEqual({
      purchaseId: ORDER,
      eventId: 700012,
    });
  });

  it("says nothing about a claim, a malformed blob, or no blob", () => {
    expect(parseXamanPurchaseMeta({ custom_meta: { blob: { kind: "poap-claim", eventId: 1, offerId: "A".repeat(64) } } })).toEqual({});
    expect(parseXamanPurchaseMeta({ custom_meta: { blob: { kind: "poap-purchase", purchaseId: "nope" } } })).toEqual({});
    expect(parseXamanPurchaseMeta({ custom_meta: { blob: "{not json" } })).toEqual({});
    expect(parseXamanPurchaseMeta({})).toEqual({});
    expect(parseXamanPurchaseMeta("a string")).toEqual({});
  });
});

describe("buildVendorSignInRequest", () => {
  it("is a SignIn and nothing else, and says what it opens", () => {
    const request = buildVendorSignInRequest({ purpose: "vendor", returnUrl: { web: "https://poap.example/vendor" } });
    expect(request.txjson).toEqual({ TransactionType: "SignIn" });
    expect(request.custom_meta.blob).toEqual({ kind: "poap-vendor" });
    expect(request.custom_meta.instruction).toMatch(/not a transaction/);
    expect(request.options.return_url).toEqual({ web: "https://poap.example/vendor" });
  });
});

describe("XummXamanService.createPurchaseRequest", () => {
  function fakeSdk(fetched: unknown = null) {
    const posted: unknown[] = [];
    const sdk: XummSdkLike = {
      payload: {
        async create(payload) {
          posted.push(payload);
          return {
            uuid: "b1946ac9-2f39-4a2b-8a3c-8e2f0a8d6f11",
            next: { always: "https://xumm.app/sign/b1946ac9" },
            refs: { qr_png: "https://xumm.app/sign/b1946ac9_q.png", websocket_status: "wss://xumm.app/sign/b1946ac9" },
          };
        },
        async get() {
          return fetched as never;
        },
      },
    };
    return { sdk, posted };
  }

  it("pins the network, stamps the server's source tag, and hands back the handles", async () => {
    const { sdk, posted } = fakeSdk();
    const service = new XummXamanService({ apiKey: "k", apiSecret: "s", network: "testnet", sourceTag: 42, sdk });

    const before = Date.now();
    const handles = await service.createPurchaseRequest(params());

    const sent = posted[0] as { txjson: { SourceTag?: number }; options: { force_network?: string } };
    expect(sent.options.force_network).toBe("TESTNET");
    expect(sent.txjson.SourceTag).toBe(42);
    expect(handles.uuid).toBe("b1946ac9-2f39-4a2b-8a3c-8e2f0a8d6f11");
    const expires = Date.parse(handles.expiresAt);
    expect(expires - before).toBeGreaterThanOrEqual(PURCHASE_PAYLOAD_EXPIRE_MINUTES * 60_000 - 1_000);
    expect(expires - before).toBeLessThanOrEqual(PURCHASE_PAYLOAD_EXPIRE_MINUTES * 60_000 + 1_000);
  });

  it("reports a declined or expired payload as rejected, and a signed one as not", async () => {
    const declined = fakeSdk({ meta: { resolved: true, signed: false }, response: {} });
    await expect(
      new XummXamanService({ apiKey: "k", apiSecret: "s", sdk: declined.sdk }).getPayload("u"),
    ).resolves.toMatchObject({ signed: false, rejected: true });

    const expired = fakeSdk({ meta: { resolved: false, signed: false, expired: true }, response: {} });
    await expect(
      new XummXamanService({ apiKey: "k", apiSecret: "s", sdk: expired.sdk }).getPayload("u"),
    ).resolves.toMatchObject({ rejected: true });

    const signed = fakeSdk({ meta: { resolved: true, signed: true }, response: { txid: "AB".repeat(32), account: BUYER } });
    await expect(
      new XummXamanService({ apiKey: "k", apiSecret: "s", sdk: signed.sdk }).getPayload("u"),
    ).resolves.toMatchObject({ signed: true, rejected: false, txHash: "AB".repeat(32) });
  });
});
