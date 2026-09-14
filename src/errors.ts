/** Typed errors. Every throw in src/ should be one of these. */

export type ErrorCode =
  | "CONFIG_INVALID"
  /** A malformed argument. Distinct from a policy denial. */
  | "INVALID_INPUT"
  /** No credentials, or credentials that no longer identify anyone. */
  | "UNAUTHORIZED"
  /** Identified, but not permitted — a failed CSRF check lands here. */
  | "FORBIDDEN"
  /** Configured off or not ready. The admin surface uses this when unconfigured. */
  | "SERVICE_UNAVAILABLE"
  | "NETWORK_GUARD"
  | "CONNECTION_FAILED"
  | "TX_FAILED"
  | "ACCOUNT_NOT_FOUND"
  | "URI_TOO_LONG"
  | "INVALID_TAXON"
  | "INVALID_ADDRESS"
  /** An event's treasury refused to pay. `details.kind` says why. */
  | "ALLOWANCE_DENIED"
  | "METADATA_INVALID"
  | "PIN_FAILED"
  | "NOT_FOUND"
  | "DUPLICATE_CLAIM"
  /** The request is valid but the state of things will not allow it. */
  | "CONFLICT"
  | "LEDGER_QUERY_FAILED";

export class XrplLayerError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ConfigError extends XrplLayerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("CONFIG_INVALID", message, details);
  }
}

/** Thrown at startup when the network name and endpoint disagree. */
export class NetworkGuardError extends XrplLayerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("NETWORK_GUARD", message, details);
  }
}

export class ConnectionError extends XrplLayerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("CONNECTION_FAILED", message, details);
  }
}

/** A submitted transaction came back with anything other than tesSUCCESS. */
export class TransactionFailedError extends XrplLayerError {
  readonly engineResult: string;
  readonly txHash?: string;

  constructor(
    engineResult: string,
    message: string,
    details?: Record<string, unknown> & { txHash?: string },
  ) {
    super("TX_FAILED", message, details);
    this.engineResult = engineResult;
    this.txHash = details?.txHash;
  }
}

export class AccountNotFoundError extends XrplLayerError {
  readonly address: string;
  constructor(address: string) {
    super("ACCOUNT_NOT_FOUND", `Account ${address} is not activated on the ledger`, {
      address,
    });
    this.address = address;
  }
}

export class ValidationError extends XrplLayerError {}

/**
 * Why an event's treasury did not pay an attendee.
 *
 *   in_flight    a payment for this attendee is on its way right now
 *   budget       the event's budget cannot cover this payment
 *   ceiling      the payment would exceed REWARD_MAX_PER_ATTENDEE_XRP
 *   unavailable  there is no treasury to pay from: the event has none, or the
 *                server has no TREASURY_MASTER_KEY to open it with
 *   unfunded     the treasury exists but cannot pay: it was never funded, so
 *                the ledger has no such account, or it holds too little
 *
 * "Already paid" is not a denial. Paying twice is refused by returning the
 * payment that already happened, because that is the answer a retry wants.
 */
export type AllowanceDenial = "in_flight" | "budget" | "ceiling" | "unavailable" | "unfunded";

export class AllowanceDeniedError extends XrplLayerError {
  constructor(
    message: string,
    readonly kind: AllowanceDenial,
    details?: Record<string, unknown>,
  ) {
    super("ALLOWANCE_DENIED", message, { ...details, kind });
  }
}

export class MetadataError extends XrplLayerError {}
export class NotFoundError extends XrplLayerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("NOT_FOUND", message, details);
  }
}
