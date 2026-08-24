/**
 * The HTTP edge: request validation in, error responses out.
 *
 *     { "error": { "code": "...", "message": "...", "details": { ... } } }
 *
 * The issuer seed never leaves the server — not in logs, not in responses, not
 * in errors (CLAUDE.md) — and neither does a Pinata JWT or a Xaman API secret.
 * An error has TWO exits and this module only guards one of them:
 *
 *   - THE RESPONSE. Every body built here — `toErrorResponse()` and
 *     `sendError()` — goes through `redactDetails()` and `scrubSecrets()`.
 *   - THE LOG SINK. Not this module's. `serializeLoggedError` and
 *     `LOG_REDACT_PATHS` in src/api/deps.ts reuse the two functions below to
 *     do the same job on the way to pino, because pino's default `err`
 *     serializer emits every own enumerable property of an error (so `details`,
 *     always) and follows `cause` into the message and the stack.
 *
 * Both exits, or neither: a response reading `"[redacted]"` next to a log line
 * holding the real value is worse than no redaction, because it is trusted.
 *
 * The shared zod primitives live here too: every route imports this module
 * already, and one definition of "what a valid address is" beats five.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isValidClassicAddress } from "xrpl";
import { z, ZodError } from "zod";
import { XrplLayerError, type ErrorCode } from "../errors.js";
import { MAX_TAXON } from "../types.js";

// ---------------------------------------------------------------------------
// Shared request validation
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9A-Fa-f]{64}$/;

export const addressSchema = z
  .string()
  .refine(isValidClassicAddress, "Not a valid XRPL classic address");

/** The event id doubles as the NFTokenTaxon; >= 2147483648 is protocol-reserved. */
export const eventIdSchema = z.coerce.number().int().min(0).max(MAX_TAXON);

export const txHashSchema = z.string().regex(HEX64, "Must be a 64 character hex transaction hash");
export const offerIdSchema = z.string().regex(HEX64, "Must be a 64 character hex offer id");

export const eventIdParamsSchema = z.object({ eventId: eventIdSchema });
export type EventIdParams = z.infer<typeof eventIdParamsSchema>;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Codes this layer emits that are not XrplLayerError codes. */
export type HttpOnlyErrorCode = "BAD_REQUEST" | "VERIFICATION_FAILED" | "RATE_LIMITED" | "INTERNAL";
export type ApiErrorCode = ErrorCode | HttpOnlyErrorCode;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export const REDACTED = "[redacted]";

/**
 * Keys whose value is replaced wholesale.
 *
 * Matched against the WHOLE key, never as a substring: `nftokenId`,
 * `nftokenIdSource` and `NFTokenID` all contain "token" and are exactly the
 * fields you need to see in a 502 from a failed ledger query. A key is
 * sensitive when, lowercased and stripped of non-alphanumerics, it equals or
 * ends with one of these — so `issuerSeed`, `PINATA_JWT` and `refresh_token`
 * are caught while `nftoken_id` is not.
 */
export const SENSITIVE_KEY_SUFFIXES = [
  "seed",
  "secret",
  "password",
  "passphrase",
  "privatekey",
  "apikey",
  "apisecret",
  "authorization",
  "jwt",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "sessiontoken",
  // Xaman push credential; arrives in webhook bodies.
  "usertoken",
] as const;

/** Sensitive on its own, but never as a suffix (see `nftokenId`). */
const SENSITIVE_EXACT = new Set(["token"]);

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SENSITIVE_EXACT.has(normalized)) return true;
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * Family seeds are base58 starting with `s`. Belt and braces for the one thing
 * that must never appear in a response body, in case it was interpolated into a
 * message or an array rather than sitting under an obvious key.
 */
const SEED_LIKE = /\bs[1-9A-HJ-NP-Za-km-z]{25,45}\b/g;

const MAX_DEPTH = 6;

export function scrubSecrets(text: string): string {
  return text.replace(SEED_LIKE, REDACTED);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubSecrets(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "function") return "[function]";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return scrubSecrets(value.message);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(val, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Deep-redact an error `details` bag. Returns undefined when there is nothing to say. */
export function redactDetails(details: unknown): Record<string, unknown> | undefined {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
  const redacted = redactValue(details, 0) as Record<string, unknown>;
  return Object.keys(redacted).length > 0 ? redacted : undefined;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  CONFIG_INVALID: 500,
  NETWORK_GUARD: 500,
  INVALID_INPUT: 400,
  // Distinct on purpose: 401 means "identify yourself", 403 means "identified
  // and still refused" (a failed CSRF check), 503 means the surface is not
  // configured — never 500, which would read as a bug rather than a setting.
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  SERVICE_UNAVAILABLE: 503,
  INVALID_ADDRESS: 400,
  INVALID_TAXON: 400,
  URI_TOO_LONG: 400,
  METADATA_INVALID: 400,
  NOT_FOUND: 404,
  DUPLICATE_CLAIM: 409,
  SPONSORSHIP_DENIED: 403,
  TX_FAILED: 502,
  LEDGER_QUERY_FAILED: 502,
  CONNECTION_FAILED: 502,
  PIN_FAILED: 502,
  // Not in the brief's table. An attendee whose wallet is not activated is a
  // conflict the caller can resolve (fund the wallet, or enable sponsorship),
  // not a server fault — POST /claims returns this as a 409.
  ACCOUNT_NOT_FOUND: 409,
};

export function statusForXrplError(error: XrplLayerError): number {
  if (error.code === "SPONSORSHIP_DENIED") {
    // The daily cap is a throttle, not a refusal: the same request may succeed
    // tomorrow, so it is a 429 rather than a 403.
    return error.details?.kind === "daily_cap" ? 429 : 403;
  }
  return STATUS_BY_CODE[error.code] ?? 500;
}

// ---------------------------------------------------------------------------
// Error -> response
// ---------------------------------------------------------------------------

function statusCodeOf(error: unknown): number | undefined {
  const raw = (error as { statusCode?: unknown } | null | undefined)?.statusCode;
  return typeof raw === "number" && raw >= 400 && raw <= 599 ? raw : undefined;
}

function genericCodeFor(status: number): HttpOnlyErrorCode | "NOT_FOUND" {
  if (status === 429) return "RATE_LIMITED";
  if (status === 404) return "NOT_FOUND";
  if (status < 500) return "BAD_REQUEST";
  return "INTERNAL";
}

/**
 * Pure error -> { status, body }. Exported so the mapping (and the redaction)
 * can be tested without standing up a server.
 */
export function toErrorResponse(error: unknown): { status: number; body: ApiErrorBody } {
  // Request-shape failures from the zod validator compiler. src/errors.ts has
  // no generic VALIDATION code, so these carry an HTTP-layer one.
  if (error instanceof ZodError) {
    const location = (error as { validationContext?: string }).validationContext;
    return {
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request validation failed",
          details: {
            ...(location ? { location } : {}),
            issues: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        },
      },
    };
  }

  if (error instanceof XrplLayerError) {
    const details = redactDetails(error.details);
    return {
      status: statusForXrplError(error),
      body: {
        error: {
          code: error.code,
          message: scrubSecrets(error.message),
          ...(details ? { details } : {}),
        },
      },
    };
  }

  const status = statusCodeOf(error) ?? 500;
  const message =
    status < 500 && error instanceof Error ? scrubSecrets(error.message) : "Internal server error";

  return { status, body: { error: { code: genericCodeFor(status), message } } };
}

/** Send an error response built by hand, with the same shape and the same redaction. */
export function sendError(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>,
): FastifyReply {
  const redacted = redactDetails(details);
  const body: ApiErrorBody = {
    error: { code, message: scrubSecrets(message), ...(redacted ? { details: redacted } : {}) },
  };
  return reply.code(status).send(body);
}

/** Wire the handler (and a matching 404) onto an instance. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    const { status, body } = toErrorResponse(error);

    if (status >= 500) {
      request.log.error({ err: error, status }, "request failed");
    } else {
      request.log.warn({ code: body.error.code, status }, body.error.message);
    }

    return reply.code(status).send(body);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) =>
    sendError(reply, 404, "NOT_FOUND", `No route for ${request.method} ${request.url}`),
  );
}
