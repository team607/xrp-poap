/**
 * XRPL NFT layer — public surface.
 *
 * Mint, claim, and verify POAP-style attendance badges on the XRP Ledger.
 * There is no contract to deploy: these are native transaction types.
 *
 * Everything that touches the ledger takes an `XrplGateway` as its first
 * argument, so the whole library runs offline against a fake in tests.
 *
 *   import { createGateway, mint, createClaimOffer, verifyClaim } from "xrpl-nft-layer";
 *
 *   const gateway = await createGateway(loadConfig());
 *   const badge   = await mint(gateway, { eventId, uri });
 *   const offer   = await createClaimOffer(gateway, {
 *     nftokenId: badge.nftokenId,
 *     destination: attendeeAddress,   // never omit this
 *   });
 *   // ...the attendee signs NFTokenAcceptOffer, and its hash IS the record.
 *   const proof = await verifyClaim(gateway, { address, eventId, txHash });
 *
 * The one rule: attendance is an event, not a state. `verifyClaim` asks whether
 * this wallet ever accepted a badge we issued for this event, never whether it
 * currently holds one. A burned badge still verifies.
 */

// --- contracts and configuration -------------------------------------------
export * from "./types.js";
export * from "./errors.js";
export {
  loadConfig,
  describeConfig,
  assertNetworkMatchesEndpoint,
  parseTrustProxy,
  type AppConfig,
  type SponsorConfig,
  type LoadConfigOptions,
} from "./config.js";

// --- the ledger seam --------------------------------------------------------
export {
  XrplConnection,
  createGateway,
  withGateway,
  isRippledError,
  metaString,
  requireMetaString,
  type ConnectionOptions,
} from "./xrpl/client.js";
export {
  encodeUri,
  decodeUri,
  assertValidTaxon,
  assertValidAddress,
} from "./xrpl/encoding.js";

// --- minting and claiming ---------------------------------------------------
export { mint, mintBatch } from "./xrpl/mint.js";
export {
  createClaimOffer,
  cancelClaimOffer,
  buildAcceptOfferPayload,
  getSellOffers,
  countPendingIssuerOffers,
  acceptOfferAs,
} from "./xrpl/offers.js";
export { burn } from "./xrpl/burn.js";
export {
  accountExists,
  getAccountBalanceXrp,
  sponsorWallet,
} from "./xrpl/sponsor.js";

// --- verification -----------------------------------------------------------
export {
  verifyClaim,
  unscrambleTaxon,
  decodeNftokenId,
  recoverNftokenId,
  sellOfferIdOf,
  type DecodedNftokenId,
  type RecoveredNftokenId,
} from "./xrpl/verify.js";
export {
  getRoster,
  getNftInfo,
  getNftHistory,
  getAccountNfts,
  CLIO_ENDPOINTS,
} from "./xrpl/roster.js";

// --- metadata, persistence, signing, HTTP -----------------------------------
export * from "./metadata/index.js";
export * from "./db/index.js";
export {
  buildClaimSignRequest,
  buildAcceptOfferTxjson,
  parseXamanWebhook,
  parseXamanClaimMeta,
  CLAIM_PAYLOAD_EXPIRE_MINUTES,
  type ClaimSignRequestParams,
  type XamanClaimSignRequest,
  type ParsedXamanWebhook,
} from "./xaman/payloads.js";
export {
  XummXamanService,
  NullXamanService,
  type XamanService,
} from "./xaman/client.js";
export { buildServer } from "./api/server.js";
export {
  buildDeps,
  loadChainOps,
  type ApiDeps,
  type ChainOps,
  type BuiltDeps,
} from "./api/deps.js";
