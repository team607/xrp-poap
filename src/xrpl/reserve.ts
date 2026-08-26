/**
 * XRPL reserves, and the one question that depends on them: can this wallet
 * receive a badge?
 *
 * These lived in `src/api/demo-state.ts`, which was wrong in a way that only
 * showed up when it mattered. `sponsorWallet` could not import from an api
 * module, so it asked a cheaper question instead — "does this account exist?"
 * — and an existing wallet holding dust was told it needed nothing. The badge
 * was minted, the offer created, and the attendee's wallet refused the accept
 * because it could not afford the NFTokenPage. The desk had already said
 * "ready".
 *
 * One module, imported by both the desk and the sponsor, so the number a
 * volunteer is shown and the number that decides whether to pay cannot drift.
 */
import { dropsToXrp, xrpToDrops } from "xrpl";

/**
 * Base reserve: what an account must hold merely to exist on the ledger.
 *
 * Testnet and mainnet have both sat at 1 XRP since the 2024 reduction. It is a
 * network parameter, not a protocol constant, so it is named here rather than
 * inlined: when it moves, one line moves with it and every number that depends
 * on it moves with that line.
 */
export const BASE_RESERVE_XRP = "1";

/**
 * Owner reserve for one ledger object. A badge lands in an NFTokenPage, which
 * is one object however many badges are on it.
 */
export const OWNER_RESERVE_PER_OBJECT_XRP = "0.2";

/** Integer drops. Balances are never touched with floats (CLAUDE.md). */
function drops(xrp: string): bigint {
  return BigInt(xrpToDrops(xrp));
}

/**
 * What a wallet must hold before it can exist AND hold one badge.
 *
 * COMPUTED, so the number reported and the reason for it cannot drift apart:
 * change either constant above and this follows.
 */
export function badgeReadyReserveXrp(): string {
  return String(dropsToXrp((drops(BASE_RESERVE_XRP) + drops(OWNER_RESERVE_PER_OBJECT_XRP)).toString()));
}

/**
 * How much more this balance needs before a badge can land. `"0"` once there is
 * enough — never a negative number, which reads as a refund.
 */
export function reserveShortfallXrp(balanceXrp: string): string {
  const need = drops(BASE_RESERVE_XRP) + drops(OWNER_RESERVE_PER_OBJECT_XRP);
  const shortfall = need - drops(balanceXrp);
  return shortfall <= 0n ? "0" : String(dropsToXrp(shortfall.toString()));
}

/**
 * THE question, in one place.
 *
 * Not "does the account exist". An account that exists but holds less than
 * base + one owner reserve cannot accept an NFT either, and that wallet is
 * MORE common than an empty one — it belongs to somebody who has touched XRP
 * before and is therefore least likely to expect the refusal.
 */
export function canReceiveBadge(balanceXrp: string): boolean {
  return reserveShortfallXrp(balanceXrp) === "0";
}
