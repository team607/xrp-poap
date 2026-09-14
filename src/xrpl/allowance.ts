/**
 * Paying an attendee's allowance from their event's treasury.
 *
 * ┌─ READ THIS BEFORE CALLING payAllowance() FROM ANYWHERE NEW ──────────────┐
 * │ This moves real XRP out of an event's treasury to an address a caller    │
 * │ names. Three guards stand between that and an empty treasury, and every  │
 * │ one of them lives here or in the ledger it is handed:                    │
 * │                                                                          │
 * │   once per attendee   the ledger's UNIQUE (event, address)               │
 * │   the event budget    the ledger's atomic SUM, reserved rows included    │
 * │   the ceiling         REWARD_MAX_PER_ATTENDEE_XRP, checked before booking│
 * │                                                                          │
 * │ There is no way to call this without a ledger. Rate limiting and the     │
 * │ admin session on top are still the caller's job.                         │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * WHAT GETS PAID. The allowance is what the attendee can SPEND, so the server
 * adds what stands between a wallet and spending it: whatever the wallet is
 * short of the reserve a badge needs, plus a small buffer so transaction fees
 * never eat into the allowance. A fresh wallet at an event with a 5 XRP
 * allowance is sent 5 + 1.2 + 0.01 and can spend exactly the 5 once its badge
 * has landed.
 *
 * THE ORDER IS PART OF THE GUARD, exactly as it was for sponsorship: the
 * payment is booked before it is submitted, and nothing may be inserted
 * between the booking and the submit.
 *
 * A PAYMENT WHOSE OUTCOME WAS LOST is not released. If the socket died after
 * the blob went out, the Payment may still validate, and releasing the booking
 * would let a retry pay the same attendee twice. The booking is kept; once it
 * is old enough that the transaction can no longer land, the next attempt looks
 * for it in the treasury's history by its memo, and records or releases it on
 * what it finds.
 */
import type { Payment, Wallet } from "xrpl";
import {
  AccountNotFoundError,
  AllowanceDeniedError,
  ConnectionError,
  TransactionFailedError,
  XrplLayerError,
} from "../errors.js";
import { dropsToXrpString, maxDrops, xrpToDropsBigInt } from "../money.js";
import type {
  AllowanceLedger,
  AllowanceRecord,
  AllowanceResult,
  EventId,
  SubmitOutcome,
  XrplGateway,
} from "../types.js";
import { getAccountBalanceXrp } from "./account.js";
import { isDisconnectedError, isRippledError } from "./client.js";
import { assertValidAddress } from "./encoding.js";
import { hasMemo, memo } from "./memos.js";
import { BASE_RESERVE_XRP, OWNER_RESERVE_PER_OBJECT_XRP } from "./reserve.js";
import { unwrapResult } from "./roster.js";

export const ALLOWANCE_MEMO_TYPE = "poap/allowance";

/**
 * How old a booking must be before its payment is presumed settled one way or
 * the other. A submitted transaction carries a LastLedgerSequence about twenty
 * ledgers out — well under two minutes — after which it can never validate.
 */
export const STALE_ALLOWANCE_MS = 3 * 60_000;

/** How much of a treasury's history to search for a lost payment. */
const HISTORY_LIMIT = 400;

export interface AllowanceQuote {
  allowanceXrp: string;
  /** shortfall + fee buffer, or "0" when nothing is owed at all. */
  topupXrp: string;
  amountXrp: string;
  /** What the wallet lacks of the reserve a badge needs. */
  shortfallXrp: string;
}

/**
 * What a wallet holding `balanceXrp` is owed. Pure, and the one place the sum
 * is done.
 *
 * Nothing is owed when there is no allowance and the wallet can already hold a
 * badge: sending a fee buffer on its own would be a payment of nothing.
 */
export function quoteAllowance(
  balanceXrp: string,
  opts: { allowanceXrp: string; feeBufferXrp: string },
): AllowanceQuote {
  const allowance = xrpToDropsBigInt(opts.allowanceXrp, "allowanceXrp");
  const buffer = xrpToDropsBigInt(opts.feeBufferXrp, "feeBufferXrp");
  const badgeReady = xrpToDropsBigInt(BASE_RESERVE_XRP) + xrpToDropsBigInt(OWNER_RESERVE_PER_OBJECT_XRP);
  const shortfall = maxDrops(0n, badgeReady - xrpToDropsBigInt(balanceXrp, "balanceXrp"));
  const topup = allowance > 0n || shortfall > 0n ? shortfall + buffer : 0n;

  return {
    allowanceXrp: dropsToXrpString(allowance),
    topupXrp: dropsToXrpString(topup),
    amountXrp: dropsToXrpString(allowance + topup),
    shortfallXrp: dropsToXrpString(shortfall),
  };
}

/** The treasury a payment comes from. */
export interface AllowanceTreasury {
  address: string;
  /** Decrypts the seed. Called once, immediately before booking. */
  open(): Wallet;
}

export interface PayAllowanceInput {
  eventId: EventId;
  address: string;
  /** The event's allowance, decimal XRP. */
  allowanceXrp: string;
  /** The event's budget, decimal XRP. */
  budgetXrp: string;
  feeBufferXrp: string;
  maxPerAttendeeXrp: string;
  /** Null when the event has no treasury this server can open. */
  treasury: AllowanceTreasury | null;
  ledger: AllowanceLedger;
  /** The wallet's balance, when the caller has just read it. Read fresh when absent. */
  balanceXrp?: string;
  /** Injectable so a test can age a booking without waiting three minutes. */
  now?: () => Date;
}

function resultFrom(row: AllowanceRecord, outcome: AllowanceResult["outcome"]): AllowanceResult {
  return {
    outcome,
    eventId: row.eventId,
    address: row.address,
    allowanceXrp: row.allowanceXrp,
    topupXrp: row.topupXrp,
    amountXrp: row.amountXrp,
    ...(row.txHash ? { txHash: row.txHash } : {}),
  };
}

/**
 * True when a submit failed in a way that leaves the Payment's fate unknown.
 *
 * The ledger answering with a result code is not that: tec, tef and tem are
 * all "this did not move the money", so the booking can go back. A connection
 * that died, or a request that timed out, may have happened after the signed
 * blob reached a node — and then the Payment can still validate.
 */
export function isAmbiguousSubmitFailure(err: unknown): boolean {
  if (err instanceof TransactionFailedError) return false;
  if (err instanceof ConnectionError) return true;
  if (isDisconnectedError(err)) return true;
  return (err as { name?: unknown } | null)?.name === "TimeoutError";
}

/**
 * Look for the Payment that settled `reservationId`, in the treasury's own
 * history. A hint, found by its memo, and only ever a validated, successful
 * Payment from that treasury to that attendee.
 */
export async function findAllowancePayment(
  gateway: XrplGateway,
  input: { treasuryAddress: string; destination: string; eventId: EventId; reservationId: string },
): Promise<{ txHash: string } | undefined> {
  let result: Record<string, any>;
  try {
    result = unwrapResult(
      await gateway.request({
        command: "account_tx",
        account: input.treasuryAddress,
        ledger_index_min: -1,
        ledger_index_max: -1,
        limit: HISTORY_LIMIT,
        forward: false,
      }),
    );
  } catch (err) {
    // A treasury nobody has funded has no history, so it paid nobody.
    if (isRippledError(err, "actNotFound")) return undefined;
    throw new XrplLayerError(
      "LEDGER_QUERY_FAILED",
      `account_tx for treasury ${input.treasuryAddress} failed: ${err instanceof Error ? err.message : String(err)}`,
      { method: "account_tx", address: input.treasuryAddress },
    );
  }

  const wanted = `${input.eventId}:${input.reservationId}`;
  const entries: Record<string, any>[] = Array.isArray(result.transactions) ? result.transactions : [];

  for (const entry of entries) {
    const body: Record<string, any> = entry.tx_json ?? entry.tx ?? {};
    if (body.TransactionType !== "Payment") continue;
    if (body.Account !== input.treasuryAddress || body.Destination !== input.destination) continue;
    if (entry.validated === false) continue;
    const meta = entry.meta ?? entry.metaData;
    if (!meta || typeof meta !== "object" || meta.TransactionResult !== "tesSUCCESS") continue;
    if (!hasMemo(body, ALLOWANCE_MEMO_TYPE, wanted)) continue;

    const hash = typeof entry.hash === "string" ? entry.hash : body.hash;
    if (typeof hash === "string" && /^[0-9A-Fa-f]{64}$/.test(hash)) return { txHash: hash.toUpperCase() };
  }
  return undefined;
}

async function readBalance(gateway: XrplGateway, address: string): Promise<string> {
  try {
    return await getAccountBalanceXrp(gateway, address);
  } catch (err) {
    // Unactivated is ordinary here: "0" is the truth about an account that
    // does not exist, and it is exactly what the shortfall arithmetic expects.
    if (err instanceof AccountNotFoundError) return "0";
    throw err;
  }
}

/**
 * A booking already exists and has not been confirmed. Either its payment is
 * still on its way — refuse, and let the caller ask again — or it is old enough
 * to have settled, in which case the treasury's history says how.
 */
async function settleBooking(
  gateway: XrplGateway,
  ledger: AllowanceLedger,
  row: AllowanceRecord,
  now: () => Date,
): Promise<AllowanceResult | undefined> {
  const age = now().getTime() - row.reservedAt.getTime();
  if (age < STALE_ALLOWANCE_MS) {
    throw new AllowanceDeniedError(
      `A payment to ${row.address} for event ${row.eventId} is already on its way. Check again in a moment.`,
      "in_flight",
      { eventId: row.eventId, address: row.address, amountXrp: row.amountXrp },
    );
  }

  const found = await findAllowancePayment(gateway, {
    treasuryAddress: row.treasuryAddress,
    destination: row.address,
    eventId: row.eventId,
    reservationId: row.id,
  });
  if (found) {
    await ledger.confirm(row.id, found.txHash);
    return resultFrom({ ...row, status: "confirmed", txHash: found.txHash }, "already_paid");
  }

  // It never landed, and now it never can. The booking goes back.
  await ledger.release(row.id);
  return undefined;
}

/**
 * A payment the treasury could not make because it holds too little, as a
 * refusal somebody can act on. The ledger says it two ways. A treasury nobody
 * has funded does not exist yet, so filling in the Payment fails with
 * actNotFound before anything is submitted; one that exists but holds too
 * little is refused with tecUNFUNDED_PAYMENT. Either way nothing moved. Null
 * for any other failure, which is passed on as it came.
 */
function treasuryShortfall(
  err: unknown,
  treasuryAddress: string,
  amountXrp: string,
  ids: { eventId: EventId; address: string },
): AllowanceDeniedError | null {
  if (isRippledError(err, "actNotFound")) {
    const neededXrp = dropsToXrpString(xrpToDropsBigInt(amountXrp) + xrpToDropsBigInt(BASE_RESERVE_XRP));
    return new AllowanceDeniedError(
      `This event's wallet ${treasuryAddress} has never been funded, so it cannot send XRP yet. Send it at ` +
        `least ${neededXrp} XRP (this payment and the ${BASE_RESERVE_XRP} XRP a wallet has to keep), then try again.`,
      "unfunded",
      { ...ids, treasuryAddress, amountXrp, neededXrp, reason: "treasury_not_activated" },
    );
  }
  if (err instanceof TransactionFailedError && err.engineResult === "tecUNFUNDED_PAYMENT") {
    return new AllowanceDeniedError(
      `This event's wallet ${treasuryAddress} does not have ${amountXrp} XRP to send. Top it up, then try again.`,
      "unfunded",
      { ...ids, treasuryAddress, amountXrp, reason: "treasury_short" },
    );
  }
  return null;
}

export async function payAllowance(
  gateway: XrplGateway,
  input: PayAllowanceInput,
): Promise<AllowanceResult> {
  const { eventId, address, ledger } = input;
  const now = input.now ?? (() => new Date());

  // 1. A typo costs no round trip.
  assertValidAddress(address, "address");

  // 2. Already on the books? Paying twice is answered with the first payment.
  const existing = await ledger.find(eventId, address);
  if (existing?.status === "confirmed") return resultFrom(existing, "already_paid");
  if (existing) {
    const settled = await settleBooking(gateway, ledger, existing, now);
    if (settled) return settled;
  }

  // 3. What this wallet is owed right now.
  const balanceXrp = input.balanceXrp ?? (await readBalance(gateway, address));
  const quote = quoteAllowance(balanceXrp, input);
  if (quote.amountXrp === "0") {
    return {
      outcome: "nothing_owed",
      eventId,
      address,
      allowanceXrp: quote.allowanceXrp,
      topupXrp: quote.topupXrp,
      amountXrp: quote.amountXrp,
    };
  }

  // 4. The server-wide ceiling, whatever the event says.
  const amountDrops = xrpToDropsBigInt(quote.amountXrp);
  if (amountDrops > xrpToDropsBigInt(input.maxPerAttendeeXrp, "maxPerAttendeeXrp")) {
    throw new AllowanceDeniedError(
      `Paying ${quote.amountXrp} XRP to ${address} would exceed this server's limit of ` +
        `${input.maxPerAttendeeXrp} XRP per attendee (REWARD_MAX_PER_ATTENDEE_XRP). Lower the event's ` +
        "allowance.",
      "ceiling",
      { eventId, address, amountXrp: quote.amountXrp, maxPerAttendeeXrp: input.maxPerAttendeeXrp },
    );
  }

  // 5. A treasury to pay from. Opened BEFORE booking, so a key problem books nothing.
  const treasury = input.treasury;
  if (!treasury) {
    throw new AllowanceDeniedError(
      `Event ${eventId} has no treasury this server can pay from. Set TREASURY_MASTER_KEY and ` +
        "restart, and the event is given one.",
      "unavailable",
      { eventId, address, reason: "no_treasury" },
    );
  }
  const wallet = treasury.open();

  // 6. BOOK IT. Atomic against the budget and against a second payment.
  const booking = await ledger.reserve({
    eventId,
    address,
    allowanceXrp: quote.allowanceXrp,
    topupXrp: quote.topupXrp,
    treasuryAddress: treasury.address,
    budgetXrp: input.budgetXrp,
  });

  if (!booking) {
    // Somebody else holds this attendee's row — a second desk, a double tap —
    // or the budget has no room. The row tells which.
    const raced = await ledger.find(eventId, address);
    if (raced?.status === "confirmed") return resultFrom(raced, "already_paid");
    if (raced) {
      throw new AllowanceDeniedError(
        `A payment to ${address} for event ${eventId} is already on its way. Check again in a moment.`,
        "in_flight",
        { eventId, address },
      );
    }
    const summary = await ledger.summary(eventId);
    throw new AllowanceDeniedError(
      `Event ${eventId}'s budget cannot cover this payment: ${summary.committedXrp} of ` +
        `${input.budgetXrp} XRP is already committed, and this attendee needs ${quote.amountXrp} XRP. ` +
        "Raise the budget in the console.",
      "budget",
      {
        eventId,
        address,
        amountXrp: quote.amountXrp,
        budgetXrp: input.budgetXrp,
        committedXrp: summary.committedXrp,
      },
    );
  }

  // 7. PAY. Nothing between the booking and this line.
  const payment: Payment = {
    TransactionType: "Payment",
    Account: treasury.address,
    Destination: address,
    Amount: amountDrops.toString(),
    Memos: [memo(ALLOWANCE_MEMO_TYPE, `${eventId}:${booking.id}`)],
  };

  let outcome: SubmitOutcome;
  try {
    outcome = await gateway.submit(payment, { wallet });
  } catch (err) {
    if (!isAmbiguousSubmitFailure(err)) {
      try {
        await ledger.release(booking.id);
      } catch {
        // The payment failure is the cause worth surfacing. A booking left
        // behind blocks one attendee until it goes stale, which is the safe
        // direction to fail in.
      }
    }
    throw treasuryShortfall(err, treasury.address, quote.amountXrp, { eventId, address }) ?? err;
  }

  // 8. RECORD. Past this point the money has moved: never release.
  await ledger.confirm(booking.id, outcome.hash);

  return {
    outcome: "paid",
    eventId,
    address,
    allowanceXrp: quote.allowanceXrp,
    topupXrp: quote.topupXrp,
    amountXrp: quote.amountXrp,
    txHash: outcome.hash,
    ledgerIndex: outcome.ledgerIndex,
  };
}
