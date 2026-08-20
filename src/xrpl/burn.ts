/**
 * NFTokenBurn.
 *
 * Two callers, one transaction type:
 *   - the holder burning their own badge (no `Owner` field), and
 *   - the issuer revoking a badge issued in error, which is only possible
 *     because `tfBurnable` was set at mint time (section 4).
 *
 * Burning destroys the token, not the attendance. Verification reads the
 * attendee's NFTokenAcceptOffer, so a burned badge still verifies as
 * "attended, badge burned". Never treat a burn as a retraction of attendance.
 */
import type { NFTokenBurn, Wallet } from "xrpl";
import type { BurnResult, XrplGateway } from "../types.js";
import { assertValidAddress } from "./encoding.js";

/**
 * Burns one badge.
 *
 * `owner` is only emitted when it differs from the signing account — rippled
 * rejects an `Owner` field that matches the submitter. Pass `wallet` to sign
 * as somebody other than the issuer (scripts burning from an attendee wallet).
 */
export async function burn(
  gateway: XrplGateway,
  params: { nftokenId: string; owner?: string; wallet?: Wallet },
): Promise<BurnResult> {
  const signer = params.wallet?.classicAddress ?? gateway.issuerAddress;

  const tx: NFTokenBurn = {
    TransactionType: "NFTokenBurn",
    Account: signer,
    NFTokenID: params.nftokenId,
  };

  // Issuer revoking somebody else's badge. Self-burns must omit the field.
  if (params.owner && params.owner !== signer) {
    assertValidAddress(params.owner, "owner");
    tx.Owner = params.owner;
  }

  const outcome = await gateway.submit(tx, params.wallet ? { wallet: params.wallet } : {});

  return {
    nftokenId: params.nftokenId,
    txHash: outcome.hash,
    ledgerIndex: outcome.ledgerIndex,
    fee: outcome.fee,
  };
}
