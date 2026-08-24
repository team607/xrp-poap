/**
 * Xaman SignIn — proving an attendee controls the wallet they register.
 *
 * A registration form with an address field collects a CLAIM. A SignIn payload
 * collects PROOF: the attendee opens Xaman, approves a request that is not a
 * transaction, and Xaman tells us which account held the key that signed it.
 *
 * Two failures are avoided by insisting on the proof, and both are permanent:
 *
 *   - someone registering an address that is not theirs, which at the desk
 *     hands a stranger's wallet the badge;
 *   - a typo. A badge is soulbound (CLAUDE.md): minted with `tfTransferable`
 *     unset, it can never be moved off the address it was offered to. A
 *     mistyped address is a badge minted to a wallet nobody controls, and there
 *     is no recovery — only a burn.
 *
 * A SignIn COSTS THE USER NOTHING. It is not an XRPL transaction: no fee, no
 * sequence, no ledger state changes, nothing is submitted. It is a signature
 * over a challenge, and the only thing it produces is the signing account. That
 * is the whole reason it is safe to put behind a public, unauthenticated route:
 * the worst an attacker can do by hammering it is create payloads nobody signs.
 *
 * What comes back from Xaman is still an external string. `resolve()` treats it
 * as one — see the two guards there.
 */
import { XummSdk } from "xumm-sdk";
import { ConnectionError, NotFoundError, XrplLayerError } from "../errors.js";
import type { EventId } from "../types.js";
import { assertValidAddress, assertValidTaxon } from "../xrpl/encoding.js";
import type { XummCreatedPayload } from "./client.js";

/**
 * Minutes the attendee has to approve the sign-in. Longer than the claim
 * payload's ten minutes would only leave a QR code on a registration page
 * working after the person who opened it walked away; shorter and someone
 * digging their phone out of a bag has to start again.
 */
export const SIGNIN_PAYLOAD_EXPIRE_MINUTES = 10;

// ---------------------------------------------------------------------------
// Outgoing: the payload envelope
// ---------------------------------------------------------------------------

export interface SignInRequestParams {
  eventId: EventId;
  returnUrl?: { app?: string; web?: string };
}

/** The envelope posted to POST https://xumm.app/api/v1/platform/payload. */
export interface XamanSignInRequest {
  /**
   * Exactly one field, and deliberately so. `SignIn` is a Xaman pseudo
   * transaction: it is never submitted anywhere, so there is no Account, no
   * Fee, no Sequence and no Destination to fill in. Anything else here would be
   * something we are asking a person to sign without having shown it to them.
   */
  txjson: { TransactionType: "SignIn" };
  options: {
    expire: number;
    return_url?: { app?: string; web?: string };
  };
  custom_meta: {
    identifier: string;
    blob: XamanSignInBlob;
    instruction: string;
  };
}

/** Ties a resolved payload back to an event. A hint for humans, never evidence. */
export interface XamanSignInBlob extends Record<string, unknown> {
  kind: "poap-registration";
  eventId: EventId;
}

/**
 * Build the SignIn envelope for one event's registration page.
 *
 * Note the absence of `options.submit`: the claim payload sets it so Xaman puts
 * the signed blob on the ledger, and there is nothing here to put anywhere.
 */
export function buildSignInRequest(params: SignInRequestParams): XamanSignInRequest {
  const { eventId, returnUrl } = params;
  assertValidTaxon(eventId);

  const request: XamanSignInRequest = {
    txjson: { TransactionType: "SignIn" },
    options: { expire: SIGNIN_PAYLOAD_EXPIRE_MINUTES },
    custom_meta: {
      // Xaman caps the identifier and only accepts [A-Za-z0-9-_.].
      identifier: `poap-reg-${eventId}`,
      blob: { kind: "poap-registration", eventId },
      instruction:
        `Sign in to register for event ${eventId}. This is not a transaction: ` +
        "it costs nothing, moves nothing, and only proves you control this wallet.",
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
// The service
// ---------------------------------------------------------------------------

/** What a browser needs to show a QR code and watch for the result. */
export interface SignInHandles {
  uuid: string;
  /** data: URI of the QR code PNG. */
  qrPng: string;
  /** Open-in-Xaman URL, for a phone that is already holding the page. */
  deeplink: string;
  /** Websocket the page can watch instead of polling. */
  websocket: string;
  expiresAt: string;
}

/**
 * The outcome of one sign-in, as the registration route is allowed to see it.
 *
 * `account` is present ONLY when `signed` is true. There is no shape of this
 * object that carries an address without a signature behind it.
 */
export interface SignInResolution {
  /** The attendee did something with the payload: signed it, or declined it. */
  resolved: boolean;
  /** THE ONLY FIELD THAT PROVES ANYTHING. */
  signed: boolean;
  /** Set only when `signed` is true, and only after address validation. */
  account?: string;
  /** Declined, cancelled or expired. */
  rejected: boolean;
}

export interface SignInService {
  create(params: SignInRequestParams): Promise<SignInHandles>;
  resolve(uuid: string): Promise<SignInResolution>;
}

// ---------------------------------------------------------------------------
// The real thing
// ---------------------------------------------------------------------------

/**
 * What a fetched SignIn payload looks like to us.
 *
 * Narrower than the SDK's `XummPayload` on purpose — a test injects an object
 * of exactly this shape, and every field we read is named here.
 */
export interface XummFetchedSignIn {
  meta: {
    resolved: boolean;
    signed: boolean;
    /** The attendee declined in the app. */
    cancelled?: boolean;
    /** Nobody answered before `expire`. */
    expired?: boolean;
  };
  response: {
    /** The account the payload resolved to. `null` until it is signed. */
    account?: string | null;
    /** The key that actually signed. Differs from `account` under a regular key. */
    signer?: string | null;
  };
}

/** The slice of XummSdk this module uses, structural so a test can inject a fake. */
export interface XummSignInSdkLike {
  payload: {
    create(payload: unknown, returnErrors?: boolean): Promise<XummCreatedPayload | null>;
    get(uuid: unknown, returnErrors?: boolean): Promise<XummFetchedSignIn | null>;
  };
}

export interface XummSignInServiceOptions {
  apiKey: string;
  apiSecret: string;
  /** Injected in tests. Defaults to a real XummSdk. */
  sdk?: XummSignInSdkLike;
}

export class XummSignInService implements SignInService {
  private readonly sdk: XummSignInSdkLike;

  constructor(options: XummSignInServiceOptions) {
    const { apiKey, apiSecret, sdk } = options;
    if (!sdk && (!apiKey || !apiSecret)) {
      throw new XrplLayerError(
        "CONFIG_INVALID",
        "XummSignInService needs both an API key and an API secret.",
      );
    }
    this.sdk = sdk ?? new XummSdk(apiKey, apiSecret);
  }

  async create(params: SignInRequestParams): Promise<SignInHandles> {
    const request = buildSignInRequest(params);

    let created: XummCreatedPayload | null;
    try {
      created = await this.sdk.payload.create(request);
    } catch (err) {
      // The API secret can appear in transport-level errors. Never re-attach it.
      throw new ConnectionError("Xaman rejected the sign-in request", {
        reason: (err as Error).message,
        eventId: params.eventId,
      });
    }

    if (!created) {
      throw new ConnectionError("Xaman returned no payload for the sign-in request", {
        eventId: params.eventId,
      });
    }

    return {
      uuid: created.uuid,
      qrPng: created.refs.qr_png,
      deeplink: created.next.always,
      websocket: created.refs.websocket_status,
      expiresAt: new Date(Date.now() + SIGNIN_PAYLOAD_EXPIRE_MINUTES * 60_000).toISOString(),
    };
  }

  /**
   * Ask Xaman what happened to a sign-in, and hand back an address only when
   * one was actually proven.
   *
   * TWO GUARDS, and the whole scheme rests on them:
   *
   *   1. `signed !== true` is UNPROVEN. A payload that is merely `resolved` was
   *      opened, or declined, or expired — Xaman still reports an `account` on
   *      some of those, because it knows which wallet looked at it. Reading the
   *      address off an opened-but-unsigned payload would accept "I opened the
   *      QR code" as proof of key control, which is not a proof at all.
   *   2. The account is validated with `assertValidAddress` before it leaves
   *      this method. It arrives as a string from a third-party API and is
   *      about to become a database row and, later, the `Destination` of a
   *      soulbound badge. An unchecked string reaching either is unrecoverable.
   */
  async resolve(uuid: string): Promise<SignInResolution> {
    let payload: XummFetchedSignIn | null;
    try {
      payload = await this.sdk.payload.get(uuid);
    } catch (err) {
      throw new ConnectionError("Could not read the Xaman sign-in payload", {
        reason: (err as Error).message,
        uuid,
      });
    }

    if (!payload) throw new NotFoundError(`No Xaman sign-in payload ${uuid}`, { uuid });

    const { meta, response } = payload;
    const signed = meta.signed === true;
    const resolved = meta.resolved === true;
    // Declined in the app, expired unanswered, or resolved without a signature.
    const rejected = !signed && (meta.cancelled === true || meta.expired === true || resolved);

    // GUARD 1. Nothing below this line runs for an unsigned payload, so no
    // caller of this method can be handed an address that nobody signed for.
    if (!signed) return { resolved, signed: false, rejected };

    const account = response.account ?? undefined;
    if (!account) {
      // Signed, but Xaman did not say by whom. Unusable rather than merely
      // unproven, and an upstream fault rather than the attendee's, so it is a
      // 502 and not a "please try again".
      throw new ConnectionError(
        "Xaman reported a signed sign-in with no account, so there is nothing to register.",
        { uuid },
      );
    }

    // GUARD 2. Throws ValidationError("INVALID_ADDRESS") rather than returning
    // a value the caller might store.
    assertValidAddress(account, "Xaman sign-in account");

    return { resolved: true, signed: true, account, rejected: false };
  }
}

// ---------------------------------------------------------------------------
// The no-keys fallback
// ---------------------------------------------------------------------------

const NOT_CONFIGURED =
  "Xaman sign-in is not configured (XUMM_API_KEY / XUMM_API_SECRET are unset), so a wallet " +
  "cannot be proven and nobody can register. Set both keys and restart. There is deliberately " +
  "no typed-address fallback: an unverified address is a claim, not a proof, and a badge minted " +
  "to the wrong address is soulbound and unrecoverable.";

/**
 * Used when no Xaman keys are present. The server must boot and serve every
 * other route, so this fails loudly only when someone actually tries to
 * register — never at startup. buildDeps() says so in one line at boot.
 */
export class NullSignInService implements SignInService {
  async create(_params: SignInRequestParams): Promise<SignInHandles> {
    throw new XrplLayerError("CONFIG_INVALID", NOT_CONFIGURED);
  }

  async resolve(_uuid: string): Promise<SignInResolution> {
    throw new XrplLayerError("CONFIG_INVALID", NOT_CONFIGURED);
  }
}

// ---------------------------------------------------------------------------
// Replay: a sign-in proves one registration, not a supply of them
// ---------------------------------------------------------------------------

/**
 * One-shot ticket book for resolved sign-in payload uuids.
 *
 * A signed payload stays signed. Xaman will answer `signed: true` for the same
 * uuid every time it is asked, so without this a leaked uuid — off a shared
 * screen, out of a browser history, out of a log — could be posted repeatedly
 * to the registration route. Same address every time, so it cannot register a
 * wallet that did not sign, but it can overwrite a name and an email, and it
 * can register that address for an event the owner never opened.
 *
 * `claim()` is a test-and-set and must stay one: check and insert with no
 * `await` between them, so two concurrent POSTs cannot both win.
 *
 * IN-PROCESS AND NOT DURABLE. A restart forgets, and a second instance does not
 * share it. The durable half of this guard is the (event, address) uniqueness
 * the registration table enforces plus the stored `signinPayloadUuid`, which
 * catches the same-event replay across restarts; a unique index on
 * `signin_payload_uuid` would close the rest and belongs in the db layer.
 */
export interface ConsumedSignIns {
  /** True when THIS call took the uuid. False when it was already spent. */
  claim(uuid: string): Promise<boolean>;
  /** Hand it back when the registration it was taken for did not happen. */
  release(uuid: string): Promise<void>;
}

/** How long a spent uuid is remembered. Comfortably past the payload's own expiry. */
const CONSUMED_TTL_MS = 24 * 60 * 60 * 1000;
/** Bound on the map, so a hammered public route cannot grow it without limit. */
const CONSUMED_MAX_ENTRIES = 20_000;

export class MemoryConsumedSignIns implements ConsumedSignIns {
  private readonly spent = new Map<string, number>();

  constructor(private readonly ttlMs: number = CONSUMED_TTL_MS) {}

  async claim(uuid: string): Promise<boolean> {
    const now = Date.now();
    this.prune(now);

    const spentAt = this.spent.get(uuid);
    if (spentAt !== undefined && now - spentAt < this.ttlMs) return false;

    this.spent.set(uuid, now);
    return true;
  }

  async release(uuid: string): Promise<void> {
    this.spent.delete(uuid);
  }

  private prune(now: number): void {
    for (const [uuid, at] of this.spent) {
      if (now - at >= this.ttlMs) this.spent.delete(uuid);
    }
    // Oldest first: Map iterates in insertion order and entries are only ever
    // appended, so dropping from the front drops the least recently spent.
    while (this.spent.size > CONSUMED_MAX_ENTRIES) {
      const oldest = this.spent.keys().next();
      if (oldest.done) break;
      this.spent.delete(oldest.value);
    }
  }
}
