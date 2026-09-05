import { NFTokenCreateOfferFlags, NFTokenMintFlags, Wallet } from "xrpl";
import { describe, expect, it } from "vitest";
import { MockGateway, rippledError } from "../../test/helpers/mock-gateway.js";
import { XrplLayerError } from "../errors.js";
import type { CreateClaimOfferInput, SubmitOutcome } from "../types.js";
import { mint } from "./mint.js";
import {
  acceptOfferAs,
  buildAcceptOfferPayload,
  cancelClaimOffer,
  countPendingIssuerOffers,
  createClaimOffer,
  getSellOffers,
  isClaimOfferOpen,
} from "./offers.js";

const ISSUER = "rBdhYBA2uaVYG7ia2yusmPu5qMS4hE6oQ";
const ATTENDEE = "rPeZcWESwr1Wy64tw6JdVqtKNjhuUzHK2i";
const OTHER = "rP1DvDBuuK1KjGiD3qskqg9WKVyrcUDy2P";
const NFTOKEN_ID = "000800001234567890ABCDEF1234567890ABCDEF1234567800000001";
const OFFER_ID = "AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555FFFF6666AAAA7777BBBB8888";

function gateway(): MockGateway {
  return new MockGateway({ issuerAddress: ISSUER });
}

function queueOffer(gw: MockGateway, offerId = OFFER_ID, hash = "OFFERHASH"): MockGateway {
  return gw.onSubmit("NFTokenCreateOffer", {
    hash,
    ledgerIndex: 90_211,
    fee: "12",
    meta: { offer_id: offerId, TransactionResult: "tesSUCCESS" },
  });
}

function submittedTx(gw: MockGateway, type: string): Record<string, unknown> {
  const tx = gw.lastSubmit(type);
  if (!tx) throw new Error(`expected a ${type} to have been submitted`);
  return tx;
}

describe("createClaimOffer", () => {
  it("refuses a missing destination rather than defaulting to an open offer", async () => {
    const gw = queueOffer(gateway());

    await expect(
      createClaimOffer(gw, { nftokenId: NFTOKEN_ID } as unknown as CreateClaimOfferInput),
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
    expect(gw.submits).toHaveLength(0);
  });

  it("refuses an empty destination", async () => {
    const gw = queueOffer(gateway());

    await expect(
      createClaimOffer(gw, { nftokenId: NFTOKEN_ID, destination: "   " }),
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
    expect(gw.submits).toHaveLength(0);
  });

  it("refuses a destination that is not a valid classic address", async () => {
    const gw = queueOffer(gateway());

    await expect(
      createClaimOffer(gw, { nftokenId: NFTOKEN_ID, destination: "rNotARealAddress" }),
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
    expect(gw.submits).toHaveLength(0);
  });

  it("builds a zero-price sell offer locked to one destination", async () => {
    const gw = queueOffer(gateway());
    await createClaimOffer(gw, { nftokenId: NFTOKEN_ID, destination: ATTENDEE });

    const tx = submittedTx(gw, "NFTokenCreateOffer");
    expect(tx.TransactionType).toBe("NFTokenCreateOffer");
    expect(tx.Account).toBe(ISSUER);
    expect(tx.NFTokenID).toBe(NFTOKEN_ID);
    expect(tx.Amount).toBe("0");
    expect(tx.Destination).toBe(ATTENDEE);

    expect(tx.Flags).toBe(1);
    expect(tx.Flags).toBe(NFTokenCreateOfferFlags.tfSellNFToken);
    expect((tx.Flags as number) & NFTokenCreateOfferFlags.tfSellNFToken).toBe(
      NFTokenCreateOfferFlags.tfSellNFToken,
    );
  });

  it("reads offer_id out of metadata, not the top level of the result", async () => {
    const gw = gateway().onSubmit("NFTokenCreateOffer", {
      hash: "OFFERHASH",
      ledgerIndex: 90_211,
      fee: "12",
      meta: { offer_id: OFFER_ID, TransactionResult: "tesSUCCESS" },
      offer_id: "DECOY_TOP_LEVEL_OFFER",
    } as unknown as Partial<SubmitOutcome>);

    const offer = await createClaimOffer(gw, {
      nftokenId: NFTOKEN_ID,
      destination: ATTENDEE,
    });
    expect(offer.offerId).toBe(OFFER_ID);
    expect(offer.offerId).not.toBe("DECOY_TOP_LEVEL_OFFER");
  });

  it("throws when the node returns no offer_id in metadata", async () => {
    const gw = gateway().onSubmit("NFTokenCreateOffer", {
      hash: "OFFERHASH",
      meta: { TransactionResult: "tesSUCCESS" },
    });

    await expect(
      createClaimOffer(gw, { nftokenId: NFTOKEN_ID, destination: ATTENDEE }),
    ).rejects.toBeInstanceOf(XrplLayerError);
  });

  it("returns the whole ClaimOffer", async () => {
    const gw = queueOffer(gateway(), OFFER_ID, "HASH_OFFER");
    await expect(
      createClaimOffer(gw, { nftokenId: NFTOKEN_ID, destination: ATTENDEE }),
    ).resolves.toEqual({
      offerId: OFFER_ID,
      nftokenId: NFTOKEN_ID,
      destination: ATTENDEE,
      txHash: "HASH_OFFER",
      ledgerIndex: 90_211,
      fee: "12",
    });
  });
});

describe("flag collision regression (section 10)", () => {
  it("takes 1 from NFTokenMintFlags on mint and from NFTokenCreateOfferFlags on the offer", async () => {
    const gw = gateway();
    gw.onSubmit("NFTokenMint", { meta: { nftoken_id: NFTOKEN_ID } });
    queueOffer(gw);

    await mint(gw, { eventId: 7331, uri: "ipfs://badge/metadata.json" });
    await createClaimOffer(gw, { nftokenId: NFTOKEN_ID, destination: ATTENDEE });

    const mintTx = submittedTx(gw, "NFTokenMint");
    const offerTx = submittedTx(gw, "NFTokenCreateOffer");

    // Same number, different meanings. This is the whole trap.
    expect(NFTokenMintFlags.tfBurnable).toBe(NFTokenCreateOfferFlags.tfSellNFToken);
    expect(mintTx.Flags).toBe(NFTokenMintFlags.tfBurnable);
    expect(offerTx.Flags).toBe(NFTokenCreateOfferFlags.tfSellNFToken);

    // And each flag is only meaningful on its own transaction type.
    expect(mintTx.NFTokenTaxon).toBe(7331);
    expect("Destination" in mintTx).toBe(false);
    expect("NFTokenTaxon" in offerTx).toBe(false);
    expect(offerTx.Destination).toBe(ATTENDEE);
  });
});

describe("cancelClaimOffer", () => {
  it("cancels exactly the one offer, releasing its 0.2 XRP owner reserve", async () => {
    const gw = gateway().onSubmit("NFTokenCancelOffer", {
      hash: "CANCELHASH",
      ledgerIndex: 90_212,
    });

    await expect(cancelClaimOffer(gw, OFFER_ID)).resolves.toEqual({
      txHash: "CANCELHASH",
      ledgerIndex: 90_212,
    });

    const tx = submittedTx(gw, "NFTokenCancelOffer");
    expect(tx.TransactionType).toBe("NFTokenCancelOffer");
    expect(tx.Account).toBe(ISSUER);
    expect(tx.NFTokenOffers).toEqual([OFFER_ID]);
  });
});

describe("buildAcceptOfferPayload", () => {
  it("returns an unsigned payload with exactly the three required fields", () => {
    const payload = buildAcceptOfferPayload({
      offerId: OFFER_ID,
      attendeeAddress: ATTENDEE,
    });

    expect(payload).toEqual({
      TransactionType: "NFTokenAcceptOffer",
      Account: ATTENDEE,
      NFTokenSellOffer: OFFER_ID,
    });
    // Unsigned: no signature material of any kind belongs in this payload.
    expect(Object.keys(payload).sort()).toEqual([
      "Account",
      "NFTokenSellOffer",
      "TransactionType",
    ]);
  });

  it("rejects an invalid attendee address", () => {
    expect(() =>
      buildAcceptOfferPayload({ offerId: OFFER_ID, attendeeAddress: "nope" }),
    ).toThrowError(XrplLayerError);
  });

  it("rejects an empty offer id", () => {
    expect(() =>
      buildAcceptOfferPayload({ offerId: "", attendeeAddress: ATTENDEE }),
    ).toThrowError(XrplLayerError);
  });
});

describe("getSellOffers", () => {
  it("maps the node response onto the offer shape", async () => {
    const gw = gateway().onRequest("nft_sell_offers", {
      result: {
        offers: [
          {
            nft_offer_index: OFFER_ID,
            owner: ISSUER,
            amount: "0",
            destination: ATTENDEE,
            flags: 1,
          },
          { nft_offer_index: "OFFER2", owner: ISSUER, amount: "0" },
        ],
      },
    });

    await expect(getSellOffers(gw, NFTOKEN_ID)).resolves.toEqual([
      { offerId: OFFER_ID, owner: ISSUER, amount: "0", destination: ATTENDEE },
      { offerId: "OFFER2", owner: ISSUER, amount: "0" },
    ]);
    expect(gw.lastRequest("nft_sell_offers")?.nft_id).toBe(NFTOKEN_ID);
  });

  it("returns [] when the node answers objectNotFound", async () => {
    const gw = gateway().onRequest("nft_sell_offers", rippledError("objectNotFound"));
    await expect(getSellOffers(gw, NFTOKEN_ID)).resolves.toEqual([]);
  });

  it("rethrows any other node error", async () => {
    const gw = gateway().onRequest("nft_sell_offers", rippledError("noPermission"));
    await expect(getSellOffers(gw, NFTOKEN_ID)).rejects.toThrowError("noPermission");
  });
});

describe("countPendingIssuerOffers", () => {
  it("counts one page of the issuer's nft_offer objects", async () => {
    const gw = gateway().onRequest("account_objects", {
      result: { account_objects: [{}, {}, {}] },
    });

    await expect(countPendingIssuerOffers(gw)).resolves.toBe(3);
    const req = gw.lastRequest("account_objects");
    expect(req?.account).toBe(ISSUER);
    expect(req?.type).toBe("nft_offer");
  });

  it("follows the marker through every page", async () => {
    const gw = gateway()
      .onRequest("account_objects", {
        result: { account_objects: [{}, {}], marker: "PAGE2" },
      })
      .onRequest("account_objects", {
        result: { account_objects: [{}, {}, {}], marker: "PAGE3" },
      })
      .onRequest("account_objects", { result: { account_objects: [{}] } });

    await expect(countPendingIssuerOffers(gw)).resolves.toBe(6);
    expect(gw.requests).toHaveLength(3);
    expect(gw.requests[0]?.payload.marker).toBeUndefined();
    expect(gw.requests[1]?.payload.marker).toBe("PAGE2");
    expect(gw.requests[2]?.payload.marker).toBe("PAGE3");
  });

  it("counts a different account when one is passed explicitly", async () => {
    const gw = gateway().onRequest("account_objects", {
      result: { account_objects: [] },
    });

    await expect(countPendingIssuerOffers(gw, OTHER)).resolves.toBe(0);
    expect(gw.lastRequest("account_objects")?.account).toBe(OTHER);
  });
});

describe("acceptOfferAs", () => {
  it("submits the accept signed by the supplied wallet (scripts only)", async () => {
    const wallet = Wallet.generate();
    const gw = gateway().onSubmit("NFTokenAcceptOffer", {
      hash: "ACCEPTHASH",
      ledgerIndex: 90_213,
    });

    await expect(acceptOfferAs(gw, { offerId: OFFER_ID, wallet })).resolves.toEqual({
      txHash: "ACCEPTHASH",
      ledgerIndex: 90_213,
    });

    const tx = submittedTx(gw, "NFTokenAcceptOffer");
    expect(tx.Account).toBe(wallet.classicAddress);
    expect(tx.Account).not.toBe(ISSUER);
    expect(tx.NFTokenSellOffer).toBe(OFFER_ID);
    expect(gw.submits[0]?.options?.wallet).toBe(wallet);
  });
});

describe("isClaimOfferOpen", () => {
  it("is open while the NFTokenOffer object is still on the ledger", async () => {
    const gw = gateway().onRequest("ledger_entry", {
      result: { index: OFFER_ID, node: { LedgerEntryType: "NFTokenOffer" } },
    });

    await expect(isClaimOfferOpen(gw, OFFER_ID)).resolves.toBe(true);
    expect(gw.lastRequest("ledger_entry")?.nft_offer).toBe(OFFER_ID);
  });

  it("is closed when the node throws entryNotFound", async () => {
    const gw = gateway().onRequest("ledger_entry", rippledError("entryNotFound"));
    await expect(isClaimOfferOpen(gw, OFFER_ID)).resolves.toBe(false);
  });

  it("is closed when the node reports entryNotFound in the result body", async () => {
    // Same fact, different wire shape. A node that answers this way used to
    // read as "still open", which is the state that leaves a desk waiting on
    // an accept that already happened.
    const gw = gateway().onRequest("ledger_entry", { result: { error: "entryNotFound" } });
    await expect(isClaimOfferOpen(gw, OFFER_ID)).resolves.toBe(false);
  });

  it("does not turn a real query failure into 'closed'", async () => {
    const gw = gateway().onRequest("ledger_entry", rippledError("noNetwork"));
    await expect(isClaimOfferOpen(gw, OFFER_ID)).rejects.toBeInstanceOf(XrplLayerError);
  });
});
