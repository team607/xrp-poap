/**
 * Money, as integer drops.
 *
 * Every amount in this app ends up compared against a limit: an event's budget,
 * the per-attendee ceiling, a wallet's spendable balance, an item's price times
 * a quantity. A float gets those comparisons wrong in the direction that costs
 * money — 0.1 + 0.2 is more than 0.3 — so amounts travel as decimal XRP strings
 * at the edges and as BigInt drops wherever arithmetic happens. These functions
 * are the only doors between the two.
 */
import { ValidationError } from "./errors.js";

export const DROPS_PER_XRP = 1_000_000n;

/**
 * Plain decimal XRP: up to eleven whole digits (the supply is 100 billion) and
 * at most six decimal places, because a drop is the smallest unit there is. No
 * sign, no exponent, no thousands separators — "1e3" and "1,000" are both ways
 * of being misread.
 */
const XRP_DECIMAL = /^\d{1,11}(\.\d{1,6})?$/;

export function isXrpAmount(value: unknown): value is string {
  return typeof value === "string" && XRP_DECIMAL.test(value);
}

/**
 * Decimal XRP string -> integer drops. Throws a typed INVALID_INPUT rather than
 * guessing at anything that is not money.
 *
 * Parsed by hand rather than through xrpl's `xrpToDrops`, which goes via
 * BigNumber and accepts exponent forms this app never wants to see.
 */
export function xrpToDropsBigInt(amountXrp: string, label = "amountXrp"): bigint {
  const value = typeof amountXrp === "string" ? amountXrp.trim() : "";
  if (!XRP_DECIMAL.test(value)) {
    throw new ValidationError(
      "INVALID_INPUT",
      `${label} "${String(amountXrp)}" is not an XRP amount. Use a plain decimal with at most six ` +
        "decimal places, like 2.5.",
      { [label]: amountXrp },
    );
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * DROPS_PER_XRP + BigInt(fraction.padEnd(6, "0"));
}

/**
 * Exact drops -> decimal XRP string.
 *
 * `dropsToXrp` from xrpl returns a number, which is a float, and these values
 * are compared against limits. So the digits are rendered from the BigInt:
 * 1500000 + 1500000 drops reads "3", never "2.9999999999999996".
 */
export function dropsToXrpString(drops: bigint): string {
  const negative = drops < 0n;
  const abs = negative ? -drops : drops;

  const whole = abs / DROPS_PER_XRP;
  const fraction = abs % DROPS_PER_XRP;

  let out = whole.toString();
  if (fraction > 0n) {
    out += `.${fraction.toString().padStart(6, "0").replace(/0+$/, "")}`;
  }
  return negative ? `-${out}` : out;
}

/** "1.50" and "1.5" are the same amount; store and compare the one spelling. */
export function normalizeXrp(amountXrp: string, label?: string): string {
  return dropsToXrpString(xrpToDropsBigInt(amountXrp, label));
}

export function maxDrops(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
