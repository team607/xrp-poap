/**
 * Verification tests.
 *
 * The load-bearing one is "a burned badge is still attendance". If that ever
 * goes red, the system is broken in the exact way brief section 4 forbids.
 *
 * Fixtures are the real measured values from docs/ground-truth.md: a live
 * testnet badge minted under taxon 424242, claimed, then burned.
 */
import { decodeAccountID, encodeAccountID } from "xrpl";
import { describe, expect, it } from "vitest";
import { MockGateway, rippledError } from "../../test/helpers/mock-gateway.js";
import { XrplLayerError } from "../errors.js";
import {
  decodeNftokenId,
  recoverNftokenId,
  unscrambleTaxon,
  verifyClaim,
} from "./verify.js";

// ---------------------------------------------------------------------------
// Fixtures — measured, not invented
// ---------------------------------------------------------------------------

/** The live testnet badge from docs/ground-truth.md. */
const NFTOKEN_ID = "000100002FAFC427A43949996C47DCC5B5AC6D10B2C8505667ABB1140132438B";
const ISSUER_ACCOUNT_ID = "2FAFC427A43949996C47DCC5B5AC6D10B2C85056";
const EVENT_ID = 424242;
const SEQUENCE = 20071307;
const SCRAMBLED_TAXON = 1739305236; // 0x67ABB114

const ATTENDEE_ACCOUNT_ID = "0102030405060708090A0B0C0D0E0F1011121314";
const STRANGER_ACCOUNT_ID = "FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00";

/** Derived rather than transcribed, then pinned by a test below. */
const address = (accountIdHex: string): string =>
  encodeAccountID(Buffer.from(accountIdHex, "hex"));
const ISSUER = address(ISSUER_ACCOUNT_ID);
const ATTENDEE = address(ATTENDEE_ACCOUNT_ID);
const STRANGER = address(STRANGER_ACCOUNT_ID);

const TX_HASH = "1F2E3D4C5B6A798807162534435261708F9E0D1C2B3A49586776859403A2B1C0";
const OFFER_ID = "5CE7B4A39281706F5E4D3C2B1A09F8E7D6C5B4A392817069F8E7D6C5B4A39281";
const BUY_OFFER_ID = "77777777AAAA8888BBBB9999CCCC0000DDDD1111EEEE2222FFFF333344445555";
/** A second sell offer, used to show the reported id tracks the chain. */
const OTHER_SELL_OFFER_ID = "0BADC0DE".repeat(8);
const LEDGER_INDEX = 9_318_442;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Assembles a 256-bit NFTokenID the way the protocol does. */
function buildNftokenId(opts: {
  taxon: number;
  sequence: number;
  issuerAccountIdHex?: string;
  flags?: number;
  transferFee?: number;
}): string {
  const {
    taxon,
    sequence,
    issuerAccountIdHex = ISSUER_ACCOUNT_ID,
    flags = 1,
    transferFee = 0,
  } = opts;
  const scramble = Number((384_160_001n * BigInt(sequence) + 2459n) % (1n << 32n));
  const scrambled = (taxon ^ scramble) >>> 0;
  const hex = (n: number, width: number): string =>
    n.toString(16).toUpperCase().padStart(width, "0");
  return (
    hex(flags, 4) + hex(transferFee, 4) + issuerAccountIdHex + hex(scrambled, 8) + hex(sequence, 8)
  );
}

function deletedOfferNode(
  ledgerIndex: string,
  nftokenId: string,
  owner = ISSUER,
): Record<string, any> {
  return {
    DeletedNode: {
      LedgerEntryType: "NFTokenOffer",
      LedgerIndex: ledgerIndex,
      FinalFields: {
        Amount: "0",
        Destination: ATTENDEE,
        Flags: 1,
        NFTokenID: nftokenId,
        Owner: owner,
        PreviousTxnID: TX_HASH,
      },
    },
  };
}

function acceptMeta(over: Record<string, any> = {}): Record<string, any> {
  return {
    TransactionResult: "tesSUCCESS",
    TransactionIndex: 0,
    nftoken_id: NFTOKEN_ID,
    AffectedNodes: [
      deletedOfferNode(OFFER_ID, NFTOKEN_ID),
      { ModifiedNode: { LedgerEntryType: "AccountRoot", FinalFields: { Account: ATTENDEE } } },
    ],
    ...over,
  };
}

/** Nodes that omit the convenience field force the AffectedNodes walk. */
function acceptMetaWithoutNftokenId(over: Record<string, any> = {}): Record<string, any> {
  const meta = acceptMeta(over);
  delete meta.nftoken_id;
  return meta;
}

interface TxOpts {
  body?: Record<string, any>;
  meta?: Record<string, any> | null;
  validated?: boolean;
}

/** API v2 — xrpl.js v5's default. Transaction fields live under tx_json. */
function acceptTxV2(opts: TxOpts = {}): Record<string, any> {
  const result: Record<string, any> = {
    tx_json: {
      TransactionType: "NFTokenAcceptOffer",
      Account: ATTENDEE,
      NFTokenSellOffer: OFFER_ID,
      Fee: "12",
      Sequence: 3,
      SigningPubKey: "ED0000000000000000000000000000000000000000000000000000000000000000",
      ...opts.body,
    },
    hash: TX_HASH,
    validated: opts.validated ?? true,
    ledger_index: LEDGER_INDEX,
    ledger_hash: "8".repeat(64),
    close_time_iso: "2026-08-20T09:41:20Z",
    ctid: "C08E36AA00000000",
  };
  const meta = opts.meta === null ? undefined : (opts.meta ?? acceptMeta());
  if (meta) result.meta = meta;
  return { result };
}

/** API v1 — transaction fields at the top level of the result. */
function acceptTxV1(opts: TxOpts = {}): Record<string, any> {
  const result: Record<string, any> = {
    TransactionType: "NFTokenAcceptOffer",
    Account: ATTENDEE,
    NFTokenSellOffer: OFFER_ID,
    Fee: "12",
    Sequence: 3,
    hash: TX_HASH,
    inLedger: LEDGER_INDEX,
    ledger_index: LEDGER_INDEX,
    date: 786_361_280,
    validated: opts.validated ?? true,
    ...opts.body,
  };
  const meta = opts.meta === null ? undefined : (opts.meta ?? acceptMeta());
  if (meta) result.meta = meta;
  return { result };
}

function nftInfo(over: Record<string, any> = {}): Record<string, any> {
  return {
    result: {
      nft_id: NFTOKEN_ID,
      ledger_index: LEDGER_INDEX,
      owner: ATTENDEE,
      is_burned: false,
      uri: "697066733A2F2F62616679",
      flags: 1,
      transfer_fee: 0,
      issuer: ISSUER,
      nft_taxon: EVENT_ID,
      nft_serial: SEQUENCE,
      ...over,
    },
  };
}

function gatewayWith(txResponse: unknown, nftInfoResponse?: unknown): MockGateway {
  const gateway = new MockGateway({ issuerAddress: ISSUER });
  gateway.onRequest("tx", txResponse);
  if (nftInfoResponse !== undefined) gateway.onRequest("nft_info", nftInfoResponse);
  return gateway;
}

const claim = { address: ATTENDEE, eventId: EVENT_ID, txHash: TX_HASH };

// ---------------------------------------------------------------------------

describe("fixtures", () => {
  it("derives the measured issuer address from the measured AccountID", () => {
    // Pins docs/ground-truth.md so a fixture typo cannot quietly pass.
    expect(ISSUER).toBe("rnM9K73cbYACGq7WVXQHeT4nTzH2kjGW1Z");
    expect(buildNftokenId({ taxon: EVENT_ID, sequence: SEQUENCE })).toBe(NFTOKEN_ID);
  });
});

describe("unscrambleTaxon", () => {
  it("recovers the taxon from the real measured token", () => {
    // 0x67ABB114 scrambled with sequence 0x0132438B is taxon 424242.
    expect(unscrambleTaxon(SCRAMBLED_TAXON, SEQUENCE)).toBe(EVENT_ID);
  });

  it("is its own inverse", () => {
    for (const [taxon, sequence] of [
      [0, 0],
      [1, 1],
      [7777, 42],
      [EVENT_ID, SEQUENCE],
      [2_147_483_647, 12_345],
    ] as const) {
      const scramble = Number((384_160_001n * BigInt(sequence) + 2459n) % (1n << 32n));
      expect(unscrambleTaxon((taxon ^ scramble) >>> 0, sequence)).toBe(taxon);
    }
  });

  it("does not overflow at the top of the 32-bit sequence range", () => {
    // 384160001 * 0xFFFFFFFF is ~1.65e18: past MAX_SAFE_INTEGER, hence BigInt.
    const sequence = 0xffffffff;
    const scramble = Number((384_160_001n * BigInt(sequence) + 2459n) % (1n << 32n));
    expect(unscrambleTaxon((12345 ^ scramble) >>> 0, sequence)).toBe(12345);
  });
});

describe("decodeNftokenId", () => {
  it("decodes every field of the real measured token", () => {
    const decoded = decodeNftokenId(NFTOKEN_ID);
    expect(decoded).toMatchObject({
      nftokenId: NFTOKEN_ID,
      flags: 1, // tfBurnable alone — soulbound, per CLAUDE.md
      transferFee: 0,
      issuerAccountIdHex: ISSUER_ACCOUNT_ID,
      issuer: ISSUER,
      taxon: EVENT_ID,
      sequence: SEQUENCE,
    });
  });

  it("keeps the raw AccountID hex in step with the classic address", () => {
    const decoded = decodeNftokenId(NFTOKEN_ID);
    expect(Buffer.from(decodeAccountID(decoded.issuer!)).toString("hex").toUpperCase()).toBe(
      decoded.issuerAccountIdHex,
    );
  });

  it("accepts lowercase input and normalises it", () => {
    expect(decodeNftokenId(NFTOKEN_ID.toLowerCase()).taxon).toBe(EVENT_ID);
  });

  it("rejects anything that is not a 64-character hex id", () => {
    expect(() => decodeNftokenId("deadbeef")).toThrow(XrplLayerError);
    expect(() => decodeNftokenId("Z".repeat(64))).toThrow(/64-character hex NFTokenID/);
  });
});

describe("recoverNftokenId", () => {
  const body = { NFTokenSellOffer: OFFER_ID };

  it("prefers meta.nftoken_id when the node supplies it", () => {
    expect(recoverNftokenId(acceptMeta(), body)).toEqual({
      nftokenId: NFTOKEN_ID,
      source: "meta.nftoken_id",
    });
  });

  it("falls back to the deleted NFTokenOffer node when it does not", () => {
    expect(recoverNftokenId(acceptMetaWithoutNftokenId(), body)).toEqual({
      nftokenId: NFTOKEN_ID,
      source: "affected_nodes",
    });
  });

  it("reads PreviousFields when the deleted node has no FinalFields", () => {
    const meta = {
      TransactionResult: "tesSUCCESS",
      AffectedNodes: [
        {
          DeletedNode: {
            LedgerEntryType: "NFTokenOffer",
            LedgerIndex: OFFER_ID,
            PreviousFields: { NFTokenID: NFTOKEN_ID },
          },
        },
      ],
    };
    expect(recoverNftokenId(meta, body).nftokenId).toBe(NFTOKEN_ID);
  });

  it("picks the offer this transaction actually named in a brokered accept", () => {
    const decoy = buildNftokenId({ taxon: 999, sequence: 7 });
    const meta = {
      TransactionResult: "tesSUCCESS",
      AffectedNodes: [
        deletedOfferNode(BUY_OFFER_ID, decoy),
        deletedOfferNode(OFFER_ID, NFTOKEN_ID),
      ],
    };
    expect(recoverNftokenId(meta, { NFTokenSellOffer: OFFER_ID }).nftokenId).toBe(NFTOKEN_ID);
  });

  it("reports source \"none\" when neither path yields an id", () => {
    expect(recoverNftokenId({ TransactionResult: "tesSUCCESS", AffectedNodes: [] }, body)).toEqual({
      source: "none",
    });
    expect(recoverNftokenId(undefined, body)).toEqual({ source: "none" });
  });

  it("ignores a malformed nftoken_id and walks AffectedNodes instead", () => {
    const meta = acceptMeta({ nftoken_id: "not-a-token-id" });
    expect(recoverNftokenId(meta, body)).toEqual({
      nftokenId: NFTOKEN_ID,
      source: "affected_nodes",
    });
  });
});

describe("verifyClaim — the happy path", () => {
  it("verifies a good claim from an API v2 response", () => {
    const gateway = gatewayWith(acceptTxV2(), nftInfo());
    return verifyClaim(gateway, claim).then((result) => {
      expect(result.attended).toBe(true);
      expect(result.status).toBe("attended");
      expect(result.failedCheck).toBeUndefined();
      expect(result.checks).toEqual({
        transactionFound: true,
        isAcceptOffer: true,
        submittedByAddress: true,
        succeeded: true,
        issuerAndTaxonMatch: true,
      });
      expect(result.nftokenId).toBe(NFTOKEN_ID);
      expect(result.isBurned).toBe(false);
      expect(result.currentOwner).toBe(ATTENDEE);
      expect(result.ledgerIndex).toBe(LEDGER_INDEX);
    });
  });

  it("verifies the same claim from an API v1 response", async () => {
    // v1 puts TransactionType at the top level; reading only tx_json would
    // silently fail isAcceptOffer here.
    const gateway = gatewayWith(acceptTxV1(), nftInfo());
    const result = await verifyClaim(gateway, claim);
    expect(result.attended).toBe(true);
    expect(result.status).toBe("attended");
    expect(result.nftokenId).toBe(NFTOKEN_ID);
    expect(result.ledgerIndex).toBe(LEDGER_INDEX);
  });

  it("looks the transaction up by hash, normalising lowercase input", async () => {
    const gateway = gatewayWith(acceptTxV2(), nftInfo());
    await verifyClaim(gateway, { ...claim, txHash: TX_HASH.toLowerCase() });
    expect(gateway.lastRequest("tx")).toEqual({ command: "tx", transaction: TX_HASH });
  });

  it("reports no currentOwner when nft_info comes back without one", async () => {
    // getNftInfo coerces a missing owner to "" because NftInfo.owner is a
    // required string. That sentinel is not an address and must never surface
    // as one.
    const gateway = gatewayWith(acceptTxV2(), nftInfo({ owner: undefined }));
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(true);
    expect(result.currentOwner).toBeUndefined();
  });

  it("honours an explicit issuerAddress over the gateway default", async () => {
    const gateway = new MockGateway({ issuerAddress: STRANGER });
    gateway.onRequest("tx", acceptTxV2());
    gateway.onRequest("nft_info", nftInfo());
    const result = await verifyClaim(gateway, { ...claim, issuerAddress: ISSUER });
    expect(result.attended).toBe(true);
  });
});

describe("verifyClaim — a burned badge is still attendance", () => {
  it("RETURNS attended:true WITH status attended_badge_burned WHEN THE BADGE WAS BURNED AFTER THE CLAIM", async () => {
    // The single most important assertion in this codebase. Brief section 4:
    // attendance is an event, not a state. Measured: after a burn, nft_info
    // still answers with owner, issuer and taxon intact.
    const gateway = gatewayWith(acceptTxV2(), nftInfo({ is_burned: true }));
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(true);
    expect(result.status).toBe("attended_badge_burned");
    expect(result.isBurned).toBe(true);
    expect(result.failedCheck).toBeUndefined();
    expect(result.checks.issuerAndTaxonMatch).toBe(true);
    expect(result.reason).toMatch(/attendance is an event, not a state/i);
  });

  it("never consults account_nfts, which returns nothing for a burned badge", async () => {
    const gateway = gatewayWith(acceptTxV2(), nftInfo({ is_burned: true }));
    await verifyClaim(gateway, claim);
    // account_nfts is the trap: it is the query that looks like it answers
    // "did they attend" and returns zero for someone who demonstrably did.
    expect(gateway.requests.map((r) => r.command)).toEqual(["tx", "nft_info"]);
  });

  it("stays attended even when the badge now sits with someone else", async () => {
    // currentOwner is informational only and must never move `attended`.
    const gateway = gatewayWith(acceptTxV2(), nftInfo({ owner: STRANGER }));
    const result = await verifyClaim(gateway, claim);
    expect(result.attended).toBe(true);
    expect(result.status).toBe("attended");
    expect(result.currentOwner).toBe(STRANGER);
  });
});

describe("verifyClaim — ownership is not attendance", () => {
  it("returns not_attended for a wallet that holds the badge but never accepted it", async () => {
    // The accept was submitted by a stranger; nft_info would say the badge is
    // ours. Holding it is not the same as having claimed it.
    const gateway = gatewayWith(acceptTxV2({ body: { Account: STRANGER } }), nftInfo());
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(false);
    expect(result.status).toBe("not_attended");
    expect(result.failedCheck).toBe("submittedByAddress");
    // And we never even asked who holds it — ownership is not an input.
    expect(gateway.requests.map((r) => r.command)).toEqual(["tx"]);
  });
});

describe("verifyClaim — each of the five checks fails on its own", () => {
  it("1. transactionFound: txnNotFound is a clean false, not a throw", async () => {
    const gateway = gatewayWith(rippledError("txnNotFound"));
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(false);
    expect(result.status).toBe("not_attended");
    expect(result.failedCheck).toBe("transactionFound");
    expect(result.checks.transactionFound).toBe(false);
    expect(result.reason).toMatch(/No transaction/);
  });

  it("1. transactionFound: a txnNotFound error body is also a clean false", async () => {
    const gateway = gatewayWith({ result: { error: "txnNotFound", status: "error" } });
    const result = await verifyClaim(gateway, claim);
    expect(result.failedCheck).toBe("transactionFound");
    expect(result.attended).toBe(false);
  });

  it("1. transactionFound: a malformed hash fails without a round trip", async () => {
    const gateway = new MockGateway({ issuerAddress: ISSUER });
    const result = await verifyClaim(gateway, { ...claim, txHash: "nope" });
    expect(result.failedCheck).toBe("transactionFound");
    expect(result.reason).toMatch(/64-character hex transaction hash/);
    expect(gateway.requests).toHaveLength(0);
  });

  it("1. transactionFound: an unrecognised response shape fails cleanly", async () => {
    const gateway = gatewayWith({ result: { something_else: true } });
    const result = await verifyClaim(gateway, claim);
    expect(result.failedCheck).toBe("transactionFound");
  });

  it("2. isAcceptOffer: a mint at that hash is not an attendance record", async () => {
    const gateway = gatewayWith(
      acceptTxV2({ body: { TransactionType: "NFTokenMint", Account: ATTENDEE } }),
    );
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(false);
    expect(result.failedCheck).toBe("isAcceptOffer");
    expect(result.checks.transactionFound).toBe(true);
    expect(result.checks.isAcceptOffer).toBe(false);
    expect(result.reason).toMatch(/NFTokenMint/);
  });

  it("3. submittedByAddress: someone else's accept is not this wallet's claim", async () => {
    const gateway = gatewayWith(acceptTxV2({ body: { Account: STRANGER } }));
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(false);
    expect(result.failedCheck).toBe("submittedByAddress");
    expect(result.checks.isAcceptOffer).toBe(true);
    expect(result.checks.submittedByAddress).toBe(false);
    expect(result.reason).toContain(STRANGER);
  });

  it("4. succeeded: a tec result is not attendance", async () => {
    const gateway = gatewayWith(
      acceptTxV2({ meta: acceptMeta({ TransactionResult: "tecNO_PERMISSION" }) }),
    );
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(false);
    expect(result.failedCheck).toBe("succeeded");
    expect(result.checks.submittedByAddress).toBe(true);
    expect(result.checks.succeeded).toBe(false);
    expect(result.reason).toMatch(/tecNO_PERMISSION/);
  });

  it("4. succeeded: an unvalidated transaction is not yet attendance", async () => {
    const gateway = gatewayWith(acceptTxV2({ validated: false }));
    const result = await verifyClaim(gateway, claim);
    expect(result.failedCheck).toBe("succeeded");
    expect(result.reason).toMatch(/validated false/);
  });

  it("4. succeeded: missing metadata cannot be assumed successful", async () => {
    const gateway = gatewayWith(acceptTxV2({ meta: null }));
    const result = await verifyClaim(gateway, claim);
    expect(result.failedCheck).toBe("succeeded");
    expect(result.reason).toMatch(/without decoded metadata/);
  });

  it("5. issuerAndTaxonMatch: a badge from another issuer is not ours", async () => {
    const gateway = gatewayWith(acceptTxV2(), nftInfo({ issuer: STRANGER }));
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(false);
    expect(result.failedCheck).toBe("issuerAndTaxonMatch");
    expect(result.checks.succeeded).toBe(true);
    expect(result.checks.issuerAndTaxonMatch).toBe(false);
    expect(result.reason).toContain(STRANGER);
    expect(result.nftokenId).toBe(NFTOKEN_ID);
  });

  it("5. issuerAndTaxonMatch: a badge for another event is not this event", async () => {
    const gateway = gatewayWith(acceptTxV2(), nftInfo({ nft_taxon: 999_000 }));
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(false);
    expect(result.failedCheck).toBe("issuerAndTaxonMatch");
    expect(result.reason).toMatch(/taxon is 999000, expected event 424242/);
  });

  it("5. issuerAndTaxonMatch: an unrecoverable NFTokenID fails cleanly", async () => {
    const meta = acceptMetaWithoutNftokenId({ AffectedNodes: [] });
    const gateway = gatewayWith(acceptTxV2({ meta }));
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(false);
    expect(result.failedCheck).toBe("issuerAndTaxonMatch");
    expect(result.reason).toMatch(/Could not recover the NFTokenID/);
  });
});

describe("verifyClaim — NFTokenID recovery", () => {
  it("uses meta.nftoken_id when the node provides it", async () => {
    const gateway = gatewayWith(acceptTxV2(), nftInfo());
    const result = await verifyClaim(gateway, claim);
    expect(result.nftokenId).toBe(NFTOKEN_ID);
    expect(gateway.lastRequest("nft_info")).toEqual({
      command: "nft_info",
      nft_id: NFTOKEN_ID,
    });
  });

  it("derives it from AffectedNodes when meta.nftoken_id is absent", async () => {
    const gateway = gatewayWith(
      acceptTxV2({ meta: acceptMetaWithoutNftokenId() }),
      nftInfo(),
    );
    const result = await verifyClaim(gateway, claim);
    expect(result.attended).toBe(true);
    expect(result.nftokenId).toBe(NFTOKEN_ID);
  });

  it("derives it from AffectedNodes on an API v1 response too", async () => {
    const gateway = gatewayWith(
      acceptTxV1({ meta: acceptMetaWithoutNftokenId() }),
      nftInfo(),
    );
    const result = await verifyClaim(gateway, claim);
    expect(result.attended).toBe(true);
    expect(result.nftokenId).toBe(NFTOKEN_ID);
  });
});

describe("verifyClaim — sellOfferId is read from the chain", () => {
  // The offer id is the one field an attacker could previously choose: it was
  // taken from a request body or from an unauthenticated webhook and persisted
  // verbatim. Nothing here is caller-supplied — VerifyClaimInput has no offer
  // field at all — so every id below can only have come off the ledger.

  it("reports the NFTokenSellOffer of the accept transaction on the happy path", async () => {
    const gateway = gatewayWith(acceptTxV2(), nftInfo());
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(true);
    expect(result.sellOfferId).toBe(OFFER_ID);
  });

  it("reports it on the burned-badge path too", async () => {
    const gateway = gatewayWith(acceptTxV2(), nftInfo({ is_burned: true }));
    const result = await verifyClaim(gateway, claim);

    expect(result.status).toBe("attended_badge_burned");
    expect(result.sellOfferId).toBe(OFFER_ID);
  });

  it("follows the transaction body, so a different offer on chain reports differently", async () => {
    // Proof of provenance: the only thing that changed is the ledger's copy of
    // the transaction, and the answer changed with it.
    const gateway = gatewayWith(
      acceptTxV2({ body: { NFTokenSellOffer: OTHER_SELL_OFFER_ID } }),
      nftInfo(),
    );
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(true);
    expect(result.sellOfferId).toBe(OTHER_SELL_OFFER_ID);
    expect(result.sellOfferId).not.toBe(OFFER_ID);
  });

  it("reads it from the top level of an API v1 response", async () => {
    const gateway = gatewayWith(acceptTxV1(), nftInfo());
    expect((await verifyClaim(gateway, claim)).sellOfferId).toBe(OFFER_ID);
  });

  it("prefers the sell offer when a brokered accept names both", async () => {
    const gateway = gatewayWith(
      acceptTxV2({ body: { NFTokenSellOffer: OFFER_ID, NFTokenBuyOffer: BUY_OFFER_ID } }),
      nftInfo(),
    );
    const result = await verifyClaim(gateway, claim);

    expect(result.sellOfferId).toBe(OFFER_ID);
    expect(result.sellOfferId).not.toBe(BUY_OFFER_ID);
  });

  it("leaves it undefined for a brokered accept that names only a buy offer", async () => {
    // Our flow only ever creates sell offers, so this shape should not occur.
    // The point is that when it does, a buy-offer id cannot leak into a field
    // called sellOfferId — undefined is the honest answer, not a wrong id.
    const gateway = gatewayWith(
      acceptTxV2({ body: { NFTokenSellOffer: undefined, NFTokenBuyOffer: BUY_OFFER_ID } }),
      nftInfo(),
    );
    const result = await verifyClaim(gateway, claim);

    // The body was read, so a sell offer id would have been reported if there
    // were one to report.
    expect(result.checks.transactionFound).toBe(true);
    expect(result.sellOfferId).toBeUndefined();
  });

  it("ignores a malformed NFTokenSellOffer instead of passing junk through", async () => {
    const gateway = gatewayWith(
      acceptTxV2({ body: { NFTokenSellOffer: "0BAD" } }),
      nftInfo(),
    );
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(true);
    expect(result.sellOfferId).toBeUndefined();
  });

  it("keeps it on a failed verdict once the body has been read", async () => {
    // Useful diagnostics: a rejection that names the offer it looked at can be
    // audited later.
    const gateway = gatewayWith(
      acceptTxV2({ meta: acceptMeta({ TransactionResult: "tecNO_PERMISSION" }) }),
    );
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(false);
    expect(result.failedCheck).toBe("succeeded");
    expect(result.sellOfferId).toBe(OFFER_ID);
  });

  it("keeps it when the badge turns out to belong to another event", async () => {
    const gateway = gatewayWith(acceptTxV2(), nftInfo({ nft_taxon: 999_000 }));
    const result = await verifyClaim(gateway, claim);

    expect(result.failedCheck).toBe("issuerAndTaxonMatch");
    expect(result.sellOfferId).toBe(OFFER_ID);
  });

  it("has none when no transaction body was ever retrieved", async () => {
    const gateway = gatewayWith(rippledError("txnNotFound"));
    const result = await verifyClaim(gateway, claim);

    expect(result.failedCheck).toBe("transactionFound");
    expect(result.sellOfferId).toBeUndefined();
  });
});

describe("verifyClaim — degraded fallback on a node without nft_info", () => {
  it("decodes issuer and taxon from the NFTokenID when the node is not Clio", async () => {
    const gateway = gatewayWith(acceptTxV2(), rippledError("unknownCmd"));
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(true);
    expect(result.status).toBe("attended");
    expect(result.nftokenId).toBe(NFTOKEN_ID);
    expect(result.reason).toMatch(/Degraded verification/);
    // Burn status is unknowable here — and unknown is not false.
    expect(result.isBurned).toBeUndefined();
    expect(result.currentOwner).toBeUndefined();
  });

  it("degrades the same way when the node has never heard of the token", async () => {
    const gateway = gatewayWith(acceptTxV2(), rippledError("objectNotFound"));
    const result = await verifyClaim(gateway, claim);
    expect(result.attended).toBe(true);
    expect(result.reason).toMatch(/Degraded verification/);
  });

  it("still rejects a foreign issuer in degraded mode", async () => {
    const foreign = buildNftokenId({
      taxon: EVENT_ID,
      sequence: SEQUENCE,
      issuerAccountIdHex: STRANGER_ACCOUNT_ID,
    });
    const gateway = gatewayWith(
      acceptTxV2({ meta: acceptMeta({ nftoken_id: foreign }) }),
      rippledError("unknownCmd"),
    );
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(false);
    expect(result.failedCheck).toBe("issuerAndTaxonMatch");
    expect(result.reason).toContain(STRANGER);
  });

  it("still rejects a foreign taxon in degraded mode", async () => {
    const otherEvent = buildNftokenId({ taxon: 12_345, sequence: SEQUENCE });
    const gateway = gatewayWith(
      acceptTxV2({ meta: acceptMeta({ nftoken_id: otherEvent }) }),
      rippledError("unknownCmd"),
    );
    const result = await verifyClaim(gateway, claim);

    expect(result.attended).toBe(false);
    expect(result.failedCheck).toBe("issuerAndTaxonMatch");
    expect(result.reason).toMatch(/taxon is 12345, expected event 424242/);
  });
});

describe("verifyClaim — faults throw, bad claims do not", () => {
  it("throws a typed error when the tx lookup fails for any other reason", async () => {
    const gateway = gatewayWith(rippledError("tooBusy"));
    await expect(verifyClaim(gateway, claim)).rejects.toMatchObject({
      code: "LEDGER_QUERY_FAILED",
    });
  });

  it("throws rather than degrading when nft_info fails for a non-Clio reason", async () => {
    // A transient node failure must not be silently downgraded into a
    // lower-confidence answer.
    const gateway = gatewayWith(acceptTxV2(), rippledError("tooBusy"));
    await expect(verifyClaim(gateway, claim)).rejects.toBeInstanceOf(XrplLayerError);
  });

  it("rejects an event id outside the taxon range", async () => {
    const gateway = new MockGateway({ issuerAddress: ISSUER });
    await expect(
      verifyClaim(gateway, { ...claim, eventId: 2_147_483_648 }),
    ).rejects.toMatchObject({ code: "INVALID_TAXON" });
  });
});
