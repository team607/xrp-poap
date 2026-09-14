/**
 * Transaction memos: how a payment on the ledger is tied back to a row here.
 *
 * An allowance payment carries `poap/allowance` and the reservation it settles;
 * a purchase carries `poap/purchase` and the order it pays for. That is what
 * lets a payment whose outcome was lost be found again in an account's history,
 * and what stops an unrelated payment of the right size being passed off as
 * the one we asked for.
 *
 * Memos are public, like everything else on the ledger. Nothing secret goes in
 * one.
 */
import { convertHexToString, convertStringToHex } from "xrpl";

/**
 * The memo on a Payment that pays for an order; its data is the order id.
 * Here rather than beside the verifier so the payload builder, which must stay
 * free of ledger code, can stamp exactly what the verifier looks for.
 */
export const PURCHASE_MEMO_TYPE = "poap/purchase";

export interface MemoField {
  Memo: { MemoType?: string; MemoData?: string };
}

/** Both halves hex-encoded, as the ledger stores them. */
export function memo(type: string, data: string): MemoField {
  return { Memo: { MemoType: convertStringToHex(type), MemoData: convertStringToHex(data) } };
}

function decodeHex(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^([0-9A-Fa-f]{2})*$/.test(value)) return undefined;
  try {
    return convertHexToString(value);
  } catch {
    return undefined;
  }
}

/**
 * Every memo on a transaction body, decoded. Never throws: a memo is an
 * untrusted string somebody else may have written, and a malformed one is
 * simply a memo that says nothing.
 */
export function readMemos(body: Record<string, unknown>): Array<{ type?: string; data?: string }> {
  const memos = Array.isArray(body.Memos) ? (body.Memos as unknown[]) : [];
  const out: Array<{ type?: string; data?: string }> = [];
  for (const entry of memos) {
    const inner = (entry as { Memo?: { MemoType?: unknown; MemoData?: unknown } } | null)?.Memo;
    if (!inner) continue;
    const type = decodeHex(inner.MemoType);
    const data = decodeHex(inner.MemoData);
    out.push({ ...(type === undefined ? {} : { type }), ...(data === undefined ? {} : { data }) });
  }
  return out;
}

export function hasMemo(body: Record<string, unknown>, type: string, data: string): boolean {
  return readMemos(body).some((m) => m.type === type && m.data === data);
}
