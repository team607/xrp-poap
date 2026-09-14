/**
 * Sweeping what is left in an event's treasury to an address the organiser
 * names.
 *
 * Everything above the reserve goes, less a small allowance for the fee. The
 * reserve itself stays: getting it back means deleting the account, which the
 * ledger only allows long after the account last transacted, and a treasury
 * that still exists is a treasury the event can be topped up into again.
 *
 * THE DESTINATION IS CHECKED BEFORE A DROP MOVES, because an organiser typing
 * an address is exactly where money gets lost: an exchange deposit address
 * that needs a destination tag accepts the payment and credits nobody.
 */
import type { Payment } from "xrpl";
import { ValidationError, XrplLayerError } from "../errors.js";
import { dropsToXrpString, xrpToDropsBigInt } from "../money.js";
import type { EventId, XrplGateway } from "../types.js";
import { readAccount } from "./account.js";
import type { AllowanceTreasury } from "./allowance.js";
import { assertValidAddress } from "./encoding.js";
import { memo } from "./memos.js";
import { BASE_RESERVE_XRP } from "./reserve.js";

export const SWEEP_MEMO_TYPE = "poap/sweep";

/**
 * Held back from a sweep for the transaction fee. Far more than a normal fee,
 * so a sweep during a fee spike still goes through rather than failing for the
 * sake of a few drops.
 */
export const SWEEP_FEE_ALLOWANCE_XRP = "0.001";

export interface SweepInput {
  eventId: EventId;
  treasury: AllowanceTreasury;
  destination: string;
  destinationTag?: number;
}

export interface SweepResult {
  amountXrp: string;
  destination: string;
  destinationTag?: number;
  txHash: string;
  ledgerIndex: number;
}

export async function sweepTreasury(gateway: XrplGateway, input: SweepInput): Promise<SweepResult> {
  const { eventId, treasury, destination, destinationTag } = input;
  assertValidAddress(destination, "destination");

  if (destination === treasury.address) {
    throw new ValidationError("INVALID_INPUT", "That is the treasury's own address.", { destination });
  }
  if (
    destinationTag !== undefined &&
    (!Number.isInteger(destinationTag) || destinationTag < 0 || destinationTag > 4_294_967_295)
  ) {
    throw new ValidationError("INVALID_INPUT", "A destination tag is a whole number up to 4294967295.", {
      destinationTag,
    });
  }

  const source = await readAccount(gateway, treasury.address);
  if (!source.activated) {
    throw new XrplLayerError(
      "CONFLICT",
      "This treasury has never been funded, so there is nothing to sweep.",
      { eventId, treasury: treasury.address },
    );
  }

  const amount = xrpToDropsBigInt(source.spendableXrp) - xrpToDropsBigInt(SWEEP_FEE_ALLOWANCE_XRP);
  if (amount <= 0n) {
    throw new XrplLayerError(
      "CONFLICT",
      `Nothing is left above the treasury's reserve. It holds ${source.balanceXrp} XRP, and ` +
        `${source.reserveXrp} XRP of that has to stay.`,
      { eventId, balanceXrp: source.balanceXrp, reserveXrp: source.reserveXrp },
    );
  }

  const target = await readAccount(gateway, destination);
  if (target.requireDestTag && destinationTag === undefined) {
    throw new ValidationError(
      "INVALID_INPUT",
      "That address only accepts payments that carry a destination tag. Exchanges usually work this " +
        "way: copy the tag (sometimes called a memo) from the deposit page and try again.",
      { destination, requireDestTag: true },
    );
  }
  if (target.depositAuth) {
    throw new XrplLayerError(
      "CONFLICT",
      "That wallet only accepts payments from accounts it has authorised, so this sweep would bounce.",
      { destination },
    );
  }
  if (!target.activated && amount < xrpToDropsBigInt(BASE_RESERVE_XRP)) {
    throw new XrplLayerError(
      "CONFLICT",
      `That address does not exist on the ledger yet, and a payment that creates it must be at least ` +
        `${BASE_RESERVE_XRP} XRP. Only ${dropsToXrpString(amount)} XRP can be swept.`,
      { destination, amountXrp: dropsToXrpString(amount) },
    );
  }

  const wallet = treasury.open();
  const payment: Payment = {
    TransactionType: "Payment",
    Account: treasury.address,
    Destination: destination,
    Amount: amount.toString(),
    ...(destinationTag === undefined ? {} : { DestinationTag: destinationTag }),
    Memos: [memo(SWEEP_MEMO_TYPE, String(eventId))],
  };
  const outcome = await gateway.submit(payment, { wallet });

  return {
    amountXrp: dropsToXrpString(amount),
    destination,
    ...(destinationTag === undefined ? {} : { destinationTag }),
    txHash: outcome.hash,
    ledgerIndex: outcome.ledgerIndex,
  };
}
