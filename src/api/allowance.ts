/**
 * The HTTP layer's side of paying attendees.
 *
 * Every route that pays an allowance or reports on one — the claim, the desk,
 * the console — resolves the same three things first: which event, which
 * treasury, which server-wide limits. They are resolved here, once, so no two
 * routes can disagree about what an attendee is owed.
 */
import { AllowanceDeniedError } from "../errors.js";
import { dropsToXrpString, xrpToDropsBigInt } from "../money.js";
import type { AllowanceResult, EventId } from "../types.js";
import { quoteAllowance } from "../xrpl/allowance.js";
import { badgeReadyReserveXrp } from "../xrpl/reserve.js";
import type { ApiDeps } from "./deps.js";

/**
 * Pay one attendee's allowance for one event, through `deps.chain`.
 *
 * Throws AllowanceDeniedError("unavailable") when there is nothing to pay from
 * — no such event on this server, no ledger wired, or no treasury key — with
 * `details.reason` saying which. The treasury is made on the spot when the
 * event has none yet and this server can make one.
 */
export async function payAllowanceFor(
  deps: ApiDeps,
  input: { eventId: EventId; address: string; balanceXrp?: string },
): Promise<AllowanceResult> {
  const { eventId, address } = input;

  const event = deps.events ? await deps.events.find(eventId) : null;
  if (!event) {
    throw new AllowanceDeniedError(
      `Event ${eventId} is not set up on this server, so it has no allowance and no treasury.`,
      "unavailable",
      { eventId, address, reason: "no_event" },
    );
  }
  const ledger = deps.allowances;
  if (!ledger) {
    throw new AllowanceDeniedError(
      "No allowance ledger is wired on this server, so nothing can be paid.",
      "unavailable",
      { eventId, address, reason: "no_ledger" },
    );
  }

  let treasury = deps.treasuries ? await deps.treasuries.handle(eventId) : null;
  if (!treasury && deps.treasuries?.configured) {
    // The boot backfill missed it (it failed, or the event arrived another
    // way). Make it now rather than refusing an attendee over it.
    await deps.treasuries.ensure(eventId);
    treasury = await deps.treasuries.handle(eventId);
  }

  return deps.chain.payAllowance(deps.gateway, {
    eventId,
    address,
    allowanceXrp: event.allowanceXrp ?? "0",
    budgetXrp: event.budgetXrp ?? "0",
    feeBufferXrp: deps.config.reward.feeBufferXrp,
    maxPerAttendeeXrp: deps.config.reward.maxPerAttendeeXrp,
    treasury,
    ledger,
    ...(input.balanceXrp === undefined ? {} : { balanceXrp: input.balanceXrp }),
  });
}

/**
 * The most one attendee could be sent at an allowance of `allowanceXrp`: the
 * allowance, a whole badge reserve for a wallet that has nothing, and the fee
 * buffer. What the ceiling has to be compared against, because the organiser
 * cannot know which of their attendees will turn up with an empty wallet.
 */
export function largestPaymentXrp(deps: Pick<ApiDeps, "config">, allowanceXrp: string): string {
  const allowance = xrpToDropsBigInt(allowanceXrp, "allowanceXrp");
  const worst =
    allowance + xrpToDropsBigInt(badgeReadyReserveXrp()) + xrpToDropsBigInt(deps.config.reward.feeBufferXrp);
  return dropsToXrpString(worst);
}

/**
 * Why this server could never pay an allowance this large, or null when it can.
 * A sentence for the organiser, naming the setting that decides it.
 */
export function allowanceOverCeiling(deps: Pick<ApiDeps, "config">, allowanceXrp: string): string | null {
  const worst = largestPaymentXrp(deps, allowanceXrp);
  const ceiling = deps.config.reward.maxPerAttendeeXrp;
  if (xrpToDropsBigInt(worst) <= xrpToDropsBigInt(ceiling)) return null;
  const most = dropsToXrpString(
    xrpToDropsBigInt(ceiling) -
      xrpToDropsBigInt(badgeReadyReserveXrp()) -
      xrpToDropsBigInt(deps.config.reward.feeBufferXrp),
  );
  return (
    `An allowance of ${allowanceXrp} XRP can cost up to ${worst} XRP for an attendee whose wallet is ` +
    `empty, and this server pays at most ${ceiling} XRP per attendee. The largest allowance it can ` +
    `pay is ${most} XRP.`
  );
}

/** One attendee's allowance at one event, as a screen shows it. */
export interface AllowanceStatusView {
  /** The event's setting. */
  allowanceXrp: string;
  status: "none" | "in_flight" | "paid";
  /** What was sent, once something has been; otherwise what this wallet would be sent now. */
  amountXrp: string;
  topupXrp: string;
  txHash: string | null;
  /** Whether this server can pay from this event's treasury at all. */
  payable: boolean;
}

/**
 * NEVER THROWS. A scan at the desk must still answer when the allowance book is
 * unreachable: null means "nothing to say about money", and the badge half of
 * the card still renders.
 */
export async function readAllowanceStatus(
  deps: ApiDeps,
  eventId: EventId,
  address: string,
  balanceXrp: string,
): Promise<AllowanceStatusView | null> {
  try {
    const event = deps.events ? await deps.events.find(eventId) : null;
    if (!event) return null;

    const [row, treasury] = await Promise.all([
      deps.allowances ? deps.allowances.find(eventId, address) : Promise.resolve(null),
      deps.treasuries ? deps.treasuries.find(eventId) : Promise.resolve(null),
    ]);
    const payable = Boolean(deps.allowances && deps.treasuries?.configured && treasury);

    if (row) {
      return {
        allowanceXrp: row.allowanceXrp,
        status: row.status === "confirmed" ? "paid" : "in_flight",
        amountXrp: row.amountXrp,
        topupXrp: row.topupXrp,
        txHash: row.txHash,
        payable,
      };
    }

    const quote = quoteAllowance(balanceXrp, {
      allowanceXrp: event.allowanceXrp ?? "0",
      feeBufferXrp: deps.config.reward.feeBufferXrp,
    });
    return {
      allowanceXrp: quote.allowanceXrp,
      status: "none",
      amountXrp: quote.amountXrp,
      topupXrp: quote.topupXrp,
      txHash: null,
      payable,
    };
  } catch {
    return null;
  }
}
