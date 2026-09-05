/**
 * Attendance verification.
 *
 * THE ONE RULE (brief section 4): attendance is an **event**, not a state.
 * This module never asks "does this wallet hold the badge". It asks "did this
 * wallet ever accept a badge we issued under this taxon". A burned badge is
 * still attendance; `account_nfts` returning zero for someone who demonstrably
 * attended is measured fact, not theory (docs/ground-truth.md). Nothing in
 * here may make `attended` depend on current ownership or on `isBurned`.
 *
 * An ordinary failed claim is a *return value*, never an exception. Throws are
 * reserved for transport and configuration faults — the caller of a verify
 * endpoint should get `not_attended` with a reason, not a 500.
 */
import { decodeAccountID, encodeAccountID } from "xrpl";
import { ValidationError, XrplLayerError } from "../errors.js";
import type {
  EventId,
  NftInfo,
  NftokenIdSource,
  VerificationChecks,
  VerifyClaimInput,
  VerifyClaimResult,
  XrplGateway,
} from "../types.js";
import { isRippledError } from "./client.js";
import { assertValidTaxon } from "./encoding.js";
import { getNftInfo, unwrapResult } from "./roster.js";

const HASH_RE = /^[0-9A-F]{64}$/;
const NFTOKEN_ID_RE = /^[0-9A-F]{64}$/;

// ---------------------------------------------------------------------------
// NFTokenID decoding — the degraded fallback
// ---------------------------------------------------------------------------

/**
 * The XLS-20 taxon is stored XOR-scrambled so that sequential mints do not
 * produce visibly sequential token ids.
 *
 * `taxon = scrambledTaxon XOR ((384160001 * sequence + 2459) mod 2^32)`
 *
 * Done in BigInt on purpose: `384160001 * 0xFFFFFFFF` is ~1.65e18, far past
 * `Number.MAX_SAFE_INTEGER`, and the plain `^` operator coerces to a *signed*
 * 32-bit int. `>>> 0` puts the result back in unsigned range.
 */
export function unscrambleTaxon(scrambledTaxon: number, sequence: number): number {
  const modulus = 1n << 32n;
  const scramble = (384_160_001n * BigInt(sequence >>> 0) + 2459n) % modulus;
  return Number(BigInt(scrambledTaxon >>> 0) ^ scramble) >>> 0;
}

export interface DecodedNftokenId {
  nftokenId: string;
  flags: number;
  transferFee: number;
  /** 20-byte issuer AccountID, uppercase hex. Always present. */
  issuerAccountIdHex: string;
  /** Classic r-address form. Absent only if address encoding is unavailable. */
  issuer?: string;
  taxon: EventId;
  sequence: number;
}

/**
 * A 256-bit NFTokenID is self-describing: 2 bytes flags, 2 bytes transfer fee,
 * 20 bytes issuer AccountID, 4 bytes scrambled taxon, 4 bytes sequence. That
 * is what lets verification survive an endpoint with no `nft_info`.
 */
export function decodeNftokenId(nftokenId: string): DecodedNftokenId {
  const id = nftokenId.trim().toUpperCase();
  if (!NFTOKEN_ID_RE.test(id)) {
    // verifyClaim catches this and turns it into a clean check failure, so the
    // code rarely reaches a caller.
    throw new ValidationError(
      "INVALID_INPUT",
      `"${nftokenId}" is not a 64-character hex NFTokenID`,
      { nftokenId },
    );
  }

  const issuerAccountIdHex = id.slice(8, 48);
  const scrambledTaxon = Number.parseInt(id.slice(48, 56), 16);
  const sequence = Number.parseInt(id.slice(56, 64), 16);

  const decoded: DecodedNftokenId = {
    nftokenId: id,
    flags: Number.parseInt(id.slice(0, 4), 16),
    transferFee: Number.parseInt(id.slice(4, 8), 16),
    issuerAccountIdHex,
    taxon: unscrambleTaxon(scrambledTaxon, sequence),
    sequence,
  };

  // ripple-address-codec is re-exported by xrpl. If that ever stops being
  // true, the raw AccountID hex above still supports an issuer comparison.
  try {
    if (typeof encodeAccountID === "function") {
      decoded.issuer = encodeAccountID(Buffer.from(issuerAccountIdHex, "hex"));
    }
  } catch {
    /* leave issuer unset; callers fall back to issuerAccountIdHex */
  }

  return decoded;
}

/** Classic address -> uppercase AccountID hex, or undefined if not an address. */
function accountIdHexOf(address: string): string | undefined {
  try {
    return Buffer.from(decodeAccountID(address)).toString("hex").toUpperCase();
  } catch {
    return undefined;
  }
}

/**
 * Issuer comparison for the degraded path: classic address first, raw
 * AccountID hex second.
 */
function decodedIssuerMatches(decoded: DecodedNftokenId, expectedIssuer: string): boolean {
  if (decoded.issuer !== undefined && decoded.issuer === expectedIssuer) return true;
  const expectedHex = accountIdHexOf(expectedIssuer);
  return expectedHex !== undefined && expectedHex === decoded.issuerAccountIdHex;
}

// ---------------------------------------------------------------------------
// Reading the accept transaction
// ---------------------------------------------------------------------------

/**
 * API v2 (xrpl.js v5's default) nests the transaction under `tx_json` and
 * keeps hash/meta/validated at the top level; API v1 puts the transaction
 * fields at the top level. Measured v2 shape, docs/ground-truth.md:
 *
 *   { tx_json: { TransactionType, Account, ... }, hash, meta, validated,
 *     ledger_index, ledger_hash, close_time_iso, ctid }
 *
 * Reading `result.TransactionType` on v2 yields undefined and silently fails
 * the isAcceptOffer check, so both shapes are read here.
 */
function txBodyOf(result: Record<string, any>): Record<string, any> {
  const v2 = result.tx_json;
  return v2 && typeof v2 === "object" ? (v2 as Record<string, any>) : result;
}

function metaOf(
  result: Record<string, any>,
  body: Record<string, any>,
): Record<string, any> | undefined {
  const meta = result.meta ?? result.metaData ?? body.meta ?? body.metaData;
  return meta && typeof meta === "object" ? (meta as Record<string, any>) : undefined;
}

export type { NftokenIdSource } from "../types.js";

export interface RecoveredNftokenId {
  nftokenId?: string;
  source: NftokenIdSource;
}

function hex64(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.trim().toUpperCase();
  return NFTOKEN_ID_RE.test(upper) ? upper : undefined;
}

/**
 * The sell offer this accept consumed, taken from the transaction body the
 * ledger returned.
 *
 * This exists so that nothing downstream has to persist an offer id supplied
 * by a request body or by an unauthenticated webhook — either of which a
 * caller can set to any 64 characters they like. The chain is the only source
 * that cannot be forged, and this is the field on the chain that says which
 * offer the attendee actually took.
 *
 * A brokered accept may name `NFTokenBuyOffer` as well as, or instead of, the
 * sell offer. Only a sell offer id belongs in something called `sellOfferId`:
 * writing a buy-offer id there would hand callers a plausible-looking value
 * pointing at the wrong ledger object. When the transaction names no sell
 * offer, `undefined` is the honest answer.
 */
export function sellOfferIdOf(body: Record<string, any>): string | undefined {
  return hex64(body.NFTokenSellOffer);
}

/**
 * An NFTokenAcceptOffer carries only `NFTokenSellOffer` — the NFTokenID is
 * never a field on the transaction itself. Two ways to recover it:
 *
 *  1. `meta.nftoken_id`. Present on Clio (measured), and the cheap path.
 *  2. The `DeletedNode` for the consumed `NFTokenOffer`, whose
 *     FinalFields/PreviousFields carry `NFTokenID`. Nodes that omit the
 *     convenience field still produce this, so it is a real portability
 *     difference, not a hypothetical one.
 */
export function recoverNftokenId(
  meta: Record<string, any> | undefined,
  body: Record<string, any>,
): RecoveredNftokenId {
  const direct = hex64(meta?.nftoken_id);
  if (direct) return { nftokenId: direct, source: "meta.nftoken_id" };

  const nodes = Array.isArray(meta?.AffectedNodes)
    ? (meta.AffectedNodes as Record<string, any>[])
    : [];
  const deletedOffers = nodes
    .map((node) => node.DeletedNode as Record<string, any> | undefined)
    .filter((node): node is Record<string, any> => node?.LedgerEntryType === "NFTokenOffer");

  // A brokered accept deletes two offers (both name the same token). Prefer
  // the one this transaction actually named; its LedgerIndex *is* the offer id.
  const named = [body.NFTokenSellOffer, body.NFTokenBuyOffer]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toUpperCase());
  const preferred = deletedOffers.find((node) =>
    named.includes(String(node.LedgerIndex ?? "").toUpperCase()),
  );

  for (const node of preferred ? [preferred, ...deletedOffers] : deletedOffers) {
    const id = hex64(node.FinalFields?.NFTokenID) ?? hex64(node.PreviousFields?.NFTokenID);
    if (id) return { nftokenId: id, source: "affected_nodes" };
  }

  return { source: "none" };
}

// ---------------------------------------------------------------------------
// Finding an accept nobody told us about
// ---------------------------------------------------------------------------

/**
 * The transaction hash, whichever API version the node speaks.
 *
 * account_tx puts it at the top of the entry in API v2 and inside the
 * transaction body in v1, and a node that has been failed over to mid-session
 * may not be the one that answered last time.
 */
function accountTxHash(entry: Record<string, any>, body: Record<string, any>): string | undefined {
  return hex64(entry.hash) ?? hex64(body.hash);
}

/**
 * Find the transaction in which `address` accepted `offerId`.
 *
 * WHY THIS EXISTS. The desk learns an attendee signed by asking Xaman about
 * the payload it created, and that payload id lives in one browser tab. Reload
 * the page, hand the desk to the next volunteer, or scan a code off a card
 * that was issued ten minutes ago, and the id is gone — while the badge sits
 * accepted on the ledger and the claim row says `pending` forever. The chain
 * is the record; this reads it back.
 *
 * A HINT, NOT A VERDICT. The hash returned here goes straight into
 * `verifyClaim`, which re-reads the transaction and runs all five checks. This
 * function deciding wrongly cannot record a false attendance — the worst it
 * can do is hand over a hash that then fails verification.
 *
 * Returns `undefined` when the accept is not in the window searched, which
 * includes the ordinary case of an offer that was cancelled rather than taken.
 */
export async function findAcceptTxHash(
  gateway: XrplGateway,
  input: { address: string; offerId: string; limit?: number },
): Promise<string | undefined> {
  const offerId = String(input.offerId ?? "").trim().toUpperCase();
  if (!HASH_RE.test(offerId)) {
    throw new ValidationError(
      "INVALID_INPUT",
      `"${input.offerId}" is not a 64-character hex offer id`,
      { offerId: input.offerId },
    );
  }

  // The attendee's own history, newest first. An accept is the FIRST thing a
  // fresh badge wallet does after being funded, so the default window is
  // generous for a desk and still one round trip.
  let result: Record<string, any>;
  try {
    result = unwrapResult(
      await gateway.request({
        command: "account_tx",
        account: input.address,
        ledger_index_min: -1,
        ledger_index_max: -1,
        limit: input.limit ?? 40,
        forward: false,
      }),
    );
  } catch (err) {
    // A wallet the node has never seen has no accepts in it. That is an
    // answer, not a failure — an attendee can be scanned before they are
    // funded, and the desk asks about them on every poll.
    if (isRippledError(err, "actNotFound")) return undefined;
    throw new XrplLayerError(
      "LEDGER_QUERY_FAILED",
      `account_tx for ${input.address} failed: ${err instanceof Error ? err.message : String(err)}`,
      { method: "account_tx", address: input.address },
    );
  }

  if (typeof result.error === "string") {
    if (result.error === "actNotFound") return undefined;
    throw new XrplLayerError(
      "LEDGER_QUERY_FAILED",
      `account_tx for ${input.address} failed: ${result.error}`,
      { method: "account_tx", address: input.address, rippledError: result.error },
    );
  }

  const entries: Record<string, any>[] = Array.isArray(result.transactions)
    ? result.transactions
    : [];

  for (const entry of entries) {
    const body: Record<string, any> = entry.tx ?? entry.tx_json ?? {};
    if (body.TransactionType !== "NFTokenAcceptOffer") continue;
    if (sellOfferIdOf(body) !== offerId) continue;

    // A failed accept consumed a fee and nothing else. Reporting its hash
    // would send verifyClaim off to fail check 4 and make the desk say the
    // ledger disagreed, when the truth is simply that they have not accepted.
    const meta = entry.meta ?? entry.metaData;
    const engineResult = typeof meta === "object" && meta !== null
      ? (meta as Record<string, any>).TransactionResult
      : undefined;
    if (engineResult !== "tesSUCCESS") continue;

    const hash = accountTxHash(entry, body);
    if (hash) return hash;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// verifyClaim
// ---------------------------------------------------------------------------

/** True when nft_info was missing in a way the NFTokenID itself can cover. */
function isDegradable(err: unknown): boolean {
  if (!(err instanceof XrplLayerError)) return false;
  return err.details?.kind === "clio_method_unavailable" || err.code === "NOT_FOUND";
}

/**
 * The five assertions of brief section 6.4, in order, each recorded.
 *
 * 1. transactionFound      the hash resolves to a transaction
 * 2. isAcceptOffer         it is an NFTokenAcceptOffer
 * 3. submittedByAddress    the claimant signed it
 * 4. succeeded             tesSUCCESS and validated
 * 5. issuerAndTaxonMatch   the token it moved is ours, for this event
 *
 * Evaluation stops at the first failure. All five passing means attended —
 * `isBurned` and `currentOwner` are reported but never consulted.
 */
export async function verifyClaim(
  gateway: XrplGateway,
  input: VerifyClaimInput,
): Promise<VerifyClaimResult> {
  assertValidTaxon(input.eventId);

  const checks: VerificationChecks = {
    transactionFound: false,
    isAcceptOffer: false,
    submittedByAddress: false,
    succeeded: false,
    issuerAndTaxonMatch: false,
  };

  const fail = (
    failedCheck: keyof VerificationChecks,
    reason: string,
    extra: Partial<VerifyClaimResult> = {},
  ): VerifyClaimResult => ({
    attended: false,
    status: "not_attended",
    checks,
    failedCheck,
    reason,
    ...extra,
  });

  // --- 1. transactionFound -------------------------------------------------
  const txHash = String(input.txHash ?? "").trim().toUpperCase();
  if (!HASH_RE.test(txHash)) {
    // A pasted-in typo is a bad claim, not a fault. Do not spend a round trip.
    return fail(
      "transactionFound",
      `"${input.txHash}" is not a 64-character hex transaction hash`,
    );
  }

  let result: Record<string, any>;
  try {
    result = unwrapResult(await gateway.request({ command: "tx", transaction: txHash }));
  } catch (err) {
    if (isRippledError(err, "txnNotFound")) {
      // NOT YET, not no. A confirm fired off the back of a Xaman signature
      // beats the ledger it is asking about, every time, for a few seconds.
      return fail(
        "transactionFound",
        `No transaction ${txHash} on this ledger yet. Either it has not been validated, the claim was never submitted, or this node's history does not reach back far enough.`,
        { notYet: true },
      );
    }
    throw new XrplLayerError(
      "LEDGER_QUERY_FAILED",
      `tx lookup for ${txHash} failed: ${err instanceof Error ? err.message : String(err)}`,
      { method: "tx", txHash },
    );
  }

  if (typeof result.error === "string") {
    if (result.error === "txnNotFound") {
      return fail("transactionFound", `No transaction ${txHash} on this ledger yet.`, {
        notYet: true,
      });
    }
    throw new XrplLayerError(
      "LEDGER_QUERY_FAILED",
      `tx lookup for ${txHash} failed: ${result.error}`,
      { method: "tx", txHash, rippledError: result.error },
    );
  }

  const body = txBodyOf(result);
  const meta = metaOf(result, body);
  const ledgerIndexRaw = result.ledger_index ?? body.ledger_index ?? body.inLedger;
  const ledgerIndex = typeof ledgerIndexRaw === "number" ? ledgerIndexRaw : undefined;

  // From here on there is a transaction body in hand, so these ride along on
  // *every* outcome below — including the failures. A rejected verdict that
  // names the offer it looked at is auditable after the fact; one that does
  // not is a shrug. Note this is the chain's copy of the offer id, which is
  // the whole point: callers should persist this and not their own input.
  const found: Partial<VerifyClaimResult> = {};
  if (ledgerIndex !== undefined) found.ledgerIndex = ledgerIndex;
  const sellOfferId = sellOfferIdOf(body);
  if (sellOfferId !== undefined) found.sellOfferId = sellOfferId;

  if (typeof body.TransactionType !== "string") {
    return fail(
      "transactionFound",
      `The node returned no transaction body for ${txHash}. Neither the API v1 nor the API v2 shape was recognised (keys: ${Object.keys(result).join(", ")}).`,
      found,
    );
  }
  checks.transactionFound = true;

  // --- 2. isAcceptOffer ----------------------------------------------------
  if (body.TransactionType !== "NFTokenAcceptOffer") {
    return fail(
      "isAcceptOffer",
      `Transaction ${txHash} is a ${body.TransactionType}, not an NFTokenAcceptOffer. The attendance record is the accept, not the mint or the offer.`,
      found,
    );
  }
  checks.isAcceptOffer = true;

  // --- 3. submittedByAddress ----------------------------------------------
  // Holding the badge is not attendance; *accepting* it is. A wallet that was
  // handed the token some other way fails here, by design.
  if (body.Account !== input.address) {
    return fail(
      "submittedByAddress",
      `Transaction ${txHash} was submitted by ${String(body.Account)}, not by ${input.address}.`,
      found,
    );
  }
  checks.submittedByAddress = true;

  // --- 4. succeeded --------------------------------------------------------
  const engineResult = meta?.TransactionResult;
  const validated = (result.validated ?? body.validated) === true;
  if (engineResult !== "tesSUCCESS" || !validated) {
    // The second race, and the subtler one: the node HAS the transaction and
    // it succeeded, but the ledger holding it is not validated yet. That is a
    // few seconds, and it is not the same answer as tecNO_PERMISSION.
    const pending = engineResult === "tesSUCCESS" && !validated;
    return fail(
      "succeeded",
      meta === undefined
        ? `Transaction ${txHash} came back without decoded metadata, so its result cannot be confirmed.`
        : pending
          ? `Transaction ${txHash} succeeded but its ledger is not validated yet.`
          : `Transaction ${txHash} did not succeed on a validated ledger (result ${String(engineResult)}, validated ${String(validated)}).`,
      pending ? { ...found, notYet: true } : found,
    );
  }
  checks.succeeded = true;

  // --- 5. issuerAndTaxonMatch ---------------------------------------------
  const recovered = recoverNftokenId(meta, body);
  if (!recovered.nftokenId) {
    return fail(
      "issuerAndTaxonMatch",
      `Could not recover the NFTokenID from ${txHash}: metadata has no "nftoken_id" and no deleted NFTokenOffer node.`,
      found,
    );
  }
  const nftokenId = recovered.nftokenId;
  const expectedIssuer = input.issuerAddress ?? gateway.issuerAddress;

  let info: NftInfo | undefined;
  try {
    // nft_info over account_nfts on purpose: it answers for burned tokens.
    info = await getNftInfo(gateway, nftokenId);
  } catch (err) {
    if (!isDegradable(err)) throw err;
  }

  let issuerOk: boolean;
  let taxonOk: boolean;
  let actualIssuer: string;
  let actualTaxon: number;
  let isBurned: boolean | undefined;
  let currentOwner: string | undefined;
  let degradedNote: string | undefined;

  if (info) {
    issuerOk = info.issuer === expectedIssuer;
    taxonOk = info.taxon === input.eventId;
    actualIssuer = info.issuer;
    actualTaxon = info.taxon;
    isBurned = info.isBurned;
    currentOwner = info.owner === "" ? undefined : info.owner;
  } else {
    // DEGRADED PATH: no nft_info on this endpoint. The NFTokenID encodes the
    // issuer and the taxon, so the two assertions that matter still hold —
    // but burn status and current owner are unknowable here, and unknown burn
    // status cannot make someone un-attend.
    let decoded: DecodedNftokenId;
    try {
      decoded = decodeNftokenId(nftokenId);
    } catch {
      return fail(
        "issuerAndTaxonMatch",
        `Recovered NFTokenID "${nftokenId}" from ${txHash} is malformed and nft_info is unavailable on this endpoint.`,
        { ...found, nftokenId },
      );
    }
    issuerOk = decodedIssuerMatches(decoded, expectedIssuer);
    taxonOk = decoded.taxon === input.eventId;
    actualIssuer = decoded.issuer ?? decoded.issuerAccountIdHex;
    actualTaxon = decoded.taxon;
    degradedNote =
      `Degraded verification: nft_info is unavailable on this endpoint, so the issuer and taxon ` +
      `were decoded from the NFTokenID itself rather than read from the ledger. Burn status and ` +
      `current owner are unknown; neither affects attendance.`;
  }

  const informational: Partial<VerifyClaimResult> = {
    ...found,
    nftokenId,
    nftokenIdSource: recovered.source,
  };
  if (degradedNote) informational.degraded = true;
  if (isBurned !== undefined) informational.isBurned = isBurned;
  if (currentOwner !== undefined) informational.currentOwner = currentOwner;

  if (!issuerOk || !taxonOk) {
    const problems: string[] = [];
    if (!issuerOk) problems.push(`issuer is ${actualIssuer}, expected ${expectedIssuer}`);
    if (!taxonOk) problems.push(`taxon is ${actualTaxon}, expected event ${input.eventId}`);
    return fail(
      "issuerAndTaxonMatch",
      `NFToken ${nftokenId} is not a badge for this event: ${problems.join("; ")}.`,
      informational,
    );
  }
  checks.issuerAndTaxonMatch = true;

  // --- attended ------------------------------------------------------------
  // isBurned selects the *label* only. It never touches `attended`.
  const notes: string[] = [];
  if (degradedNote) notes.push(degradedNote);
  if (isBurned === true) {
    notes.push(
      `Badge ${nftokenId} has since been burned. Attendance is an event, not a state — the claim still counts.`,
    );
  }

  const verified: VerifyClaimResult = {
    attended: true,
    status: isBurned === true ? "attended_badge_burned" : "attended",
    checks,
    nftokenId,
    nftokenIdSource: recovered.source,
    ...found,
  };
  // Machine-readable counterpart to the prose note: this verdict rests on the
  // NFTokenID's own bytes, not on a ledger read.
  if (degradedNote) verified.degraded = true;
  if (isBurned !== undefined) verified.isBurned = isBurned;
  if (currentOwner !== undefined) verified.currentOwner = currentOwner;
  if (notes.length > 0) verified.reason = notes.join(" ");
  return verified;
}
