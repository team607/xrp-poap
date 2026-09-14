/**
 * Sweeping a treasury. Every refusal here is one that, without it, would send
 * an organiser's leftover XRP somewhere it could not be got back from.
 */
import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { MockGateway, rippledError } from "../../test/helpers/mock-gateway.js";
import { readMemos } from "./memos.js";
import { SWEEP_MEMO_TYPE, sweepTreasury, type SweepInput } from "./treasury.js";

const ISSUER = "rBdhYBA2uaVYG7ia2yusmPu5qMS4hE6oQ";
const DESTINATION = "rPeZcWESwr1Wy64tw6JdVqtKNjhuUzHK2i";
const TREASURY = Wallet.generate();
const SWEEP_HASH = "CD".repeat(32);

const REQUIRE_DEST_TAG = 0x00020000;
const DEPOSIT_AUTH = 0x01000000;

/** account_info by account: absent means the account does not exist. */
function ledgerWith(accounts: Record<string, { Balance: string; OwnerCount?: number; Flags?: number }>) {
  return new MockGateway({ issuerAddress: ISSUER }).onRequest("account_info", (payload: Record<string, unknown>) => {
    const data = accounts[String(payload.account)];
    return data ? { result: { account_data: data } } : rippledError("actNotFound");
  });
}

function sweep(over: Partial<SweepInput> = {}, onOpen?: () => void): SweepInput {
  return {
    eventId: 700012,
    treasury: {
      address: TREASURY.classicAddress,
      open: () => {
        onOpen?.();
        return TREASURY;
      },
    },
    destination: DESTINATION,
    ...over,
  };
}

describe("sweepTreasury", () => {
  it("sends everything above the reserve, less a fee allowance, signed by the treasury", async () => {
    const gw = ledgerWith({
      [TREASURY.classicAddress]: { Balance: "50000000", OwnerCount: 0 },
      [DESTINATION]: { Balance: "10000000" },
    }).onSubmit("Payment", { hash: SWEEP_HASH, ledgerIndex: 9 });

    const result = await sweepTreasury(gw, sweep());

    // 50 held, 1 reserved, 0.001 kept for the fee.
    expect(result).toEqual({
      amountXrp: "48.999",
      destination: DESTINATION,
      txHash: SWEEP_HASH,
      ledgerIndex: 9,
    });
    const [sent] = gw.submits;
    expect(sent?.tx).toMatchObject({
      Account: TREASURY.classicAddress,
      Destination: DESTINATION,
      Amount: "48999000",
    });
    expect(sent?.tx.DestinationTag).toBeUndefined();
    expect(sent?.options?.wallet).toBe(TREASURY);
    expect(readMemos(sent?.tx ?? {})).toEqual([{ type: SWEEP_MEMO_TYPE, data: "700012" }]);
  });

  it("refuses an address that needs a destination tag until it is given one", async () => {
    const accounts = {
      [TREASURY.classicAddress]: { Balance: "50000000" },
      [DESTINATION]: { Balance: "10000000", Flags: REQUIRE_DEST_TAG },
    };
    let opened = 0;

    const refused = ledgerWith(accounts);
    await expect(sweepTreasury(refused, sweep({}, () => (opened += 1)))).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { requireDestTag: true },
    });
    expect(refused.submits).toHaveLength(0);
    expect(opened).toBe(0);

    const tagged = ledgerWith(accounts).onSubmit("Payment", { hash: SWEEP_HASH, ledgerIndex: 9 });
    const result = await sweepTreasury(tagged, sweep({ destinationTag: 123456 }));
    expect(result.destinationTag).toBe(123456);
    expect(tagged.submits[0]?.tx.DestinationTag).toBe(123456);
  });

  it("refuses a wallet that only takes payments it has authorised", async () => {
    const gw = ledgerWith({
      [TREASURY.classicAddress]: { Balance: "50000000" },
      [DESTINATION]: { Balance: "10000000", Flags: DEPOSIT_AUTH },
    });
    await expect(sweepTreasury(gw, sweep())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(gw.submits).toHaveLength(0);
  });

  it("refuses a treasury nobody funded, and one with nothing above its reserve", async () => {
    const unfunded = ledgerWith({ [DESTINATION]: { Balance: "10000000" } });
    await expect(sweepTreasury(unfunded, sweep())).rejects.toMatchObject({ code: "CONFLICT" });

    const bare = ledgerWith({
      [TREASURY.classicAddress]: { Balance: "1000500" },
      [DESTINATION]: { Balance: "10000000" },
    });
    await expect(sweepTreasury(bare, sweep())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(bare.submits).toHaveLength(0);
  });

  it("refuses to create a destination account with less than the base reserve", async () => {
    const small = ledgerWith({ [TREASURY.classicAddress]: { Balance: "1500000" } });
    await expect(sweepTreasury(small, sweep())).rejects.toMatchObject({ code: "CONFLICT" });

    // Enough to create it: allowed.
    const enough = ledgerWith({ [TREASURY.classicAddress]: { Balance: "3000000" } }).onSubmit("Payment", {
      hash: SWEEP_HASH,
      ledgerIndex: 9,
    });
    await expect(sweepTreasury(enough, sweep())).resolves.toMatchObject({ amountXrp: "1.999" });
  });

  it("refuses the treasury's own address and a destination that is not an address", async () => {
    const gw = ledgerWith({});
    await expect(sweepTreasury(gw, sweep({ destination: TREASURY.classicAddress }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(sweepTreasury(gw, sweep({ destination: "rNope" }))).rejects.toMatchObject({
      code: "INVALID_ADDRESS",
    });
    expect(gw.requests).toHaveLength(0);
  });
});
