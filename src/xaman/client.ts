/**
 * Xaman (XUMM) signing service.
 *
 * The attendee signs `NFTokenAcceptOffer` themselves (brief 5.3) — we never see
 * their key. This module turns a claim into something their phone can approve
 * and lets us ask Xaman what happened afterwards. What actually happened is
 * still decided by the ledger, not by Xaman; see src/xrpl/verify.ts.
 */
import { XummSdk } from "xumm-sdk";
import { ConnectionError, NotFoundError, XrplLayerError } from "../errors.js";
import {
  CLAIM_PAYLOAD_EXPIRE_MINUTES,
  buildClaimSignRequest,
  type ClaimSignRequestParams,
} from "./payloads.js";

/** Everything the API hands back to a browser so it can show a QR / deeplink. */
export interface XamanClaimRequest {
  uuid: string;
  /** data: URI of the QR code PNG. */
  qrPng: string;
  /** Open-in-Xaman URL. */
  deeplink: string;
  /** Websocket the browser can watch for the signature result. */
  websocket: string;
  expiresAt: string;
}

export interface XamanPayloadStatus {
  resolved: boolean;
  signed: boolean;
  txHash?: string;
  account?: string;
}

export interface XamanService {
  createClaimRequest(params: ClaimSignRequestParams): Promise<XamanClaimRequest>;
  getPayload(uuid: string): Promise<XamanPayloadStatus>;
}

// ---------------------------------------------------------------------------
// The real thing
// ---------------------------------------------------------------------------

/** The slice of XummSdk we use, structural so a test can inject a fake. */
export interface XummSdkLike {
  payload: {
    create(payload: unknown, returnErrors?: boolean): Promise<XummCreatedPayload | null>;
    get(uuid: unknown, returnErrors?: boolean): Promise<XummFetchedPayload | null>;
  };
}

export interface XummCreatedPayload {
  uuid: string;
  next: { always: string };
  refs: { qr_png: string; websocket_status: string };
}

export interface XummFetchedPayload {
  meta: { resolved: boolean; signed: boolean };
  response: { txid?: string | null; account?: string | null };
}

export interface XummXamanServiceOptions {
  apiKey: string;
  apiSecret: string;
  /** Injected in tests. Defaults to a real XummSdk. */
  sdk?: XummSdkLike;
}

export class XummXamanService implements XamanService {
  private readonly sdk: XummSdkLike;

  constructor(options: XummXamanServiceOptions) {
    const { apiKey, apiSecret, sdk } = options;
    if (!sdk && (!apiKey || !apiSecret)) {
      throw new XrplLayerError(
        "CONFIG_INVALID",
        "XummXamanService needs both an API key and an API secret.",
      );
    }
    this.sdk = sdk ?? new XummSdk(apiKey, apiSecret);
  }

  async createClaimRequest(params: ClaimSignRequestParams): Promise<XamanClaimRequest> {
    const request = buildClaimSignRequest(params);

    let created: XummCreatedPayload | null;
    try {
      created = await this.sdk.payload.create(request);
    } catch (err) {
      // The API secret can appear in transport-level errors. Never re-attach it.
      throw new ConnectionError("Xaman rejected the sign request", {
        reason: (err as Error).message,
        eventId: params.eventId,
      });
    }

    if (!created) {
      throw new ConnectionError("Xaman returned no payload for the sign request", {
        eventId: params.eventId,
      });
    }

    return {
      uuid: created.uuid,
      qrPng: created.refs.qr_png,
      deeplink: created.next.always,
      websocket: created.refs.websocket_status,
      expiresAt: new Date(Date.now() + CLAIM_PAYLOAD_EXPIRE_MINUTES * 60_000).toISOString(),
    };
  }

  async getPayload(uuid: string): Promise<XamanPayloadStatus> {
    let payload: XummFetchedPayload | null;
    try {
      payload = await this.sdk.payload.get(uuid);
    } catch (err) {
      throw new ConnectionError("Could not read the Xaman payload", {
        reason: (err as Error).message,
        uuid,
      });
    }

    if (!payload) throw new NotFoundError(`No Xaman payload ${uuid}`, { uuid });

    const txHash = payload.response.txid ?? undefined;
    const account = payload.response.account ?? undefined;
    return {
      resolved: payload.meta.resolved,
      signed: payload.meta.signed,
      ...(txHash ? { txHash } : {}),
      ...(account ? { account } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// The no-keys fallback
// ---------------------------------------------------------------------------

const NOT_CONFIGURED =
  "Xaman is not configured (XUMM_API_KEY / XUMM_API_SECRET are unset). " +
  "The claim can still be completed by submitting the accept payload returned " +
  "with the claim from any XRPL wallet, then calling the confirm endpoint with " +
  "the resulting transaction hash.";

/**
 * Used when no Xaman keys are present. The server must start and every route
 * except phone-signing must work, so this fails loudly only if someone actually
 * tries to use it.
 */
export class NullXamanService implements XamanService {
  async createClaimRequest(_params: ClaimSignRequestParams): Promise<XamanClaimRequest> {
    throw new XrplLayerError("CONFIG_INVALID", NOT_CONFIGURED);
  }

  async getPayload(_uuid: string): Promise<XamanPayloadStatus> {
    throw new XrplLayerError("CONFIG_INVALID", NOT_CONFIGURED);
  }
}
