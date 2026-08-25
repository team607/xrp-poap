/**
 * Xaman (XUMM) payload construction and webhook parsing.
 *
 * Pure data transforms: no network, no SDK, no config, no ledger. The signing
 * request an attendee sees on their phone is built here so that exactly what we
 * ask them to sign is unit testable in isolation.
 */
import { isValidClassicAddress } from "xrpl";
import { z } from "zod";
import { ValidationError } from "../errors.js";
import {
  MAX_TAXON,
  type AcceptOfferPayload,
  type EventId,
  type NetworkName,
} from "../types.js";

/**
 * Minutes the attendee has to approve the request in Xaman. Long enough to dig
 * a phone out of a pocket in a queue, short enough that a stale QR code left on
 * a screen is worthless.
 */
export const CLAIM_PAYLOAD_EXPIRE_MINUTES = 10;

/** Offer ids and transaction hashes are both 64 uppercase hex characters. */
const HEX64 = /^[0-9A-Fa-f]{64}$/;

// ---------------------------------------------------------------------------
// Outgoing: the sign request
// ---------------------------------------------------------------------------

export interface ClaimSignRequestParams {
  offerId: string;
  attendeeAddress: string;
  eventId: EventId;
  /** Attribution tag stamped on the transaction the attendee signs. */
  sourceTag?: number;
  /** Shown to the attendee in the Xaman instruction line. */
  badgeName?: string;
  returnUrl?: { app?: string; web?: string };
}

/** The envelope posted to POST https://xumm.app/api/v1/platform/payload. */
export interface XamanClaimSignRequest {
  txjson: AcceptOfferPayload;
  options: {
    /** Xaman submits the signed blob to the ledger for us. */
    submit: true;
    expire: number;
    return_url?: { app?: string; web?: string };
    /**
     * Pins the payload to a network — "MAINNET" | "TESTNET" | "DEVNET".
     *
     * WITHOUT THIS A TESTNET PAYLOAD IS SIGNED AGAINST MAINNET. Xaman uses
     * whatever network the signer's app is set to, which is mainnet for
     * almost everyone, so an NFTokenAcceptOffer for a testnet offer fails
     * with "unable to find the offer object" — a message that reads like a
     * broken offer rather than a missing field on the payload.
     */
    force_network?: string;
  };
  custom_meta: {
    identifier: string;
    blob: XamanClaimBlob;
    instruction: string;
  };
}

/** What we stash on the payload so a webhook can be tied back to an event. */
export interface XamanClaimBlob extends Record<string, unknown> {
  kind: "poap-claim";
  eventId: EventId;
  offerId: string;
  attendeeAddress: string;
}

function assertEventId(eventId: EventId): void {
  if (!Number.isInteger(eventId) || eventId < 0 || eventId > MAX_TAXON) {
    throw new ValidationError(
      "INVALID_TAXON",
      `eventId must be an integer in [0, ${MAX_TAXON}], got ${String(eventId)}`,
      { eventId },
    );
  }
}

/**
 * The attendee-side transaction. Three fields, plus SourceTag when configured.
 *
 * No Fee, no Memos, no NFTokenBrokerFee, no Destination override — anything
 * beyond this is something a person signs without having been shown it.
 *
 * SourceTag is the single exception and the bar it clears is worth stating,
 * because it is the bar anything else would have to clear too: it moves no
 * funds, names no counterparty, changes no behaviour, and Xaman renders the
 * whole transaction to the attendee before they approve it. It is a label
 * saying which app produced the transaction. Nothing that fails those tests
 * belongs here.
 *
 * The shape is pinned by AcceptOfferPayload in src/types.ts, which is the same
 * contract buildAcceptOfferPayload() in src/xrpl/offers.ts returns, so the two
 * builders cannot drift apart.
 */
export function buildAcceptOfferTxjson(params: {
  offerId: string;
  attendeeAddress: string;
  /** Attribution tag. Omitted entirely when unset — never sent as 0. */
  sourceTag?: number;
}): AcceptOfferPayload {
  const { offerId, attendeeAddress, sourceTag } = params;

  if (!isValidClassicAddress(attendeeAddress)) {
    throw new ValidationError("INVALID_ADDRESS", `Not a valid XRPL classic address: ${attendeeAddress}`, {
      address: attendeeAddress,
    });
  }
  if (!HEX64.test(offerId)) {
    throw new ValidationError("INVALID_INPUT", "offerId must be 64 hex characters", { offerId });
  }

  return {
    TransactionType: "NFTokenAcceptOffer",
    Account: attendeeAddress,
    NFTokenSellOffer: offerId,
    ...(sourceTag === undefined ? {} : { SourceTag: sourceTag }),
  };
}

/**
 * Build the Xaman payload envelope for one attendee claiming one badge.
 *
 * `custom_meta.blob` is the only way a webhook delivery can be tied back to an
 * event, so it carries the ids — but it is echoed back to us by an untrusted
 * caller, so it is a hint and never evidence. See src/api/routes/xaman-webhook.ts.
 */
export function buildClaimSignRequest(params: ClaimSignRequestParams): XamanClaimSignRequest {
  const { offerId, attendeeAddress, eventId, badgeName, returnUrl, sourceTag } = params;
  assertEventId(eventId);

  const txjson = buildAcceptOfferTxjson({
    offerId,
    attendeeAddress,
    ...(sourceTag === undefined ? {} : { sourceTag }),
  });

  const request: XamanClaimSignRequest = {
    txjson,
    options: {
      submit: true,
      expire: CLAIM_PAYLOAD_EXPIRE_MINUTES,
    },
    custom_meta: {
      // Xaman caps the identifier and only accepts [A-Za-z0-9-_.]; keep it short.
      identifier: `poap-${eventId}-${offerId.slice(0, 8).toUpperCase()}`,
      blob: { kind: "poap-claim", eventId, offerId, attendeeAddress },
      instruction:
        `Claim your ${badgeName ?? "attendance badge"} for event ${eventId}. ` +
        "This badge is soulbound: it cannot be transferred or sold.",
    },
  };

  if (returnUrl && (returnUrl.app || returnUrl.web)) {
    request.options.return_url = {
      ...(returnUrl.app ? { app: returnUrl.app } : {}),
      ...(returnUrl.web ? { web: returnUrl.web } : {}),
    };
  }

  return request;
}

// ---------------------------------------------------------------------------
// Incoming: the webhook
// ---------------------------------------------------------------------------

export interface ParsedXamanWebhook {
  payloadUuid: string;
  signed: boolean;
  txHash?: string;
  account?: string;
  /** The attendee declined, or the payload expired unsigned. */
  rejected: boolean;
}

/**
 * Tolerant on purpose. Xaman's documented webhook body nests the interesting
 * fields under `payloadResponse` with the uuid duplicated in `meta`, while the
 * websocket message for the same event is flat. Both are accepted; unknown keys
 * are dropped.
 */
const webhookBodySchema = z.object({
  meta: z
    .object({ payload_uuidv4: z.string().min(1).optional() })
    .optional(),
  payloadResponse: z
    .object({
      payload_uuidv4: z.string().min(1).optional(),
      signed: z.boolean().optional(),
      txid: z.string().min(1).nullish(),
      account: z.string().min(1).nullish(),
    })
    .optional(),
  // Flat (websocket) shape.
  payload_uuidv4: z.string().min(1).optional(),
  signed: z.boolean().optional(),
  txid: z.string().min(1).nullish(),
  account: z.string().min(1).nullish(),
  custom_meta: z
    .object({
      identifier: z.string().nullish(),
      blob: z.unknown().optional(),
      instruction: z.string().nullish(),
    })
    .nullish(),
});

/**
 * Parse a Xaman webhook (or websocket) delivery.
 *
 * Throws ValidationError when the body is not recognisably a Xaman delivery.
 * A successful parse says nothing about whether the claim happened — only the
 * ledger does.
 */
export function parseXamanWebhook(body: unknown): ParsedXamanWebhook {
  const parsed = webhookBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("INVALID_INPUT", "Body is not a Xaman webhook payload", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const b = parsed.data;
  const payloadUuid = b.payloadResponse?.payload_uuidv4 ?? b.meta?.payload_uuidv4 ?? b.payload_uuidv4;
  const signed = b.payloadResponse?.signed ?? b.signed;

  if (!payloadUuid) {
    throw new ValidationError("INVALID_INPUT", "Xaman webhook has no payload uuid", {
      keys: typeof body === "object" && body !== null ? Object.keys(body) : [],
    });
  }
  if (typeof signed !== "boolean") {
    throw new ValidationError("INVALID_INPUT", "Xaman webhook has no `signed` flag", { payloadUuid });
  }

  const txHash = b.payloadResponse?.txid ?? b.txid ?? undefined;
  const account = b.payloadResponse?.account ?? b.account ?? undefined;

  return {
    payloadUuid,
    signed,
    ...(signed && txHash ? { txHash } : {}),
    ...(account ? { account } : {}),
    rejected: !signed,
  };
}

/**
 * Best-effort recovery of the ids we stashed in `custom_meta` when the payload
 * was created. Never throws: everything here is an untrusted hint that is about
 * to be checked against the ledger, so a missing or malformed value is simply
 * absent rather than an error.
 */
export interface XamanClaimHints {
  eventId?: EventId;
  offerId?: string;
  attendeeAddress?: string;
}

export function parseXamanClaimMeta(body: unknown): XamanClaimHints {
  const parsed = webhookBodySchema.safeParse(body);
  if (!parsed.success || !parsed.data.custom_meta) return {};

  const { blob, identifier } = parsed.data.custom_meta;

  // Xaman round-trips the blob as an object, but some integrations post it back
  // as a JSON string.
  let raw: unknown = blob;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = undefined;
    }
  }

  const blobSchema = z.object({
    eventId: z.number().int().min(0).max(MAX_TAXON).optional(),
    offerId: z.string().regex(HEX64).optional(),
    attendeeAddress: z.string().refine(isValidClassicAddress).optional(),
  });
  const fromBlob = blobSchema.safeParse(raw);

  const hints: XamanClaimHints = fromBlob.success
    ? {
        ...(fromBlob.data.eventId !== undefined ? { eventId: fromBlob.data.eventId } : {}),
        ...(fromBlob.data.offerId ? { offerId: fromBlob.data.offerId } : {}),
        ...(fromBlob.data.attendeeAddress ? { attendeeAddress: fromBlob.data.attendeeAddress } : {}),
      }
    : {};

  // Fall back to the identifier we minted above: poap-<eventId>-<offerprefix>.
  if (hints.eventId === undefined && typeof identifier === "string") {
    const match = /^poap-(\d{1,10})-/.exec(identifier);
    const digits = match?.[1];
    if (digits) {
      const eventId = Number.parseInt(digits, 10);
      if (Number.isInteger(eventId) && eventId >= 0 && eventId <= MAX_TAXON) hints.eventId = eventId;
    }
  }

  return hints;
}

/** Xaman's `force_network` string for one of our networks. */
export function xamanForceNetwork(network: NetworkName): string {
  switch (network) {
    case "mainnet":
      return "MAINNET";
    case "devnet":
      return "DEVNET";
    default:
      return "TESTNET";
  }
}
