/**
 * Wallet sponsorship — brief section 5.4.
 *
 * A brand new address does not exist on the ledger and cannot receive an NFT,
 * so we optionally fund it before creating the claim offer.
 *
 * ┌─ READ THIS BEFORE EXPOSING sponsorWallet() OVER HTTP ────────────────────┐
 * │ This is the only code path that moves real XRP out of the issuer's       │
 * │ control, and it does so on behalf of an arbitrary caller-supplied        │
 * │ address. Unguarded, anyone who can reach it drains the issuer            │
 * │ SPONSOR_AMOUNT_XRP at a time, in a loop, from newly generated addresses. │
 * │ Two guards are mandatory and both live here: one sponsorship per address │
 * │ per event, and a hard cap on total XRP sponsored per UTC day. Both need  │
 * │ a SponsorLedger — with no ledger passed there is NO duplicate check and  │
 * │ NO daily cap, which is acceptable in a script and never in an API route. │
 * │ Rate limiting on top of this is still the caller's job.                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * AND THE ORDER OF OPERATIONS IS PART OF THE GUARD. Both guards used to be
 * reads taken before the Payment, with the row written after it. Concurrent
 * callers therefore all read the same pre-payment state, all passed, and all
 * paid: five simultaneous claims for one new address sent five Payments and
 * recorded one row, and twenty for distinct addresses against a 3 XRP cap sent
 * 30 XRP. The reservation below is booked BEFORE the Payment for that reason.
 * Nothing may be inserted between reserve() and submit().
 */
import { dropsToXrp, xrpToDrops, type Payment } from "xrpl";
import type { SponsorConfig } from "../config.js";
import {
  AccountNotFoundError,
  SponsorshipDeniedError,
  XrplLayerError,
} from "../errors.js";
import type {
  EventId,
  SponsorLedger,
  SponsorReservation,
  SponsorResult,
  SubmitOutcome,
  XrplGateway,
} from "../types.js";
import { isRippledError } from "./client.js";
import { assertValidAddress } from "./encoding.js";
import { canReceiveBadge } from "./reserve.js";

/**
 * True when the address is activated on the ledger.
 *
 * Returns false for `actNotFound` and only for `actNotFound`. Every other
 * failure — a dropped socket, a rate limit, a node with no history — is
 * rethrown: swallowing one would report a funded account as missing and
 * sponsor it a second time.
 */
export async function accountExists(
  gateway: XrplGateway,
  address: string,
): Promise<boolean> {
  try {
    await gateway.request({
      command: "account_info",
      account: address,
      ledger_index: "validated",
    });
    return true;
  } catch (err) {
    if (isRippledError(err, "actNotFound")) return false;
    throw err;
  }
}

/** Current balance as a decimal XRP string. Throws if the account is unactivated. */
export async function getAccountBalanceXrp(
  gateway: XrplGateway,
  address: string,
): Promise<string> {
  let response: { result?: { account_data?: { Balance?: string } } };
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

  const drops = response?.result?.account_data?.Balance;
  if (typeof drops !== "string") {
    throw new XrplLayerError(
      "LEDGER_QUERY_FAILED",
      `account_info for ${address} returned no account_data.Balance`,
      { address },
    );
  }
  return String(dropsToXrp(drops));
}

/**
 * Turns a refused reservation into the right denial.
 *
 * reserve() answers null, not a reason — deliberately, because working the
 * reason out costs two reads that only the denial path should pay for. The
 * order matters: an address that already holds a slot is a duplicate even when
 * the cap is also exhausted, because that is the answer that stays true on a
 * retry tomorrow.
 */
async function denialFor(
  ledger: SponsorLedger,
  eventId: EventId,
  address: string,
  config: SponsorConfig,
): Promise<SponsorshipDeniedError> {
  if (await ledger.hasSponsored(eventId, address)) {
    return new SponsorshipDeniedError(
      `${address} was already sponsored for event ${eventId}`,
      "duplicate",
      { address, eventId },
    );
  }

  const spentTodayXrp = await ledger.sponsoredTodayXrp();
  return new SponsorshipDeniedError(
    `Daily sponsorship cap of ${config.dailyCapXrp} XRP would be exceeded: ` +
      `${spentTodayXrp} XRP already sponsored today plus ${config.amountXrp} XRP.`,
    "daily_cap",
    {
      address,
      eventId,
      amountXrp: config.amountXrp,
      dailyCapXrp: config.dailyCapXrp,
      spentTodayXrp,
    },
  );
}

/**
 * Funds an unactivated attendee wallet so it can receive a badge.
 *
 * Order of operations, and every step of it is load-bearing:
 *
 *   1. validate the address        — no round trip for a typo
 *   2. refuse if disabled          — no round trip at all
 *   3. canReceiveBadge(balance)    — a wallet that can already take a badge
 *                                    needs nothing. NOT merely "exists": an
 *                                    account under base + owner reserve cannot
 *                                    accept an NFT either.
 *   4. ledger.reserve()            — BOOKS THE SPEND. Atomic, cap included.
 *   5. gateway.submit(Payment)     — money moves only after step 4 committed
 *   6. ledger.confirm()            — attach the hash
 *   6'. ledger.release() on throw  — a Payment that never landed frees the slot
 *
 * Steps 4 and 5 cannot be swapped and nothing may be inserted between them.
 * Check-then-pay-then-record loses every race; reserve-then-pay loses none,
 * because a lost race costs cap headroom rather than XRP.
 *
 * Cap arithmetic lives in the ledger and is done in integer drops as BigInt —
 * never in floats, where 0.1 + 0.2 quietly buys you an extra sponsorship.
 *
 * @param params.ledger Optional, and omitting it is a decision about money.
 *   WITHOUT A LEDGER THIS FUNCTION IS UNGUARDED: no duplicate check, no daily
 *   cap, no reservation — every call pays. That is fine for a testnet script
 *   holding faucet XRP, and it must never be done with a funded issuer or on
 *   any path an untrusted caller can reach.
 */
export async function sponsorWallet(
  gateway: XrplGateway,
  params: {
    address: string;
    eventId: EventId;
    config: SponsorConfig;
    ledger?: SponsorLedger;
  },
): Promise<SponsorResult> {
  const { address, eventId, config, ledger } = params;

  assertValidAddress(address, "address");

  if (!config.enabled) {
    throw new SponsorshipDeniedError(
      "Sponsorship is disabled (SPONSOR_ENABLED=false)",
      "disabled",
      { address, eventId },
    );
  }

  // CAN IT RECEIVE A BADGE, not does it exist.
  //
  // This was `accountExists()`, and the gap between the two questions is a
  // whole failure mode: accepting an NFT creates an NFTokenPage, which locks
  // owner reserve, so a wallet holding less than base + one owner reserve
  // refuses the accept even though the account is perfectly real. The desk
  // said "ready", the badge was minted, 0.2 XRP of issuer reserve went into an
  // offer nobody could take, and the attendee got "not enough balance" from
  // Xaman with no way for a volunteer to help.
  //
  // A dust balance is MORE common than an empty account — it belongs to someone
  // who has used XRP before, and is therefore least likely to expect this.
  //
  // `alreadyActivated` keeps its name and widens its meaning to "needed
  // nothing". Renaming it would churn the desk page, the demo routes and their
  // tests to say the same thing.
  let balanceXrp = "0";
  try {
    balanceXrp = await getAccountBalanceXrp(gateway, address);
  } catch (err) {
    // Unfunded is the ordinary case here, not an error: "0" is the truth about
    // an account that does not exist, and it is exactly what the shortfall
    // arithmetic below expects.
    if (!(err instanceof AccountNotFoundError)) throw err;
  }

  if (canReceiveBadge(balanceXrp)) {
    return { sponsored: false, alreadyActivated: true, address };
  }

  let reservation: SponsorReservation | null = null;
  if (ledger) {
    reservation = await ledger.reserve({
      eventId,
      address,
      amountXrp: config.amountXrp,
      dailyCapXrp: config.dailyCapXrp,
    });
    if (!reservation) throw await denialFor(ledger, eventId, address, config);
  }

  const amountDrops = BigInt(xrpToDrops(config.amountXrp));
  const tx: Payment = {
    TransactionType: "Payment",
    Account: gateway.issuerAddress,
    Destination: address,
    Amount: amountDrops.toString(),
  };

  let outcome: SubmitOutcome;
  try {
    outcome = await gateway.submit(tx);
  } catch (err) {
    // The Payment did not land, so the booking must go back. A reservation
    // leaked here would block this attendee from ever being sponsored for this
    // event and would hold cap headroom against a spend that never happened.
    if (ledger && reservation) {
      try {
        await ledger.release(reservation.id);
      } catch {
        // The submit failure is the cause worth surfacing; a release that also
        // fails leaves a reservation blocking one attendee, which is the safe
        // direction to fail in. Never let it mask the original error.
      }
    }
    throw err;
  }

  // Past this point the money has moved. Do NOT release: a confirm that fails
  // is an accounting problem, and deleting the row would turn it into a hole in
  // the daily cap as well.
  if (ledger && reservation) await ledger.confirm(reservation.id, outcome.hash);

  return {
    sponsored: true,
    alreadyActivated: false,
    address,
    amountXrp: config.amountXrp,
    txHash: outcome.hash,
    ledgerIndex: outcome.ledgerIndex,
  };
}
