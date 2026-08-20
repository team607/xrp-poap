/** Typed errors. Every throw in src/ should be one of these. */

export type ErrorCode =
  | "CONFIG_INVALID"
  /** A malformed argument. Distinct from a policy denial. */
  | "INVALID_INPUT"
  | "NETWORK_GUARD"
  | "CONNECTION_FAILED"
  | "TX_FAILED"
  | "ACCOUNT_NOT_FOUND"
  | "URI_TOO_LONG"
  | "INVALID_TAXON"
  | "INVALID_ADDRESS"
  | "SPONSORSHIP_DENIED"
  | "METADATA_INVALID"
  | "PIN_FAILED"
  | "NOT_FOUND"
  | "DUPLICATE_CLAIM"
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

export class SponsorshipDeniedError extends XrplLayerError {
  constructor(
    message: string,
    readonly kind: "disabled" | "duplicate" | "daily_cap" | "already_activated",
    details?: Record<string, unknown>,
  ) {
    super("SPONSORSHIP_DENIED", message, { ...details, kind });
  }
}

export class MetadataError extends XrplLayerError {}
export class NotFoundError extends XrplLayerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("NOT_FOUND", message, details);
  }
}
