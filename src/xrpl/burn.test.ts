import { Wallet } from "xrpl";
import { describe, expect, it } from "vitest";
import { MockGateway } from "../../test/helpers/mock-gateway.js";
import { burn } from "./burn.js";

const ISSUER = "rBdhYBA2uaVYG7ia2yusmPu5qMS4hE6oQ";
const ATTENDEE = "rPeZcWESwr1Wy64tw6JdVqtKNjhuUzHK2i";
const NFTOKEN_ID = "000800001234567890ABCDEF1234567890ABCDEF1234567800000001";

function gateway(): MockGateway {
  return new MockGateway({ issuerAddress: ISSUER }).onSubmit("NFTokenBurn", {
    hash: "BURNHASH",
    ledgerIndex: 90_300,
    fee: "12",
    meta: { TransactionResult: "tesSUCCESS" },
  });
}

function submittedTx(gw: MockGateway): Record<string, unknown> {
  const tx = gw.lastSubmit("NFTokenBurn");
  if (!tx) throw new Error("expected an NFTokenBurn to have been submitted");
  return tx;
}

describe("burn", () => {
  it("burns as the issuer with no Owner field when no owner is given", async () => {
    const gw = gateway();
    await burn(gw, { nftokenId: NFTOKEN_ID });

    const tx = submittedTx(gw);
    expect(tx.TransactionType).toBe("NFTokenBurn");
    expect(tx.Account).toBe(ISSUER);
    expect(tx.NFTokenID).toBe(NFTOKEN_ID);
    expect("Owner" in tx).toBe(false);
  });

  it("omits Owner when the owner is the signing account", async () => {
    const gw = gateway();
    await burn(gw, { nftokenId: NFTOKEN_ID, owner: ISSUER });

    // rippled rejects an Owner field that matches the submitter.
    expect("Owner" in submittedTx(gw)).toBe(false);
  });

  it("includes Owner when the issuer revokes somebody else's badge", async () => {
    const gw = gateway();
    await burn(gw, { nftokenId: NFTOKEN_ID, owner: ATTENDEE });

    const tx = submittedTx(gw);
    expect(tx.Account).toBe(ISSUER);
    // Only legal because tfBurnable was set at mint time.
    expect(tx.Owner).toBe(ATTENDEE);
  });

  it("signs as the supplied wallet and omits Owner for that wallet's own badge", async () => {
    const wallet = Wallet.generate();
    const gw = gateway();
    await burn(gw, { nftokenId: NFTOKEN_ID, owner: wallet.classicAddress, wallet });

    const tx = submittedTx(gw);
    expect(tx.Account).toBe(wallet.classicAddress);
    expect(tx.Account).not.toBe(ISSUER);
    expect("Owner" in tx).toBe(false);
    expect(gw.submits[0]?.options?.wallet).toBe(wallet);
  });

  it("passes no wallet option when burning as the default issuer signer", async () => {
    const gw = gateway();
    await burn(gw, { nftokenId: NFTOKEN_ID });
    expect(gw.submits[0]?.options?.wallet).toBeUndefined();
  });

  it("sets Owner when a wallet burns a badge held by someone else", async () => {
    const wallet = Wallet.generate();
    const gw = gateway();
    await burn(gw, { nftokenId: NFTOKEN_ID, owner: ATTENDEE, wallet });

    const tx = submittedTx(gw);
    expect(tx.Account).toBe(wallet.classicAddress);
    expect(tx.Owner).toBe(ATTENDEE);
  });

  it("rejects an invalid owner address", async () => {
    const gw = gateway();
    await expect(
      burn(gw, { nftokenId: NFTOKEN_ID, owner: "rNotAnAddress" }),
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
    expect(gw.submits).toHaveLength(0);
  });

  it("returns the BurnResult from the outcome", async () => {
    const gw = gateway();
    await expect(burn(gw, { nftokenId: NFTOKEN_ID })).resolves.toEqual({
      nftokenId: NFTOKEN_ID,
      txHash: "BURNHASH",
      ledgerIndex: 90_300,
      fee: "12",
    });
  });
});
