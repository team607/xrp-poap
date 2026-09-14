/**
 * Reading an account off the ledger: does it exist, what does it hold, and how
 * much of that can it actually send.
 *
 * "Holds" and "can send" are different numbers, and the gap between them is
 * the reserve: one base reserve for existing at all, plus an owner reserve for
 * every object the account owns (an NFTokenPage holding a badge is one). A
 * Payment may never take an account below that, so the number a store has to
 * grey items out by is the spendable one.
 */
import { LedgerEntry } from "xrpl";
import { AccountNotFoundError, XrplLayerError } from "../errors.js";
import { dropsToXrpString, maxDrops, xrpToDropsBigInt } from "../money.js";
import type { XrplGateway } from "../types.js";
import { isRippledError } from "./client.js";
import { BASE_RESERVE_XRP, OWNER_RESERVE_PER_OBJECT_XRP } from "./reserve.js";

/**
 * True when the address is activated on the ledger.
 *
 * Returns false for `actNotFound` and only for `actNotFound`. Every other
 * failure — a dropped socket, a rate limit, a node with no history — is
 * rethrown: swallowing one would report a funded account as missing and pay
 * it a second time.
 */
export async function accountExists(gateway: XrplGateway, address: string): Promise<boolean> {
  try {
    await gateway.request({ command: "account_info", account: address, ledger_index: "validated" });
    return true;
  } catch (err) {
    if (isRippledError(err, "actNotFound")) return false;
    throw err;
  }
}

interface AccountData {
  Balance?: unknown;
  OwnerCount?: unknown;
  Flags?: unknown;
}

async function accountData(gateway: XrplGateway, address: string): Promise<AccountData> {
  let response: { result?: { account_data?: AccountData } };
  try {
    response = await gateway.request({
      command: "account_info",
      account: address,
      ledger_index: "validated",
    });
  } catch (err) {
    if (isRippledError(err, "actNotFound")) throw new AccountNotFoundError(address);
    throw err;
  }
  const data = response?.result?.account_data;
  if (!data || typeof data.Balance !== "string" || !/^\d+$/.test(data.Balance)) {
    throw new XrplLayerError(
      "LEDGER_QUERY_FAILED",
      `account_info for ${address} returned no account_data.Balance`,
      { address },
    );
  }
  return data;
}

/** Current balance as a decimal XRP string. Throws if the account is unactivated. */
export async function getAccountBalanceXrp(gateway: XrplGateway, address: string): Promise<string> {
  const data = await accountData(gateway, address);
  return dropsToXrpString(BigInt(data.Balance as string));
}

export interface AccountSnapshot {
  address: string;
  activated: boolean;
  balanceXrp: string;
  ownerCount: number;
  /** Base reserve plus one owner reserve per object the account owns. */
  reserveXrp: string;
  /** What a Payment from this account can send: balance minus reserve, never negative. */
  spendableXrp: string;
  /** lsfRequireDestTag: a payment without a destination tag bounces. */
  requireDestTag: boolean;
  /** lsfDepositAuth: a payment from anyone it has not authorised bounces. */
  depositAuth: boolean;
}

/**
 * Everything a payment decision needs about one account, from one read. An
 * account that does not exist is an answer — all zeros, `activated: false` —
 * not an error.
 */
export async function readAccount(gateway: XrplGateway, address: string): Promise<AccountSnapshot> {
  let data: AccountData;
  try {
    data = await accountData(gateway, address);
  } catch (err) {
    if (!(err instanceof AccountNotFoundError)) throw err;
    return {
      address,
      activated: false,
      balanceXrp: "0",
      ownerCount: 0,
      reserveXrp: "0",
      spendableXrp: "0",
      requireDestTag: false,
      depositAuth: false,
    };
  }

  const balance = BigInt(data.Balance as string);
  const ownerCount =
    typeof data.OwnerCount === "number" && Number.isInteger(data.OwnerCount) && data.OwnerCount >= 0
      ? data.OwnerCount
      : 0;
  const flags = typeof data.Flags === "number" ? data.Flags : 0;
  const reserve =
    xrpToDropsBigInt(BASE_RESERVE_XRP) +
    BigInt(ownerCount) * xrpToDropsBigInt(OWNER_RESERVE_PER_OBJECT_XRP);

  return {
    address,
    activated: true,
    balanceXrp: dropsToXrpString(balance),
    ownerCount,
    reserveXrp: dropsToXrpString(reserve),
    spendableXrp: dropsToXrpString(maxDrops(0n, balance - reserve)),
    requireDestTag: (flags & LedgerEntry.AccountRootFlags.lsfRequireDestTag) !== 0,
    depositAuth: (flags & LedgerEntry.AccountRootFlags.lsfDepositAuth) !== 0,
  };
}
