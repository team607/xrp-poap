/**
 * NFTokenCreateOffer / CancelOffer / AcceptOffer — brief sections 5.2 and 5.3.
 *
 * The claim flow is: issuer creates a zero-amount sell offer locked to one
 * Destination, attendee accepts it from their own wallet, we keep the hash of
 * their accept as the attendance record.
 *
 * `Destination` is not optional in this design. An offer without it can be
 * accepted by anyone who reads the ledger, which hands the badge to whoever
 * looks first.
 *
 * Each open offer locks 0.2 XRP of the issuer's owner reserve until it is
 * accepted or cancelled (section 7), which is why offers are created lazily,
 * one per attendee at claim time, and cancelled when a claim is abandoned.
 */
import {
  NFTokenCreateOfferFlags,
  type NFTokenAcceptOffer,
  type NFTokenCancelOffer,
  type NFTokenCreateOffer,
  type Wallet,
} from "xrpl";
import { ValidationError, XrplLayerError } from "../errors.js";
import type {
  AcceptOfferPayload,
  ClaimOffer,
  CreateClaimOfferInput,
  XrplGateway,
} from "../types.js";
import { isRippledError, requireMetaString } from "./client.js";
import { assertValidAddress } from "./encoding.js";

/**
 * `tfSellNFToken`. Its numeric value is also 1, but it is a completely
 * different flag from `tfBurnable` on NFTokenMint — hence the enum.
 */
const SELL_OFFER_FLAGS: number = NFTokenCreateOfferFlags.tfSellNFToken;

/** account_objects pages are bounded; this stops a node echoing a marker forever. */
const MAX_OFFER_PAGES = 1000;

interface RawSellOffer {
  nft_offer_index?: string;
  owner?: string;
  amount?: unknown;
  destination?: string;
}

/**
 * Creates the destination-locked, zero-price sell offer that an attendee
 * accepts to claim their badge.
 */
export async function createClaimOffer(
  gateway: XrplGateway,
  input: CreateClaimOfferInput,
): Promise<ClaimOffer> {
  const destination = input?.destination;
  if (typeof destination !== "string" || destination.trim() === "") {
    throw new ValidationError(
      "INVALID_ADDRESS",
      "createClaimOffer requires a destination. An NFTokenCreateOffer without a Destination is claimable by anyone on the ledger, so there is no safe default.",
      { nftokenId: input?.nftokenId },
    );
  }
  assertValidAddress(destination, "destination");

  const tx: NFTokenCreateOffer = {
    TransactionType: "NFTokenCreateOffer",
    Account: gateway.issuerAddress,
    NFTokenID: input.nftokenId,
    Amount: "0",
    Flags: SELL_OFFER_FLAGS,
    Destination: destination,
  };

  const outcome = await gateway.submit(tx);
  const offerId = requireMetaString(outcome, "offer_id");

  return {
    offerId,
    nftokenId: input.nftokenId,
    destination,
    txHash: outcome.hash,
    ledgerIndex: outcome.ledgerIndex,
    fee: outcome.fee,
  };
}

/**
 * Cancels a pending claim offer. This is how the 0.2 XRP owner reserve the
 * offer locked up is released back to the issuer, so abandoned claims must be
 * cancelled rather than left to rot.
 */
export async function cancelClaimOffer(
  gateway: XrplGateway,
  offerId: string,
): Promise<{ txHash: string; ledgerIndex: number }> {
  const tx: NFTokenCancelOffer = {
    TransactionType: "NFTokenCancelOffer",
    Account: gateway.issuerAddress,
    NFTokenOffers: [offerId],
  };

  const outcome = await gateway.submit(tx);
  return { txHash: outcome.hash, ledgerIndex: outcome.ledgerIndex };
}

/**
 * Builds the unsigned NFTokenAcceptOffer the attendee signs (section 5.3).
 *
 * Pure: no ledger access, no signing. This payload is what gets rendered as a
 * Xaman QR code or deeplink. We never see the attendee's key, and the hash of
 * the transaction they submit is the attendance record.
 */
export function buildAcceptOfferPayload(params: {
  offerId: string;
  attendeeAddress: string;
}): AcceptOfferPayload {
  assertValidAddress(params.attendeeAddress, "attendeeAddress");
  if (typeof params.offerId !== "string" || params.offerId.trim() === "") {
    throw new ValidationError(
      "INVALID_INPUT",
      "buildAcceptOfferPayload requires the offerId returned by createClaimOffer",
      { attendeeAddress: params.attendeeAddress },
    );
  }

  return {
    TransactionType: "NFTokenAcceptOffer",
    Account: params.attendeeAddress,
    NFTokenSellOffer: params.offerId,
  };
}

/**
 * Lists the open sell offers for one NFT. A node that has no NFTokenOffer
 * objects for the token answers `objectNotFound`, which means "no offers", not
 * "query failed".
 */
export async function getSellOffers(
  gateway: XrplGateway,
  nftokenId: string,
): Promise<Array<{ offerId: string; owner: string; amount: string; destination?: string }>> {
  let response: { result?: { offers?: RawSellOffer[] } };
  try {
    response = await gateway.request({ command: "nft_sell_offers", nft_id: nftokenId });
  } catch (err) {
    if (isRippledError(err, "objectNotFound")) return [];
    throw err;
  }

  const offers = response?.result?.offers ?? [];
  return offers.map((offer) => ({
    offerId: offer.nft_offer_index ?? "",
    owner: offer.owner ?? "",
    amount: typeof offer.amount === "string" ? offer.amount : JSON.stringify(offer.amount ?? "0"),
    ...(offer.destination ? { destination: offer.destination } : {}),
  }));
}

/**
 * Counts the issuer's pending NFTokenOffer objects, following the marker
 * through every page.
 *
 * This backs the cutover check "offers created lazily, verified by checking
 * issuer's pending offer count" (section 9). Multiply the result by 0.2 XRP to
 * get the reserve currently locked.
 */
export async function countPendingIssuerOffers(
  gateway: XrplGateway,
  issuerAddress?: string,
): Promise<number> {
  const account = issuerAddress ?? gateway.issuerAddress;
  let marker: unknown;
  let count = 0;
  let pages = 0;

  do {
    const request: Record<string, unknown> = {
      command: "account_objects",
      account,
      type: "nft_offer",
      ledger_index: "validated",
      limit: 400,
    };
    if (marker !== undefined && marker !== null) request.marker = marker;

    const response: { result?: { account_objects?: unknown[]; marker?: unknown } } =
      await gateway.request(request);

    count += response?.result?.account_objects?.length ?? 0;
    marker = response?.result?.marker;

    if (++pages > MAX_OFFER_PAGES) {
      throw new XrplLayerError(
        "LEDGER_QUERY_FAILED",
        `account_objects for ${account} kept returning a marker after ${MAX_OFFER_PAGES} pages`,
        { account, counted: count },
      );
    }
  } while (marker !== undefined && marker !== null);

  return count;
}

/**
 * Submits an NFTokenAcceptOffer signed by the supplied wallet.
 *
 * FOR SCRIPTS AND TESTS ONLY. In production the attendee signs the payload
 * from `buildAcceptOfferPayload` in Xaman on their own device; the server never
 * holds an attendee key and this path is never reached server-side. It exists
 * so the testnet end-to-end scripts can play both sides.
 */
export async function acceptOfferAs(
  gateway: XrplGateway,
  params: { offerId: string; wallet: Wallet },
): Promise<{ txHash: string; ledgerIndex: number }> {
  const tx: NFTokenAcceptOffer = {
    TransactionType: "NFTokenAcceptOffer",
    Account: params.wallet.classicAddress,
    NFTokenSellOffer: params.offerId,
  };

  const outcome = await gateway.submit(tx, { wallet: params.wallet });
  return { txHash: outcome.hash, ledgerIndex: outcome.ledgerIndex };
}
