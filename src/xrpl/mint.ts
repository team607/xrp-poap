/**
 * NFTokenMint — brief section 5.1.
 *
 * Every badge this module produces is soulbound: `tfBurnable` is set so the
 * issuer can revoke a badge issued in error, and `tfTransferable` is left
 * unset so the badge can only ever move to or from the issuer. Flags are
 * immutable after mint (section 4), so there is no "fix it later".
 *
 * Two traps are handled here and nowhere else:
 *   - `TransferFee` is never emitted. The field is invalid while
 *     `tfTransferable` is unset and rippled rejects the whole transaction.
 *   - `nftoken_id` exists only in transaction metadata. It is returned nowhere
 *     else, so the caller must persist the MintResult immediately.
 */
import { NFTokenMintFlags, type NFTokenMint } from "xrpl";
import { XrplLayerError } from "../errors.js";
import type { MintBadgeInput, MintResult, XrplGateway } from "../types.js";
import { requireMetaString } from "./client.js";
import { assertValidTaxon, encodeUri } from "./encoding.js";

/**
 * `tfBurnable` alone — the value is 1, never 9 and never 11. Taken from the
 * NFTokenMint enum because the same numeric 1 means `tfSellNFToken` on
 * NFTokenCreateOffer (section 10).
 */
const BADGE_MINT_FLAGS: number = NFTokenMintFlags.tfBurnable;

/** Mints one soulbound badge from the issuer account. */
export async function mint(
  gateway: XrplGateway,
  input: MintBadgeInput,
): Promise<MintResult> {
  assertValidTaxon(input.eventId);
  const uriHex = encodeUri(input.uri);

  const tx: NFTokenMint = {
    TransactionType: "NFTokenMint",
    Account: gateway.issuerAddress,
    URI: uriHex,
    Flags: BADGE_MINT_FLAGS,
    NFTokenTaxon: input.eventId,
    // No TransferFee key. Not 0, not undefined — absent.
  };

  const outcome = await gateway.submit(tx);
  const nftokenId = requireMetaString(outcome, "nftoken_id");

  return {
    nftokenId,
    eventId: input.eventId,
    uri: input.uri,
    txHash: outcome.hash,
    ledgerIndex: outcome.ledgerIndex,
    fee: outcome.fee,
  };
}

/**
 * Mints a run of badges strictly one at a time.
 *
 * Serial is not a style choice: each submit consumes the issuer's next
 * sequence number, and firing them concurrently produces `tefPAST_SEQ`
 * failures and lost mints.
 *
 * On failure the error carries every MintResult completed before the failure
 * in `details.completed`. Those badges exist on the ledger and their
 * `nftoken_id`s are not recoverable from anywhere but that metadata, so the
 * caller must persist them before retrying the remainder.
 */
export async function mintBatch(
  gateway: XrplGateway,
  inputs: MintBadgeInput[],
): Promise<MintResult[]> {
  const completed: MintResult[] = [];

  for (const [index, input] of inputs.entries()) {
    try {
      completed.push(await mint(gateway, input));
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      const failure = new XrplLayerError(
        err instanceof XrplLayerError ? err.code : "TX_FAILED",
        `mintBatch failed on input ${index} of ${inputs.length}: ${cause.message}. ` +
          `${completed.length} badge(s) were already minted — persist details.completed before retrying.`,
        {
          failedIndex: index,
          failedInput: input,
          completed,
          attempted: index + 1,
          total: inputs.length,
          causeMessage: cause.message,
          causeDetails: err instanceof XrplLayerError ? err.details : undefined,
        },
      );
      failure.cause = cause;
      throw failure;
    }
  }

  return completed;
}
