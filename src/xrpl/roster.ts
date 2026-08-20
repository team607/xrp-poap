/**
 * Read-only ledger queries: the event roster, single-badge status, chain of
 * custody, and an account's live badges.
 *
 * Three of the four commands here (`nfts_by_issuer`, `nft_info`,
 * `nft_history`) are **Clio** methods. A plain rippled node — including the
 * default testnet endpoint wss://s.altnet.rippletest.net:51233 — does not
 * implement them and answers `unknownCmd`. That bare code is useless at demo
 * time, so every Clio call here translates it into an error that names the
 * method and the endpoints that do work. `account_nfts` is core rippled and
 * needs no Clio.
 *
 * None of this is the authoritative attendance answer. Section 4 of the brief:
 * attendance is an event, not a state. `verifyClaim()` in ./verify.ts is the
 * authority; everything here is a convenience view over the current ledger.
 */
import { rippleTimeToISOTime } from "xrpl";
import { AccountNotFoundError, NotFoundError, XrplLayerError } from "../errors.js";
import type {
  EventId,
  NftHistoryEntry,
  NftInfo,
  Roster,
  RosterEntry,
  XrplGateway,
} from "../types.js";
import { isRippledError } from "./client.js";
import { assertValidTaxon, decodeUri } from "./encoding.js";

/** Clio-enabled public endpoints, quoted verbatim in the unknownCmd error. */
export const CLIO_ENDPOINTS = {
  testnet: "wss://clio.altnet.rippletest.net:51233",
  mainnet: "wss://xrplcluster.com",
} as const;

/** Pages followed before a paginated query gives up and reports partial. */
const DEFAULT_MAX_PAGES = 20;

/**
 * account_nfts has no `maxPages` option in its signature, so it cannot report
 * partiality. It follows markers to exhaustion behind a loud safety cap
 * instead — 100 pages is >3000 badges on one account.
 */
const ACCOUNT_NFTS_MAX_PAGES = 100;

/** rippled's several ways of saying "I do not implement that command". */
const METHOD_MISSING_CODES = ["unknownCmd", "notImpl", "notSupported"];

// ---------------------------------------------------------------------------
// Response plumbing
// ---------------------------------------------------------------------------

/**
 * Unwraps the `{ id, result, type }` envelope that `client.request` returns,
 * tolerating a bare result object (which is what fakes and some transports
 * hand back).
 *
 * @internal shared with ./verify.ts
 */
export function unwrapResult(response: unknown): Record<string, any> {
  if (!response || typeof response !== "object") return {};
  const envelope = response as Record<string, any>;
  const inner = envelope.result;
  if (inner && typeof inner === "object") return inner as Record<string, any>;
  return envelope;
}

/** The rippled error code carried on a thrown response, when there is one. */
function rippledErrorCode(err: unknown): string | undefined {
  const data = (err as { data?: { error?: string } } | undefined)?.data;
  return typeof data?.error === "string" ? data.error : undefined;
}

/** True when the node answered "I have never heard of that command". */
function isMethodMissing(err: unknown): boolean {
  return METHOD_MISSING_CODES.some((code) => isRippledError(err, code));
}

/**
 * The actionable version of `unknownCmd`. Carries
 * `details.kind === "clio_method_unavailable"` so verifyClaim can recognise it
 * precisely and degrade instead of failing.
 *
 * @internal shared with ./verify.ts
 */
export function clioUnavailableError(method: string, err?: unknown): XrplLayerError {
  const code = rippledErrorCode(err) ?? "unknownCmd";
  return new XrplLayerError(
    "LEDGER_QUERY_FAILED",
    `The "${method}" command is not available on this endpoint (the node answered "${code}"). ` +
      `nft_info, nft_history and nfts_by_issuer are Clio methods; a plain rippled node ` +
      `does not implement them. Point XRPL_ENDPOINT at a Clio-enabled server: ` +
      `${CLIO_ENDPOINTS.testnet} (testnet) or ${CLIO_ENDPOINTS.mainnet} (mainnet).`,
    {
      kind: "clio_method_unavailable",
      method,
      rippledError: code,
      clioTestnet: CLIO_ENDPOINTS.testnet,
      clioMainnet: CLIO_ENDPOINTS.mainnet,
    },
  );
}

/** Wraps any other transport-level failure so src/ only ever throws typed errors. */
function queryFailed(method: string, err: unknown): XrplLayerError {
  const code = rippledErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  return new XrplLayerError("LEDGER_QUERY_FAILED", `${method} failed: ${message}`, {
    method,
    rippledError: code,
  });
}

/** One request, with the Clio guard applied. `translate` handles expected codes. */
async function query(
  gateway: XrplGateway,
  method: string,
  payload: Record<string, unknown>,
  translate?: (err: unknown) => XrplLayerError | undefined,
): Promise<Record<string, any>> {
  let raw: unknown;
  try {
    raw = await gateway.request({ command: method, ...payload });
  } catch (err) {
    if (isMethodMissing(err)) throw clioUnavailableError(method, err);
    const translated = translate?.(err);
    if (translated) throw translated;
    throw queryFailed(method, err);
  }

  // Some transports resolve with an error body instead of rejecting.
  const result = unwrapResult(raw);
  const inlineError = typeof result.error === "string" ? result.error : undefined;
  if (inlineError) {
    const shaped = Object.assign(new Error(inlineError), { data: { error: inlineError } });
    if (isMethodMissing(shaped)) throw clioUnavailableError(method, shaped);
    const translated = translate?.(shaped);
    if (translated) throw translated;
    throw queryFailed(method, shaped);
  }
  return result;
}

/** Two markers are the same when they serialise the same. */
function markersEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Follows `marker` until the ledger stops handing one back or `maxPages` is
 * reached. A returned `marker` means the walk stopped early and the caller is
 * holding a partial answer.
 */
async function paginate<T>(
  fetchPage: (marker: unknown) => Promise<Record<string, any>>,
  extract: (page: Record<string, any>) => T[],
  maxPages: number,
): Promise<{ items: T[]; marker?: unknown }> {
  const items: T[] = [];
  let marker: unknown;

  for (let page = 0; page < Math.max(1, maxPages); page++) {
    const result = await fetchPage(marker);
    items.push(...extract(result));

    const next = (result as Record<string, unknown>).marker;
    if (next === undefined || next === null) return { items };
    // A node that repeats a marker would spin this loop forever.
    if (markersEqual(next, marker)) return { items };
    marker = next;
  }

  return { items, marker };
}

function asArray(value: unknown): Record<string, any>[] {
  return Array.isArray(value) ? (value as Record<string, any>[]) : [];
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/**
 * `Roster` plus the one fact the shared type has no field for: how many
 * entries came back with no owner at all.
 */

/**
 * Every badge minted for one event, with who holds it now.
 *
 * `claimed` is `owner !== issuer`: a badge still sitting with the issuer has
 * not been picked up. A **burned badge still counts as claimed** if it ever
 * left the issuer, because the last owner is retained after a burn — which is
 * exactly the section 4 rule applied to the aggregate.
 *
 * UNKNOWN OWNERSHIP IS ITS OWN STATE. A missing `owner` used to default to the
 * issuer, which computed `claimed: false` — so a badge that may well have been
 * claimed was reported as definitely unclaimed, the one direction this module
 * must not get wrong. Now a missing owner leaves both `owner` and `claimed`
 * undefined, and the aggregates follow deliberately:
 *
 *   - `claimed` counts ONLY entries known to have left the issuer. The count
 *     never invents a claim it cannot see.
 *   - that alone would bury the unknowns, because anyone computing
 *     `minted - claimed` would read them as unclaimed. So they are surfaced as
 *     `ownerUnknown` instead of being absorbed into a count.
 *
 * These counts are a convenience for dashboards. They are derived from current
 * ledger state and are *not* the authoritative attendance answer;
 * `verifyClaim()` is.
 */
export async function getRoster(
  gateway: XrplGateway,
  eventId: EventId,
  opts: { issuerAddress?: string; maxPages?: number; limit?: number } = {},
): Promise<Roster> {
  assertValidTaxon(eventId);

  const issuer = opts.issuerAddress ?? gateway.issuerAddress;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  const { items, marker } = await paginate<Record<string, any>>(
    (pageMarker) => {
      const payload: Record<string, unknown> = { issuer, nft_taxon: eventId };
      if (opts.limit !== undefined) payload.limit = opts.limit;
      if (pageMarker !== undefined) payload.marker = pageMarker;
      return query(gateway, "nfts_by_issuer", payload);
    },
    (page) => asArray(page.nfts),
    maxPages,
  );

  const entries: RosterEntry[] = items.map((nft) => {
    // No owner from the node means UNKNOWN, never "the issuer still holds it".
    // asString() maps "" to undefined as well, so an empty owner is unknown too
    // — an empty string must never reach a `claimed` comparison.
    const owner = asString(nft.owner);
    const entry: RosterEntry = {
      nftokenId: (asString(nft.nft_id) ?? asString(nft.NFTokenID) ?? "").toUpperCase(),
      isBurned: nft.is_burned === true,
      taxon: asNumber(nft.nft_taxon ?? nft.NFTokenTaxon, eventId),
      serial: asNumber(nft.nft_serial ?? nft.serial),
      uri: decodeUri(asString(nft.uri) ?? asString(nft.URI)),
    };
    // Both fields together, or neither: `claimed` is only meaningful when there
    // is an owner to compare against.
    if (owner !== undefined) {
      entry.owner = owner;
      entry.claimed = owner !== issuer;
    }
    return entry;
  });

  const roster: Roster = {
    eventId,
    issuer,
    entries,
    minted: entries.length,
    // `=== true` on purpose: `undefined` is unknown, not unclaimed, and a
    // truthiness test would silently lump the two together.
    claimed: entries.filter((e) => e.claimed === true).length,
    burned: entries.filter((e) => e.isBurned).length,
    ownerUnknown: entries.filter((e) => e.owner === undefined).length,
  };
  // Only set when the walk stopped early, so callers can tell partial from complete.
  if (marker !== undefined) roster.marker = marker;
  return roster;
}

// ---------------------------------------------------------------------------
// Single badge
// ---------------------------------------------------------------------------

/**
 * Status of one badge. Works on **burned** tokens, which is the whole reason
 * verification prefers it over `account_nfts`.
 *
 * `owner` is `undefined` when the node reported none — unknown, never an
 * empty string standing in for one. Do not compare an absent owner to the
 * issuer.
 */
export async function getNftInfo(gateway: XrplGateway, nftokenId: string): Promise<NftInfo> {
  const id = nftokenId.trim().toUpperCase();
  const result = await query(gateway, "nft_info", { nft_id: id }, (err) =>
    isRippledError(err, "objectNotFound")
      ? new NotFoundError(`No NFT ${id} known to this node`, { nftokenId: id })
      : undefined,
  );

  return {
    nftokenId: (asString(result.nft_id) ?? id).toUpperCase(),
    // A burned token keeps its last owner on Clio (measured), but do not
    // assume the field: absent means unknown.
    owner: asString(result.owner),
    issuer: asString(result.issuer) ?? "",
    taxon: asNumber(result.nft_taxon),
    serial: asNumber(result.nft_serial),
    isBurned: result.is_burned === true,
    uri: decodeUri(asString(result.uri) ?? asString(result.URI)),
    flags: asNumber(result.flags),
  };
}

// ---------------------------------------------------------------------------
// Chain of custody
// ---------------------------------------------------------------------------

/** Human-readable change type, falling back to the raw TransactionType. */
function describeChange(transactionType: string | undefined): string {
  switch (transactionType) {
    case "NFTokenMint":
      return "mint";
    case "NFTokenBurn":
      return "burn";
    case "NFTokenAcceptOffer":
      return "transfer";
    case "NFTokenCreateOffer":
      return "offer_created";
    case "NFTokenCancelOffer":
      return "offer_cancelled";
    case "NFTokenModify":
      return "modify";
    default:
      return transactionType ?? "unknown";
  }
}

/** Owner of the NFTokenOffer this transaction consumed, from the deleted node. */
function deletedOfferOwner(meta: Record<string, any> | undefined): string | undefined {
  for (const node of asArray(meta?.AffectedNodes)) {
    const deleted = node.DeletedNode;
    if (deleted?.LedgerEntryType !== "NFTokenOffer") continue;
    const owner = asString(deleted.FinalFields?.Owner) ?? asString(deleted.PreviousFields?.Owner);
    if (owner) return owner;
  }
  return undefined;
}

function isoTimestamp(entry: Record<string, any>, body: Record<string, any>): string | undefined {
  const iso = asString(entry.close_time_iso) ?? asString(body.close_time_iso);
  if (iso) return iso;
  const rippleDate = body.date ?? entry.date;
  if (typeof rippleDate !== "number") return undefined;
  try {
    return rippleTimeToISOTime(rippleDate);
  } catch {
    return undefined;
  }
}

/**
 * Mint through transfers through burn.
 *
 * The ledger returns **successful transactions only** — a failed accept never
 * appears here, so absence of an entry is not evidence a claim was attempted.
 * The tesSUCCESS filter below is belt-and-braces on that guarantee.
 *
 * ORDER: **newest first**, exactly as the ledger returns it. Measured on Clio
 * testnet (docs/ground-truth.md): a minted-claimed-burned badge comes back as
 * NFTokenBurn -> NFTokenAcceptOffer -> NFTokenCreateOffer -> NFTokenMint. The
 * mint is the *last* element, not the first.
 *
 * This order is deliberately preserved rather than normalised to ascending.
 * Pagination also walks newest-first, so a walk cut short by `maxPages` drops
 * the *oldest* entries; re-sorting ascending would silently produce a list
 * whose first element looks like an origin but is not. Callers who want
 * chronological order should sort by `ledgerIndex` themselves and check
 * whether the mint is present.
 */
export async function getNftHistory(
  gateway: XrplGateway,
  nftokenId: string,
  opts: { maxPages?: number } = {},
): Promise<NftHistoryEntry[]> {
  const id = nftokenId.trim().toUpperCase();
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  const { items } = await paginate<Record<string, any>>(
    (pageMarker) => {
      const payload: Record<string, unknown> = { nft_id: id };
      if (pageMarker !== undefined) payload.marker = pageMarker;
      return query(gateway, "nft_history", payload, (err) =>
        isRippledError(err, "objectNotFound")
          ? new NotFoundError(`No NFT ${id} known to this node`, { nftokenId: id })
          : undefined,
      );
    },
    (page) => asArray(page.transactions),
    maxPages,
  );

  const history: NftHistoryEntry[] = [];

  for (const entry of items) {
    // v2 nests the transaction under tx_json, v1 under tx.
    const body: Record<string, any> =
      (entry.tx_json as Record<string, any> | undefined) ??
      (entry.tx as Record<string, any> | undefined) ??
      entry;
    const meta = (entry.meta ?? entry.metaData ?? body.meta) as Record<string, any> | undefined;

    const engineResult = asString(meta?.TransactionResult);
    if (engineResult && engineResult !== "tesSUCCESS") continue;

    const transactionType = asString(body.TransactionType);
    const account = asString(body.Account);
    const offerOwner = deletedOfferOwner(meta);

    const record: NftHistoryEntry = {
      txHash: (asString(entry.hash) ?? asString(body.hash) ?? "").toUpperCase(),
      ledgerIndex: asNumber(entry.ledger_index ?? body.ledger_index ?? body.inLedger),
      changeType: describeChange(transactionType),
    };

    if (transactionType === "NFTokenMint") {
      record.owner = asString(body.Issuer) ?? account;
    } else if (transactionType === "NFTokenBurn") {
      record.owner = asString(body.Owner) ?? account;
    } else if (transactionType === "NFTokenAcceptOffer") {
      // Accepting a *sell* offer makes the submitter the buyer; accepting a
      // *buy* offer makes them the seller. Our flow only ever uses the former.
      const acceptedSellOffer = asString(body.NFTokenSellOffer) !== undefined;
      record.buyer = acceptedSellOffer ? account : offerOwner;
      record.seller = acceptedSellOffer ? offerOwner : account;
      record.owner = record.buyer;
    } else if (account) {
      record.owner = account;
    }

    const timestamp = isoTimestamp(entry, body);
    if (timestamp) record.timestamp = timestamp;

    history.push(record);
  }

  return history;
}

// ---------------------------------------------------------------------------
// Live holdings (core rippled — no Clio needed)
// ---------------------------------------------------------------------------

/**
 * The badges an account holds **right now**. This is the query the step-1
 * smoke test uses to confirm a claim landed.
 *
 * It is deliberately *not* used by verification: it cannot see a burned badge,
 * and a burned badge is still attendance.
 */
export async function getAccountNfts(
  gateway: XrplGateway,
  address: string,
): Promise<NftInfo[]> {
  const { items, marker } = await paginate<Record<string, any>>(
    (pageMarker) => {
      const payload: Record<string, unknown> = { account: address, ledger_index: "validated" };
      if (pageMarker !== undefined) payload.marker = pageMarker;
      return query(gateway, "account_nfts", payload, (err) =>
        isRippledError(err, "actNotFound") ? new AccountNotFoundError(address) : undefined,
      );
    },
    (page) => asArray(page.account_nfts),
    ACCOUNT_NFTS_MAX_PAGES,
  );

  if (marker !== undefined) {
    throw new XrplLayerError(
      "LEDGER_QUERY_FAILED",
      `account_nfts for ${address} did not finish within ${ACCOUNT_NFTS_MAX_PAGES} pages`,
      { method: "account_nfts", address, maxPages: ACCOUNT_NFTS_MAX_PAGES },
    );
  }

  // account_nfts uses the canonical field names, not Clio's snake_case ones.
  return items.map((nft) => ({
    nftokenId: (asString(nft.NFTokenID) ?? asString(nft.nft_id) ?? "").toUpperCase(),
    owner: address,
    issuer: asString(nft.Issuer) ?? "",
    taxon: asNumber(nft.NFTokenTaxon ?? nft.nft_taxon),
    serial: asNumber(nft.nft_serial ?? nft.NFTokenSerial),
    // account_nfts can only ever list live tokens; a burn removes the entry.
    isBurned: false,
    uri: decodeUri(asString(nft.URI) ?? asString(nft.uri)),
    flags: asNumber(nft.Flags),
  }));
}
