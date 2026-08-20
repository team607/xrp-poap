import { describe, expect, it } from "vitest";
import { XrplLayerError } from "../errors.js";
import {
  CLAIM_PAYLOAD_EXPIRE_MINUTES,
  buildAcceptOfferTxjson,
  buildClaimSignRequest,
  parseXamanClaimMeta,
  parseXamanWebhook,
} from "./payloads.js";

const OFFER_ID = "8685A6D01DEDD0C4365B0928256424853B9842F30A379442FF969F9DD0D3AABC";
const TX_HASH = "B4068EC978F85028EFF92C1D9D48C249A5243E31EE517344378D33413E25EEBD";
const ATTENDEE = "rwPy1pJd3RcHrEaqKk1yUiEGCqz8wewJZm";
const EVENT_ID = 4242;

describe("buildAcceptOfferTxjson", () => {
  it("emits exactly the three fields of AcceptOfferPayload", () => {
    const txjson = buildAcceptOfferTxjson({ offerId: OFFER_ID, attendeeAddress: ATTENDEE });

    expect(txjson).toEqual({
      TransactionType: "NFTokenAcceptOffer",
      Account: ATTENDEE,
      NFTokenSellOffer: OFFER_ID,
    });
    expect(Object.keys(txjson)).toHaveLength(3);
  });

  it("rejects an address that is not a classic address", () => {
    expect(() => buildAcceptOfferTxjson({ offerId: OFFER_ID, attendeeAddress: "not-an-address" }))
      .toThrowError(expect.objectContaining({ code: "INVALID_ADDRESS" }) as unknown as Error);
  });

  it("rejects an offer id that is not 64 hex characters", () => {
    expect(() => buildAcceptOfferTxjson({ offerId: "DEADBEEF", attendeeAddress: ATTENDEE }))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }) as unknown as Error);
  });
});

describe("buildClaimSignRequest", () => {
  it("builds the Xaman envelope around an untouched accept payload", () => {
    const request = buildClaimSignRequest({
      offerId: OFFER_ID,
      attendeeAddress: ATTENDEE,
      eventId: EVENT_ID,
      badgeName: "Feooh Meetup 2026",
    });

    expect(request.txjson).toEqual({
      TransactionType: "NFTokenAcceptOffer",
      Account: ATTENDEE,
      NFTokenSellOffer: OFFER_ID,
    });
    // Nothing the attendee did not agree to.
    expect(Object.keys(request.txjson)).toHaveLength(3);

    expect(request.options).toEqual({ submit: true, expire: CLAIM_PAYLOAD_EXPIRE_MINUTES });

    expect(request.custom_meta.identifier).toBe(`poap-${EVENT_ID}-8685A6D0`);
    expect(request.custom_meta.blob).toEqual({
      kind: "poap-claim",
      eventId: EVENT_ID,
      offerId: OFFER_ID,
      attendeeAddress: ATTENDEE,
    });
    expect(request.custom_meta.instruction).toContain("Feooh Meetup 2026");
    expect(request.custom_meta.instruction).toContain("soulbound");
  });

  it("omits return_url unless one was asked for, and includes only the halves given", () => {
    const without = buildClaimSignRequest({
      offerId: OFFER_ID,
      attendeeAddress: ATTENDEE,
      eventId: EVENT_ID,
    });
    expect(without.options.return_url).toBeUndefined();

    const withWeb = buildClaimSignRequest({
      offerId: OFFER_ID,
      attendeeAddress: ATTENDEE,
      eventId: EVENT_ID,
      returnUrl: { web: "https://example.test/claimed" },
    });
    expect(withWeb.options.return_url).toEqual({ web: "https://example.test/claimed" });
  });

  it("rejects an event id above the reserved taxon boundary", () => {
    expect(() =>
      buildClaimSignRequest({
        offerId: OFFER_ID,
        attendeeAddress: ATTENDEE,
        eventId: 2_147_483_648,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TAXON" }) as unknown as Error);
  });
});

// ---------------------------------------------------------------------------

function signedWebhook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: {
      url: "https://example.test/webhooks/xaman",
      application_uuidv4: "app-uuid",
      payload_uuidv4: "payload-uuid-1",
      opened_by_deeplink: false,
    },
    custom_meta: {
      identifier: `poap-${EVENT_ID}-8685A6D0`,
      blob: { kind: "poap-claim", eventId: EVENT_ID, offerId: OFFER_ID, attendeeAddress: ATTENDEE },
      instruction: "Claim your badge",
    },
    payloadResponse: {
      payload_uuidv4: "payload-uuid-1",
      reference_call_uuidv4: "ref-uuid",
      signed: true,
      user_token: true,
      return_url: { app: null, web: null },
      txid: TX_HASH,
      account: ATTENDEE,
    },
    userToken: null,
    ...overrides,
  };
}

describe("parseXamanWebhook", () => {
  it("reads a signed delivery", () => {
    expect(parseXamanWebhook(signedWebhook())).toEqual({
      payloadUuid: "payload-uuid-1",
      signed: true,
      txHash: TX_HASH,
      account: ATTENDEE,
      rejected: false,
    });
  });

  it("reports a rejected signature without a transaction hash", () => {
    const parsed = parseXamanWebhook(
      signedWebhook({
        payloadResponse: {
          payload_uuidv4: "payload-uuid-1",
          reference_call_uuidv4: "ref-uuid",
          signed: false,
          user_token: false,
          return_url: { app: null, web: null },
          txid: null,
        },
      }),
    );

    expect(parsed.signed).toBe(false);
    expect(parsed.rejected).toBe(true);
    expect(parsed.txHash).toBeUndefined();
    expect(parsed.payloadUuid).toBe("payload-uuid-1");
  });

  it("falls back to meta.payload_uuidv4 and accepts the flat websocket shape", () => {
    const fromMeta = parseXamanWebhook({
      meta: { payload_uuidv4: "meta-uuid" },
      payloadResponse: { signed: true, txid: TX_HASH },
    });
    expect(fromMeta.payloadUuid).toBe("meta-uuid");

    const flat = parseXamanWebhook({
      payload_uuidv4: "ws-uuid",
      signed: true,
      txid: TX_HASH,
      account: ATTENDEE,
    });
    expect(flat).toMatchObject({ payloadUuid: "ws-uuid", signed: true, txHash: TX_HASH });
  });

  it("throws ValidationError on a malformed body", () => {
    for (const body of [null, "nope", 42, {}, { meta: {} }, { payloadResponse: { signed: "yes" } }]) {
      let thrown: unknown;
      try {
        parseXamanWebhook(body);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `expected ${JSON.stringify(body)} to be rejected`).toBeInstanceOf(XrplLayerError);
      expect((thrown as XrplLayerError).code).toBe("INVALID_INPUT");
    }
  });
});

describe("parseXamanClaimMeta", () => {
  it("recovers the ids we stashed on the payload", () => {
    expect(parseXamanClaimMeta(signedWebhook())).toEqual({
      eventId: EVENT_ID,
      offerId: OFFER_ID,
      attendeeAddress: ATTENDEE,
    });
  });

  it("accepts a blob that came back as a JSON string", () => {
    const body = signedWebhook({
      custom_meta: {
        identifier: null,
        blob: JSON.stringify({ eventId: 7, offerId: OFFER_ID, attendeeAddress: ATTENDEE }),
        instruction: null,
      },
    });
    expect(parseXamanClaimMeta(body).eventId).toBe(7);
  });

  it("falls back to the identifier when the blob is gone", () => {
    const body = signedWebhook({
      custom_meta: { identifier: "poap-99-8685A6D0", blob: null, instruction: null },
    });
    expect(parseXamanClaimMeta(body)).toEqual({ eventId: 99 });
  });

  it("returns nothing rather than throwing on junk", () => {
    expect(parseXamanClaimMeta({ custom_meta: { blob: { eventId: -1, offerId: "nope" } } })).toEqual({});
    expect(parseXamanClaimMeta("not even an object")).toEqual({});
  });
});
