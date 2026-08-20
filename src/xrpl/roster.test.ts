/**
 * Roster / ledger-query tests.
 *
 * Two themes run through these: the Clio-vs-rippled split must produce an
 * actionable error rather than a bare `unknownCmd`, and `account_nfts` must
 * never be mistaken for an attendance answer — it goes to zero on a burn.
 *
 * MockGateway reuses a lone queued handler for every call, so pagination tests
 * queue one handler per page.
 */
import { convertStringToHex, encodeAccountID, rippleTimeToISOTime } from "xrpl";
import { describe, expect, it } from "vitest";
import { MockGateway, rippledError } from "../../test/helpers/mock-gateway.js";
import {
  CLIO_ENDPOINTS,
  clioUnavailableError,
  getAccountNfts,
  getNftHistory,
  getNftInfo,
  getRoster,
  unwrapResult,
} from "./roster.js";

const address = (accountIdHex: string): string =>
  encodeAccountID(Buffer.from(accountIdHex, "hex"));

const ISSUER = address("2FAFC427A43949996C47DCC5B5AC6D10B2C85056");
const ALICE = address("0102030405060708090A0B0C0D0E0F1011121314");
const BOB = address("FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00");
const EVENT_ID = 424242;

const URI = "ipfs://bafybeigdyrztexample/metadata.json";
const URI_HEX = convertStringToHex(URI);

const TOKEN_A = "000100002FAFC427A43949996C47DCC5B5AC6D10B2C8505667ABB1140132438B";
const TOKEN_B = "000100002FAFC427A43949996C47DCC5B5AC6D10B2C8505667ABB1150132438C";
const TOKEN_C = "000100002FAFC427A43949996C47DCC5B5AC6D10B2C8505667ABB1160132438D";
const TOKEN_D = "000100002FAFC427A43949996C47DCC5B5AC6D10B2C8505667ABB1170132438E";
const OFFER_ID = "5CE7B4A39281706F5E4D3C2B1A09F8E7D6C5B4A392817069F8E7D6C5B4A39281";
const HASH = (n: number): string => String(n).repeat(2).padStart(64, "A");

/** One entry as Clio's nfts_by_issuer returns it. */
function issuerNft(over: Record<string, any> = {}): Record<string, any> {
  return {
    nft_id: TOKEN_A,
    ledger_index: 9_318_000,
    owner: ISSUER,
    is_burned: false,
    uri: URI_HEX,
    flags: 1,
    transfer_fee: 0,
    issuer: ISSUER,
    nft_taxon: EVENT_ID,
    nft_serial: 1,
    ...over,
  };
}

function gateway(): MockGateway {
  return new MockGateway({ issuerAddress: ISSUER });
}

// ---------------------------------------------------------------------------
// getRoster
// ---------------------------------------------------------------------------

describe("getRoster", () => {
  it("follows the marker across two pages and merges the entries", async () => {
    const g = gateway();
    g.onRequest("nfts_by_issuer", {
      result: {
        issuer: ISSUER,
        nfts: [
          issuerNft({ nft_id: TOKEN_A, owner: ALICE, nft_serial: 1 }),
          issuerNft({ nft_id: TOKEN_B, owner: BOB, nft_serial: 2 }),
        ],
        marker: "PAGE_TWO",
      },
    });
    g.onRequest("nfts_by_issuer", {
      result: {
        issuer: ISSUER,
        nfts: [
          issuerNft({ nft_id: TOKEN_C, owner: ISSUER, nft_serial: 3 }),
          issuerNft({ nft_id: TOKEN_D, owner: ALICE, is_burned: true, nft_serial: 4 }),
        ],
      },
    });

    const roster = await getRoster(g, EVENT_ID);

    expect(g.requests).toHaveLength(2);
    expect(g.requests[0]!.payload).toEqual({
      command: "nfts_by_issuer",
      issuer: ISSUER,
      nft_taxon: EVENT_ID,
    });
    expect(g.requests[1]!.payload).toMatchObject({ marker: "PAGE_TWO" });
    expect(roster.entries.map((e) => e.nftokenId)).toEqual([
      TOKEN_A,
      TOKEN_B,
      TOKEN_C,
      TOKEN_D,
    ]);
    // The walk finished, so no partial marker.
    expect(roster.marker).toBeUndefined();
  });

  it("counts minted, claimed and burned — a burned badge that left the issuer is still claimed", async () => {
    const g = gateway();
    g.onRequest("nfts_by_issuer", {
      result: {
        nfts: [
          issuerNft({ nft_id: TOKEN_A, owner: ALICE }), // claimed
          issuerNft({ nft_id: TOKEN_B, owner: ISSUER }), // never picked up
          issuerNft({ nft_id: TOKEN_C, owner: BOB, is_burned: true }), // claimed then burned
          issuerNft({ nft_id: TOKEN_D, owner: ISSUER, is_burned: true }), // revoked before claim
        ],
      },
    });

    const roster = await getRoster(g, EVENT_ID);

    expect(roster.minted).toBe(4);
    expect(roster.claimed).toBe(2);
    expect(roster.burned).toBe(2);
    expect(roster.entries.map((e) => e.claimed)).toEqual([true, false, true, false]);
    expect(roster.eventId).toBe(EVENT_ID);
    expect(roster.issuer).toBe(ISSUER);
  });

  it("maps each entry and decodes the URI", async () => {
    const g = gateway();
    g.onRequest("nfts_by_issuer", {
      result: { nfts: [issuerNft({ owner: ALICE, nft_serial: 17 })] },
    });

    const [entry] = (await getRoster(g, EVENT_ID)).entries;

    expect(entry).toEqual({
      nftokenId: TOKEN_A,
      owner: ALICE,
      isBurned: false,
      taxon: EVENT_ID,
      serial: 17,
      uri: URI,
      claimed: true,
    });
  });

  it("reports ownerUnknown: 0 when the node named an owner for every badge", async () => {
    const g = gateway();
    g.onRequest("nfts_by_issuer", {
      result: { nfts: [issuerNft({ owner: ALICE }), issuerNft({ nft_id: TOKEN_B, owner: ISSUER })] },
    });

    expect((await getRoster(g, EVENT_ID)).ownerUnknown).toBe(0);
  });

  it("reports owner and claimed as UNKNOWN when the node reports no owner", async () => {
    // A missing owner used to default to the issuer, which computed
    // claimed: false — reporting a possibly-claimed badge as definitely
    // unclaimed. Unknown is its own state.
    const g = gateway();
    g.onRequest("nfts_by_issuer", {
      result: { nfts: [issuerNft({ owner: undefined, nft_serial: 17 })] },
    });

    const [entry] = (await getRoster(g, EVENT_ID)).entries;

    expect(entry!.owner).toBeUndefined();
    expect(entry!.claimed).toBeUndefined();
    // Neither key is present at all — and in particular claimed is not false.
    expect(entry).toEqual({
      nftokenId: TOKEN_A,
      isBurned: false,
      taxon: EVENT_ID,
      serial: 17,
      uri: URI,
    });
  });

  it("treats an empty-string owner as unknown too", async () => {
    const g = gateway();
    g.onRequest("nfts_by_issuer", { result: { nfts: [issuerNft({ owner: "" })] } });

    const [entry] = (await getRoster(g, EVENT_ID)).entries;

    // "" must never reach the owner !== issuer comparison.
    expect(entry!.owner).toBeUndefined();
    expect(entry!.claimed).toBeUndefined();
  });

  it("does not count an unknown-ownership badge as unclaimed", async () => {
    const g = gateway();
    g.onRequest("nfts_by_issuer", {
      result: {
        nfts: [
          issuerNft({ nft_id: TOKEN_A, owner: ALICE }), // claimed
          issuerNft({ nft_id: TOKEN_B, owner: ISSUER }), // never picked up
          issuerNft({ nft_id: TOKEN_C, owner: undefined }), // unknown
          issuerNft({ nft_id: TOKEN_D, owner: undefined, is_burned: true }), // unknown
        ],
      },
    });

    const roster = await getRoster(g, EVENT_ID);

    expect(roster.entries.map((e) => e.claimed)).toEqual([true, false, undefined, undefined]);
    expect(roster.minted).toBe(4);
    // claimed counts only badges known to have left the issuer.
    expect(roster.claimed).toBe(1);
    expect(roster.burned).toBe(1);
    // ...and the unknowns are visible rather than buried in that count.
    expect(roster.ownerUnknown).toBe(2);
    // The documented arithmetic: only one badge is known to be unclaimed.
    expect(roster.minted - roster.claimed - roster.ownerUnknown).toBe(1);
  });

  it("reports a partial roster when maxPages cuts the walk short", async () => {
    const g = gateway();
    g.onRequest("nfts_by_issuer", { result: { nfts: [issuerNft()], marker: "M1" } });
    g.onRequest("nfts_by_issuer", { result: { nfts: [issuerNft({ nft_id: TOKEN_B })], marker: "M2" } });

    const roster = await getRoster(g, EVENT_ID, { maxPages: 2 });

    expect(g.requests).toHaveLength(2);
    expect(roster.entries).toHaveLength(2);
    // The caller can tell this is partial.
    expect(roster.marker).toBe("M2");
  });

  it("passes limit through and honours an issuerAddress override", async () => {
    const g = gateway();
    g.onRequest("nfts_by_issuer", { result: { nfts: [] } });

    const roster = await getRoster(g, EVENT_ID, { issuerAddress: BOB, limit: 50 });

    expect(g.lastRequest("nfts_by_issuer")).toEqual({
      command: "nfts_by_issuer",
      issuer: BOB,
      nft_taxon: EVENT_ID,
      limit: 50,
    });
    expect(roster.issuer).toBe(BOB);
  });

  it("stops instead of spinning when a node repeats the same marker", async () => {
    const g = gateway();
    // A single handler is reused, so this node hands back "STUCK" forever.
    g.onRequest("nfts_by_issuer", { result: { nfts: [issuerNft()], marker: "STUCK" } });

    const roster = await getRoster(g, EVENT_ID);

    expect(g.requests).toHaveLength(2);
    expect(roster.entries).toHaveLength(2);
  });

  it("turns unknownCmd into an error that names the Clio endpoints", async () => {
    // The default testnet endpoint is plain rippled and answers unknownCmd to
    // all three Clio methods. A bare "unknownCmd" at demo time is the failure
    // this codebase exists to avoid.
    const g = gateway();
    g.onRequest("nfts_by_issuer", rippledError("unknownCmd"));

    await expect(getRoster(g, EVENT_ID)).rejects.toMatchObject({
      code: "LEDGER_QUERY_FAILED",
      details: { kind: "clio_method_unavailable", method: "nfts_by_issuer" },
    });
    await expect(getRoster(g, EVENT_ID)).rejects.toThrow(
      /nfts_by_issuer.*Clio.*wss:\/\/clio\.altnet\.rippletest\.net:51233.*wss:\/\/xrplcluster\.com/s,
    );
  });

  it("rejects an event id outside the taxon range", async () => {
    await expect(getRoster(gateway(), 2_147_483_648)).rejects.toMatchObject({
      code: "INVALID_TAXON",
    });
  });
});

// ---------------------------------------------------------------------------
// getNftInfo
// ---------------------------------------------------------------------------

describe("getNftInfo", () => {
  it("maps the Clio response and normalises the id", async () => {
    const g = gateway();
    g.onRequest("nft_info", {
      result: {
        nft_id: TOKEN_A,
        owner: ALICE,
        is_burned: false,
        issuer: ISSUER,
        nft_taxon: EVENT_ID,
        nft_serial: 20_071_307,
        uri: URI_HEX,
        flags: 1,
      },
    });

    const info = await getNftInfo(g, TOKEN_A.toLowerCase());

    expect(g.lastRequest("nft_info")).toEqual({ command: "nft_info", nft_id: TOKEN_A });
    expect(info).toEqual({
      nftokenId: TOKEN_A,
      owner: ALICE,
      issuer: ISSUER,
      taxon: EVENT_ID,
      serial: 20_071_307,
      isBurned: false,
      uri: URI,
      flags: 1,
    });
  });

  it("still answers for a burned token, owner and taxon intact", async () => {
    // Measured: this is the query that keeps attendance provable after a burn.
    const g = gateway();
    g.onRequest("nft_info", {
      result: {
        nft_id: TOKEN_A,
        owner: ALICE,
        is_burned: true,
        issuer: ISSUER,
        nft_taxon: EVENT_ID,
        nft_serial: 1,
        uri: URI_HEX,
        flags: 1,
      },
    });

    const info = await getNftInfo(g, TOKEN_A);

    expect(info.isBurned).toBe(true);
    expect(info.owner).toBe(ALICE);
    expect(info.taxon).toBe(EVENT_ID);
  });

  it("reports a missing owner as undefined, never as the issuer", async () => {
    // NftInfo.owner is a required string, so there is nowhere to put "unknown"
    // and "" is that sentinel. Callers must map it to unknown — verifyClaim
    // does — and it must never be mistaken for an address.
    const g = gateway();
    g.onRequest("nft_info", {
      result: {
        nft_id: TOKEN_A,
        is_burned: true,
        issuer: ISSUER,
        nft_taxon: EVENT_ID,
        nft_serial: 1,
        flags: 1,
      },
    });

    const info = await getNftInfo(g, TOKEN_A);

    // Unknown is its own state. An empty string here would be a non-address
    // that reads as one; the issuer would be an outright wrong answer.
    expect(info.owner).toBeUndefined();
    expect(info.owner).not.toBe(ISSUER);
    expect(info.owner).not.toBe("");
  });

  it("throws NotFoundError on objectNotFound", async () => {
    const g = gateway();
    g.onRequest("nft_info", rippledError("objectNotFound"));

    await expect(getNftInfo(g, TOKEN_A)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("turns unknownCmd into an error that names the Clio endpoints", async () => {
    const g = gateway();
    g.onRequest("nft_info", rippledError("unknownCmd"));

    await expect(getNftInfo(g, TOKEN_A)).rejects.toThrow(
      /"nft_info" command is not available.*Clio.*wss:\/\/clio\.altnet\.rippletest\.net:51233.*wss:\/\/xrplcluster\.com/s,
    );
  });

  it("treats an inline error body the same as a thrown one", async () => {
    const g = gateway();
    g.onRequest("nft_info", { result: { error: "objectNotFound", status: "error" } });

    await expect(getNftInfo(g, TOKEN_A)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// getNftHistory
// ---------------------------------------------------------------------------

/** An nft_history element in the API v2 shape. */
function historyEntry(
  body: Record<string, any>,
  over: { hash?: string; ledgerIndex?: number; meta?: Record<string, any> } = {},
): Record<string, any> {
  return {
    tx_json: body,
    hash: over.hash ?? HASH(1),
    ledger_index: over.ledgerIndex ?? 9_318_000,
    close_time_iso: "2026-08-20T09:41:20Z",
    validated: true,
    meta: { TransactionResult: "tesSUCCESS", ...over.meta },
  };
}

describe("getNftHistory", () => {
  it("preserves the ledger's newest-first order, so the mint is last", async () => {
    // Measured order for a minted -> claimed -> burned badge.
    const g = gateway();
    g.onRequest("nft_history", {
      result: {
        nft_id: TOKEN_A,
        transactions: [
          historyEntry({ TransactionType: "NFTokenBurn", Account: ALICE, NFTokenID: TOKEN_A }, {
            hash: HASH(4),
            ledgerIndex: 9_318_400,
          }),
          historyEntry(
            { TransactionType: "NFTokenAcceptOffer", Account: ALICE, NFTokenSellOffer: OFFER_ID },
            {
              hash: HASH(3),
              ledgerIndex: 9_318_300,
              meta: {
                AffectedNodes: [
                  {
                    DeletedNode: {
                      LedgerEntryType: "NFTokenOffer",
                      LedgerIndex: OFFER_ID,
                      FinalFields: { Owner: ISSUER, NFTokenID: TOKEN_A },
                    },
                  },
                ],
              },
            },
          ),
          historyEntry(
            { TransactionType: "NFTokenCreateOffer", Account: ISSUER, NFTokenID: TOKEN_A },
            { hash: HASH(2), ledgerIndex: 9_318_200 },
          ),
          historyEntry({ TransactionType: "NFTokenMint", Account: ISSUER }, {
            hash: HASH(1),
            ledgerIndex: 9_318_100,
          }),
        ],
      },
    });

    const history = await getNftHistory(g, TOKEN_A);

    expect(history.map((h) => h.changeType)).toEqual([
      "burn",
      "transfer",
      "offer_created",
      "mint",
    ]);
    expect(history.at(-1)!.changeType).toBe("mint");
    expect(history[0]!.txHash).toBe(HASH(4));
    expect(history[0]!.ledgerIndex).toBe(9_318_400);
    expect(history[0]!.timestamp).toBe("2026-08-20T09:41:20Z");
  });

  it("names the buyer and seller of an accept from the deleted offer node", async () => {
    const g = gateway();
    g.onRequest("nft_history", {
      result: {
        transactions: [
          historyEntry(
            { TransactionType: "NFTokenAcceptOffer", Account: ALICE, NFTokenSellOffer: OFFER_ID },
            {
              meta: {
                AffectedNodes: [
                  {
                    DeletedNode: {
                      LedgerEntryType: "NFTokenOffer",
                      LedgerIndex: OFFER_ID,
                      FinalFields: { Owner: ISSUER, NFTokenID: TOKEN_A },
                    },
                  },
                ],
              },
            },
          ),
        ],
      },
    });

    const [entry] = await getNftHistory(g, TOKEN_A);

    // Accepting a sell offer makes the submitter the buyer.
    expect(entry).toMatchObject({ buyer: ALICE, seller: ISSUER, owner: ALICE });
  });

  it("reads the API v1 shape, where the transaction sits under tx", async () => {
    const g = gateway();
    g.onRequest("nft_history", {
      result: {
        transactions: [
          {
            tx: {
              TransactionType: "NFTokenMint",
              Account: ISSUER,
              hash: HASH(1),
              ledger_index: 9_318_100,
              date: 786_361_280,
            },
            meta: { TransactionResult: "tesSUCCESS" },
            validated: true,
          },
        ],
      },
    });

    const [entry] = await getNftHistory(g, TOKEN_A);

    expect(entry).toMatchObject({
      changeType: "mint",
      txHash: HASH(1),
      ledgerIndex: 9_318_100,
      owner: ISSUER,
      // Ripple-epoch dates are converted when close_time_iso is absent.
      timestamp: rippleTimeToISOTime(786_361_280),
    });
  });

  it("keeps only successful transactions", async () => {
    const g = gateway();
    g.onRequest("nft_history", {
      result: {
        transactions: [
          historyEntry({ TransactionType: "NFTokenBurn", Account: ALICE }, {
            meta: { TransactionResult: "tecNO_PERMISSION" },
          }),
          historyEntry({ TransactionType: "NFTokenMint", Account: ISSUER }),
        ],
      },
    });

    const history = await getNftHistory(g, TOKEN_A);

    expect(history).toHaveLength(1);
    expect(history[0]!.changeType).toBe("mint");
  });

  it("follows the marker across pages", async () => {
    const g = gateway();
    g.onRequest("nft_history", {
      result: {
        transactions: [historyEntry({ TransactionType: "NFTokenBurn", Account: ALICE })],
        marker: "H2",
      },
    });
    g.onRequest("nft_history", {
      result: {
        transactions: [historyEntry({ TransactionType: "NFTokenMint", Account: ISSUER })],
      },
    });

    const history = await getNftHistory(g, TOKEN_A);

    expect(g.requests).toHaveLength(2);
    expect(g.requests[1]!.payload).toMatchObject({ marker: "H2", nft_id: TOKEN_A });
    expect(history.map((h) => h.changeType)).toEqual(["burn", "mint"]);
  });

  it("throws NotFoundError on objectNotFound and the Clio error on unknownCmd", async () => {
    const missing = gateway();
    missing.onRequest("nft_history", rippledError("objectNotFound"));
    await expect(getNftHistory(missing, TOKEN_A)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const rippledOnly = gateway();
    rippledOnly.onRequest("nft_history", rippledError("unknownCmd"));
    await expect(getNftHistory(rippledOnly, TOKEN_A)).rejects.toThrow(
      /"nft_history" command is not available.*wss:\/\/clio\.altnet\.rippletest\.net:51233/s,
    );
  });
});

// ---------------------------------------------------------------------------
// getAccountNfts
// ---------------------------------------------------------------------------

/** account_nfts uses the canonical capitalised field names, not Clio's. */
function accountNft(over: Record<string, any> = {}): Record<string, any> {
  return {
    NFTokenID: TOKEN_A,
    URI: URI_HEX,
    Flags: 1,
    Issuer: ISSUER,
    NFTokenTaxon: EVENT_ID,
    nft_serial: 1,
    ...over,
  };
}

describe("getAccountNfts", () => {
  it("maps the capitalised field names and paginates — no Clio required", async () => {
    const g = gateway();
    g.onRequest("account_nfts", {
      result: { account: ALICE, account_nfts: [accountNft()], marker: "A2" },
    });
    g.onRequest("account_nfts", {
      result: {
        account: ALICE,
        account_nfts: [accountNft({ NFTokenID: TOKEN_B, nft_serial: 2 })],
      },
    });

    const nfts = await getAccountNfts(g, ALICE);

    expect(g.requests).toHaveLength(2);
    expect(g.requests[0]!.payload).toEqual({
      command: "account_nfts",
      account: ALICE,
      ledger_index: "validated",
    });
    expect(g.requests[1]!.payload).toMatchObject({ marker: "A2" });
    expect(nfts).toEqual([
      {
        nftokenId: TOKEN_A,
        owner: ALICE,
        issuer: ISSUER,
        taxon: EVENT_ID,
        serial: 1,
        isBurned: false,
        uri: URI,
        flags: 1,
      },
      {
        nftokenId: TOKEN_B,
        owner: ALICE,
        issuer: ISSUER,
        taxon: EVENT_ID,
        serial: 2,
        isBurned: false,
        uri: URI,
        flags: 1,
      },
    ]);
  });

  it("returns nothing for a burned badge — which is why it is not the attendance query", async () => {
    // The trap from docs/ground-truth.md: account_nfts drops to zero for an
    // attendee who demonstrably claimed, while nft_info still reports the
    // badge. Verification uses nft_info for exactly this reason.
    const g = gateway();
    g.onRequest("account_nfts", { result: { account: ALICE, account_nfts: [] } });
    g.onRequest("nft_info", {
      result: {
        nft_id: TOKEN_A,
        owner: ALICE,
        is_burned: true,
        issuer: ISSUER,
        nft_taxon: EVENT_ID,
        nft_serial: 1,
        flags: 1,
      },
    });

    expect(await getAccountNfts(g, ALICE)).toEqual([]);
    expect((await getNftInfo(g, TOKEN_A)).isBurned).toBe(true);
  });

  it("throws AccountNotFoundError for an unactivated wallet", async () => {
    const g = gateway();
    g.onRequest("account_nfts", rippledError("actNotFound"));

    await expect(getAccountNfts(g, ALICE)).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
      address: ALICE,
    });
  });
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

describe("unwrapResult", () => {
  it("unwraps the request envelope, passes a bare result through, and tolerates junk", () => {
    expect(unwrapResult({ id: 1, type: "response", result: { nfts: [] } })).toEqual({ nfts: [] });
    expect(unwrapResult({ nfts: [1] })).toEqual({ nfts: [1] });
    expect(unwrapResult(undefined)).toEqual({});
    expect(unwrapResult("nope")).toEqual({});
  });
});

describe("clioUnavailableError", () => {
  it("names the method, the code, and both working endpoints", () => {
    const err = clioUnavailableError("nft_info", rippledError("unknownCmd"));

    expect(err.code).toBe("LEDGER_QUERY_FAILED");
    expect(err.message).toContain("nft_info");
    expect(err.message).toContain("unknownCmd");
    expect(err.message).toContain(CLIO_ENDPOINTS.testnet);
    expect(err.message).toContain(CLIO_ENDPOINTS.mainnet);
    expect(err.details).toMatchObject({ kind: "clio_method_unavailable", method: "nft_info" });
  });

  it("pins the Clio endpoints", () => {
    expect(CLIO_ENDPOINTS).toEqual({
      testnet: "wss://clio.altnet.rippletest.net:51233",
      mainnet: "wss://xrplcluster.com",
    });
  });
});
