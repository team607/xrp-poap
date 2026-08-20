import { convertHexToString, convertStringToHex, NFTokenMintFlags } from "xrpl";
import { describe, expect, it } from "vitest";
import { MockGateway } from "../../test/helpers/mock-gateway.js";
import { XrplLayerError } from "../errors.js";
import { MAX_TAXON, MAX_URI_BYTES, type SubmitOutcome } from "../types.js";
import { mint, mintBatch } from "./mint.js";

const ISSUER = "rBdhYBA2uaVYG7ia2yusmPu5qMS4hE6oQ";
const URI = "ipfs://bafybeigdyrztbadge/metadata.json";
const NFTOKEN_ID = "000800001234567890ABCDEF1234567890ABCDEF1234567800000001";
const EVENT_ID = 7331;

function gateway(): MockGateway {
  return new MockGateway({ issuerAddress: ISSUER });
}

/** Queue one successful NFTokenMint outcome. */
function queueMint(gw: MockGateway, nftokenId = NFTOKEN_ID, hash = "MINTHASH"): MockGateway {
  return gw.onSubmit("NFTokenMint", {
    hash,
    ledgerIndex: 90_210,
    fee: "12",
    meta: { nftoken_id: nftokenId, TransactionResult: "tesSUCCESS" },
  });
}

function submittedTx(gw: MockGateway, type: string): Record<string, unknown> {
  const tx = gw.lastSubmit(type);
  if (!tx) throw new Error(`expected a ${type} to have been submitted`);
  return tx;
}

describe("mint", () => {
  it("sets Flags to exactly tfBurnable and leaves the badge soulbound", async () => {
    const gw = queueMint(gateway());
    await mint(gw, { eventId: EVENT_ID, uri: URI });

    const tx = submittedTx(gw, "NFTokenMint");

    // The literal value the ledger sees...
    expect(tx.Flags).toBe(1);
    // ...and the fact that it came from NFTokenMint's own enum, not a magic number.
    expect(tx.Flags).toBe(NFTokenMintFlags.tfBurnable);
    expect(NFTokenMintFlags.tfBurnable).toBe(1);

    // Soulbound: tfTransferable (8) must never be mixed in. Never 9, never 11.
    expect((tx.Flags as number) & NFTokenMintFlags.tfTransferable).toBe(0);
    expect(tx.Flags).not.toBe(9);
    expect(tx.Flags).not.toBe(11);
  });

  it("never emits a TransferFee field at all", async () => {
    const gw = queueMint(gateway());
    await mint(gw, { eventId: EVENT_ID, uri: URI });

    const tx = submittedTx(gw, "NFTokenMint");
    // Not 0, not undefined — the key must be absent, or rippled rejects the tx
    // because tfTransferable is unset.
    expect("TransferFee" in tx).toBe(false);
    expect(Object.keys(tx)).not.toContain("TransferFee");
  });

  it("hex-encodes the URI", async () => {
    const gw = queueMint(gateway());
    await mint(gw, { eventId: EVENT_ID, uri: URI });

    const tx = submittedTx(gw, "NFTokenMint");
    expect(tx.URI).toBe(convertStringToHex(URI));
    expect(tx.URI).not.toBe(URI);
    expect(tx.URI as string).toMatch(/^[0-9A-F]+$/);
    expect(convertHexToString(tx.URI as string)).toBe(URI);
  });

  it("mints from the issuer with the event id as the taxon", async () => {
    const gw = queueMint(gateway());
    await mint(gw, { eventId: EVENT_ID, uri: URI });

    const tx = submittedTx(gw, "NFTokenMint");
    expect(tx.TransactionType).toBe("NFTokenMint");
    expect(tx.Account).toBe(ISSUER);
    expect(tx.NFTokenTaxon).toBe(EVENT_ID);
  });

  it("rejects a 257-byte URI before submitting anything", async () => {
    const gw = queueMint(gateway());
    const tooLong = "i".repeat(MAX_URI_BYTES + 1);
    expect(Buffer.byteLength(tooLong, "utf8")).toBe(257);

    await expect(mint(gw, { eventId: EVENT_ID, uri: tooLong })).rejects.toMatchObject({
      code: "URI_TOO_LONG",
    });
    expect(gw.submits).toHaveLength(0);
  });

  it("accepts a URI of exactly 256 bytes", async () => {
    const gw = queueMint(gateway());
    const exact = "i".repeat(MAX_URI_BYTES);

    await expect(mint(gw, { eventId: EVENT_ID, uri: exact })).resolves.toMatchObject({
      nftokenId: NFTOKEN_ID,
    });
  });

  it("rejects a taxon at the reserved boundary 2147483648", async () => {
    const gw = queueMint(gateway());

    await expect(mint(gw, { eventId: 2_147_483_648, uri: URI })).rejects.toMatchObject({
      code: "INVALID_TAXON",
    });
    expect(gw.submits).toHaveLength(0);
  });

  it("accepts the highest legal taxon", async () => {
    const gw = queueMint(gateway());
    await mint(gw, { eventId: MAX_TAXON, uri: URI });
    expect(submittedTx(gw, "NFTokenMint").NFTokenTaxon).toBe(2_147_483_647);
  });

  it("validates the taxon before the URI", async () => {
    const gw = queueMint(gateway());
    // Both are invalid; the taxon check must be the one that fires.
    await expect(
      mint(gw, { eventId: 2_147_483_648, uri: "i".repeat(MAX_URI_BYTES + 1) }),
    ).rejects.toMatchObject({ code: "INVALID_TAXON" });
  });

  it("reads nftoken_id out of metadata, not the top level of the result", async () => {
    const gw = gateway().onSubmit("NFTokenMint", {
      hash: "MINTHASH",
      ledgerIndex: 90_210,
      fee: "12",
      meta: { nftoken_id: NFTOKEN_ID, TransactionResult: "tesSUCCESS" },
      // A decoy where a careless implementation would look first.
      nftoken_id: "DECOY_TOP_LEVEL_ID",
    } as unknown as Partial<SubmitOutcome>);

    const result = await mint(gw, { eventId: EVENT_ID, uri: URI });
    expect(result.nftokenId).toBe(NFTOKEN_ID);
    expect(result.nftokenId).not.toBe("DECOY_TOP_LEVEL_ID");
  });

  it("throws when the node returns no nftoken_id in metadata", async () => {
    const gw = gateway().onSubmit("NFTokenMint", {
      hash: "MINTHASH",
      meta: { TransactionResult: "tesSUCCESS" },
    });

    await expect(mint(gw, { eventId: EVENT_ID, uri: URI })).rejects.toBeInstanceOf(
      XrplLayerError,
    );
  });

  it("returns the whole MintResult from the outcome", async () => {
    const gw = queueMint(gateway(), NFTOKEN_ID, "ABC123");
    await expect(mint(gw, { eventId: EVENT_ID, uri: URI })).resolves.toEqual({
      nftokenId: NFTOKEN_ID,
      eventId: EVENT_ID,
      uri: URI,
      txHash: "ABC123",
      ledgerIndex: 90_210,
      fee: "12",
    });
  });
});

describe("mintBatch", () => {
  it("mints serially and returns results in input order", async () => {
    const gw = gateway();
    for (const id of ["NFT_A", "NFT_B", "NFT_C"]) {
      gw.onSubmit("NFTokenMint", {
        hash: `HASH_${id}`,
        ledgerIndex: 1,
        fee: "12",
        meta: { nftoken_id: id },
      });
    }

    const results = await mintBatch(gw, [
      { eventId: EVENT_ID, uri: "ipfs://a" },
      { eventId: EVENT_ID, uri: "ipfs://b" },
      { eventId: EVENT_ID, uri: "ipfs://c" },
    ]);

    expect(results.map((r) => r.nftokenId)).toEqual(["NFT_A", "NFT_B", "NFT_C"]);
    expect(results.map((r) => r.uri)).toEqual(["ipfs://a", "ipfs://b", "ipfs://c"]);
    expect(gw.submits).toHaveLength(3);
  });

  it("stops at the first failure and reports the mints already completed", async () => {
    const gw = gateway();
    gw.onSubmit("NFTokenMint", {
      hash: "HASH_A",
      ledgerIndex: 1,
      fee: "12",
      meta: { nftoken_id: "NFT_A" },
    });
    gw.onSubmit("NFTokenMint", new Error("tefPAST_SEQ"));
    gw.onSubmit("NFTokenMint", {
      hash: "HASH_C",
      ledgerIndex: 1,
      fee: "12",
      meta: { nftoken_id: "NFT_C" },
    });

    const inputs = [
      { eventId: EVENT_ID, uri: "ipfs://a" },
      { eventId: EVENT_ID, uri: "ipfs://b" },
      { eventId: EVENT_ID, uri: "ipfs://c" },
    ];

    const err = await mintBatch(gw, inputs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XrplLayerError);
    const failure = err as XrplLayerError;
    expect(failure.code).toBe("TX_FAILED");
    expect(failure.details?.failedIndex).toBe(1);
    expect(failure.details?.failedInput).toEqual(inputs[1]);

    const completed = failure.details?.completed as Array<{ nftokenId: string }>;
    expect(completed).toHaveLength(1);
    expect(completed[0]?.nftokenId).toBe("NFT_A");

    // Serial: the third mint was never attempted.
    expect(gw.submits).toHaveLength(2);
  });

  it("returns an empty array for no inputs and never touches the ledger", async () => {
    const gw = gateway();
    await expect(mintBatch(gw, [])).resolves.toEqual([]);
    expect(gw.submits).toHaveLength(0);
  });
});
