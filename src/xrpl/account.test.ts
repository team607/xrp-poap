import { describe, expect, it } from "vitest";
import { MockGateway, rippledError } from "../../test/helpers/mock-gateway.js";
import { AccountNotFoundError } from "../errors.js";
import { accountExists, getAccountBalanceXrp, readAccount } from "./account.js";

const ISSUER = "rBdhYBA2uaVYG7ia2yusmPu5qMS4hE6oQ";
const ATTENDEE = "rPeZcWESwr1Wy64tw6JdVqtKNjhuUzHK2i";

/** lsfRequireDestTag and lsfDepositAuth, as the ledger reports them. */
const REQUIRE_DEST_TAG = 0x00020000;
const DEPOSIT_AUTH = 0x01000000;

function gateway(): MockGateway {
  return new MockGateway({ issuerAddress: ISSUER });
}

function accountInfo(data: Record<string, unknown>): Record<string, unknown> {
  return { result: { account_data: data, validated: true } };
}

describe("accountExists", () => {
  it("is true when account_info resolves", async () => {
    const gw = gateway().onRequest("account_info", accountInfo({ Balance: "25000000" }));
    await expect(accountExists(gw, ATTENDEE)).resolves.toBe(true);
    expect(gw.lastRequest("account_info")?.account).toBe(ATTENDEE);
  });

  it("is false only for actNotFound", async () => {
    const gw = gateway().onRequest("account_info", rippledError("actNotFound"));
    await expect(accountExists(gw, ATTENDEE)).resolves.toBe(false);
  });

  it("rethrows any other rippled error rather than reporting 'does not exist'", async () => {
    const gw = gateway().onRequest("account_info", rippledError("tooBusy"));
    await expect(accountExists(gw, ATTENDEE)).rejects.toThrowError("tooBusy");
  });

  it("rethrows a transport failure", async () => {
    const gw = gateway().onRequest("account_info", new Error("WebSocket closed before a response was received"));
    await expect(accountExists(gw, ATTENDEE)).rejects.toThrowError("WebSocket closed");
  });
});

describe("getAccountBalanceXrp", () => {
  it("converts drops to a decimal XRP string", async () => {
    const gw = gateway().onRequest("account_info", accountInfo({ Balance: "25000000" }));
    await expect(getAccountBalanceXrp(gw, ATTENDEE)).resolves.toBe("25");
  });

  it("keeps the fractional part, exactly", async () => {
    const gw = gateway().onRequest("account_info", accountInfo({ Balance: "1500001" }));
    await expect(getAccountBalanceXrp(gw, ATTENDEE)).resolves.toBe("1.500001");
  });

  it("maps actNotFound onto AccountNotFoundError", async () => {
    const gw = gateway().onRequest("account_info", rippledError("actNotFound"));
    await expect(getAccountBalanceXrp(gw, ATTENDEE)).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it("throws when the node returns no Balance, or one that is not drops", async () => {
    for (const data of [{}, { Balance: "1.5" }, { Balance: 1500000 }]) {
      const gw = gateway().onRequest("account_info", accountInfo(data));
      await expect(getAccountBalanceXrp(gw, ATTENDEE)).rejects.toMatchObject({
        code: "LEDGER_QUERY_FAILED",
      });
    }
  });
});

describe("readAccount", () => {
  it("counts one owner reserve per object, and spendable is what is left", async () => {
    // A wallet holding its badge: base 1 + one NFTokenPage 0.2.
    const gw = gateway().onRequest(
      "account_info",
      accountInfo({ Balance: "6210000", OwnerCount: 1, Flags: 0 }),
    );

    await expect(readAccount(gw, ATTENDEE)).resolves.toEqual({
      address: ATTENDEE,
      activated: true,
      balanceXrp: "6.21",
      ownerCount: 1,
      reserveXrp: "1.2",
      spendableXrp: "5.01",
      requireDestTag: false,
      depositAuth: false,
    });
  });

  it("never reports a negative spendable balance", async () => {
    const gw = gateway().onRequest("account_info", accountInfo({ Balance: "1100000", OwnerCount: 3 }));
    const account = await readAccount(gw, ATTENDEE);
    expect(account.reserveXrp).toBe("1.6");
    expect(account.spendableXrp).toBe("0");
  });

  it("reads the two flags that make a payment bounce", async () => {
    const gw = gateway()
      .onRequest("account_info", accountInfo({ Balance: "50000000", Flags: REQUIRE_DEST_TAG }))
      .onRequest("account_info", accountInfo({ Balance: "50000000", Flags: DEPOSIT_AUTH | REQUIRE_DEST_TAG }));

    expect(await readAccount(gw, ATTENDEE)).toMatchObject({ requireDestTag: true, depositAuth: false });
    expect(await readAccount(gw, ATTENDEE)).toMatchObject({ requireDestTag: true, depositAuth: true });
  });

  it("answers for an account that does not exist instead of throwing", async () => {
    const gw = gateway().onRequest("account_info", rippledError("actNotFound"));
    await expect(readAccount(gw, ATTENDEE)).resolves.toEqual({
      address: ATTENDEE,
      activated: false,
      balanceXrp: "0",
      ownerCount: 0,
      reserveXrp: "0",
      spendableXrp: "0",
      requireDestTag: false,
      depositAuth: false,
    });
  });

  it("rethrows a real ledger failure", async () => {
    const gw = gateway().onRequest("account_info", rippledError("tooBusy"));
    await expect(readAccount(gw, ATTENDEE)).rejects.toThrowError("tooBusy");
  });
});
