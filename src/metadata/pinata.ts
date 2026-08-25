/**
 * Pinata IPFS pinner, built on global fetch. No HTTP client dependency.
 *
 * Two rules hold everywhere in this file:
 *   1. Nothing escapes untyped. A DNS failure, an abort and a 500 all surface
 *      as XrplLayerError("PIN_FAILED").
 *   2. The JWT never reaches an error message, an error detail, or a log. It
 *      is a `#private` field so it cannot be serialised off the instance
 *      either, and any response body we quote is scrubbed of it first.
 */
import { XrplLayerError } from "../errors.js";
import type { IpfsPinner, PinResult } from "../types.js";

export const PINATA_API_BASE = "https://api.pinata.cloud";
export const DEFAULT_PINATA_GATEWAY = "https://gateway.pinata.cloud";

const PIN_FILE_PATH = "/pinning/pinFileToIPFS";
const PIN_JSON_PATH = "/pinning/pinJSONToIPFS";

/** Response bodies land in error details; keep them from swallowing a log line. */
const MAX_QUOTED_BODY = 1_000;

export interface PinataOptions {
  jwt: string;
  /** Public gateway used to build the human-facing URL. No trailing slash needed. */
  gateway?: string;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override the API origin. Defaults to https://api.pinata.cloud. */
  baseUrl?: string;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === "Error" ? cause.message : `${cause.name}: ${cause.message}`;
  }
  return String(cause);
}

/** Defence in depth: a misconfigured proxy could echo the Authorization header. */
function scrub(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

function truncate(text: string): string {
  return text.length > MAX_QUOTED_BODY ? `${text.slice(0, MAX_QUOTED_BODY)}…[truncated]` : text;
}

export class PinataPinner implements IpfsPinner {
  /** `#private` so neither JSON.stringify nor a spread can lift it out. */
  readonly #jwt: string;
  readonly #fetch: typeof fetch;
  readonly baseUrl: string;
  readonly gateway: string;

  constructor(options: PinataOptions) {
    if (!options.jwt || options.jwt.trim() === "") {
      throw new XrplLayerError("CONFIG_INVALID", "PinataPinner requires a JWT (PINATA_JWT)");
    }
    this.#jwt = options.jwt;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? PINATA_API_BASE);
    this.gateway = stripTrailingSlash(options.gateway ?? DEFAULT_PINATA_GATEWAY);
  }

  async pinFile(input: {
    data: Uint8Array | Buffer;
    filename: string;
    contentType?: string;
  }): Promise<PinResult> {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(input.data)], {
      type: input.contentType ?? "application/octet-stream",
    });
    form.append("file", blob, input.filename);
    form.append("pinataMetadata", JSON.stringify({ name: input.filename }));
    // Content-Type is deliberately unset: fetch derives the multipart boundary.
    const body = await this.#post(PIN_FILE_PATH, form);
    return this.#toPinResult(body, input.data.byteLength, PIN_FILE_PATH);
  }

  async pinJson(input: { json: unknown; name: string }): Promise<PinResult> {
    let serialized: string;
    try {
      serialized = JSON.stringify({
        pinataContent: input.json,
        pinataMetadata: { name: input.name },
      });
    } catch (cause) {
      throw new XrplLayerError(
        "PIN_FAILED",
        `Cannot serialise "${input.name}" to JSON: ${describeCause(cause)}`,
        { name: input.name },
      );
    }
    const body = await this.#post(PIN_JSON_PATH, serialized, {
      "Content-Type": "application/json",
    });
    const size = Buffer.byteLength(JSON.stringify(input.json) ?? "", "utf8");
    return this.#toPinResult(body, size, PIN_JSON_PATH);
  }

  /** Builds the public URL for a CID without re-pinning it. */
  gatewayUrlFor(cid: string): string {
    return `${this.gateway}/ipfs/${cid}`;
  }

  async #post(
    path: string,
    body: FormData | string,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#jwt}`, ...headers },
        body,
      });
    } catch (cause) {
      throw new XrplLayerError(
        "PIN_FAILED",
        `Pinata request to ${path} failed before a response: ${scrub(describeCause(cause), this.#jwt)}`,
        { path, url, cause: scrub(describeCause(cause), this.#jwt) },
      );
    }

    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    const quoted = truncate(scrub(text, this.#jwt));

    if (!response.ok) {
      throw new XrplLayerError(
        "PIN_FAILED",
        `Pinata ${path} responded ${response.status} ${response.statusText}: ${quoted}`,
        { path, url, status: response.status, statusText: response.statusText, body: quoted },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new XrplLayerError(
        "PIN_FAILED",
        `Pinata ${path} returned ${response.status} with a non-JSON body: ${quoted}`,
        { path, url, status: response.status, body: quoted },
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new XrplLayerError(
        "PIN_FAILED",
        `Pinata ${path} returned ${response.status} with an unexpected body: ${quoted}`,
        { path, url, status: response.status, body: quoted },
      );
    }
    return parsed as Record<string, unknown>;
  }

  #toPinResult(body: Record<string, unknown>, fallbackSize: number, path: string): PinResult {
    // The v1 pinning API returns IpfsHash; newer responses use cid.
    const raw = body["IpfsHash"] ?? body["cid"] ?? body["Hash"];
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new XrplLayerError(
        "PIN_FAILED",
        `Pinata ${path} succeeded but returned no CID`,
        { path, keys: Object.keys(body) },
      );
    }
    const cid = raw.trim();
    const reported = body["PinSize"] ?? body["pin_size"];
    const size = typeof reported === "number" && Number.isFinite(reported) ? reported : fallbackSize;
    return { cid, uri: `ipfs://${cid}`, gatewayUrl: this.gatewayUrlFor(cid), size };
  }
}

/**
 * Can this JWT actually pin, or is it merely a real key?
 *
 * `GET /data/testAuthentication` returns 200 for a key with ZERO permissions,
 * which is exactly how a badge pipeline ends up silently minting the fallback
 * image for every attendee: auth "passes", every pin 403s, and the only signal
 * is a warning in a log nobody is reading.
 *
 * So probe the endpoint that actually matters. Pinata checks the key's scope
 * BEFORE it validates the request body, so a structurally valid but unstorable
 * request separates the cases without creating a pin:
 *
 *   no Authorization header      -> 401
 *   malformed / unknown token    -> 401  INVALID_CREDENTIALS
 *   real key, no scopes attached -> 403  NO_SCOPES_FOUND
 *   real key, revoked            -> 403  API_KEY_REVOKED
 *   real key WITH pinning scope  -> 400  (cidVersion 99 rejected — nothing stored)
 *
 * Measured against the live API, all five. Do NOT "simplify" this to a
 * well-formed body: a request Pinata accepts leaves a stray pin on the
 * operator's account every time the server boots. And do not use a malformed
 * JSON body either — parsing precedes auth, so it returns 400 even for a
 * garbage token and would report every broken key as healthy.
 */
export interface PinataUsableResult {
  usable: boolean;
  status?: number;
  /** Pinata's machine-readable reason, when it gave one. */
  reason?: string;
  /** Operator-facing explanation with the fix. */
  message: string;
}

export async function checkPinataUsable(
  options: { jwt: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<PinataUsableResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = stripTrailingSlash(options.baseUrl ?? PINATA_API_BASE);
  let res: Response;
  try {
    res = await doFetch(`${base}${PIN_JSON_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.jwt}`, "Content-Type": "application/json" },
      // Valid JSON, and cidVersion 99 does not exist, so this can never be stored.
      body: JSON.stringify({ pinataContent: { probe: 1 }, pinataOptions: { cidVersion: 99 } }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (err) {
    return {
      usable: false,
      message: `Could not reach Pinata to check the key: ${(err as Error).message}`,
    };
  }

  if (res.status !== 401 && res.status !== 403) {
    return { usable: true, status: res.status, message: "Pinata key can pin." };
  }

  let reason: string | undefined;
  try {
    const body = (await res.json()) as { error?: { reason?: string } };
    reason = body.error?.reason;
  } catch {
    /* body is not the shape we expect; the status alone is enough */
  }

  const fix =
    res.status === 401
      ? "PINATA_JWT is not a valid token. Copy the JWT (not the API key or secret) from Pinata."
      : reason === "API_KEY_REVOKED"
        ? "This Pinata key has been revoked. Create a new one."
        : "This Pinata key has NO SCOPES. Recreate it with pinFileToIPFS and pinJSONToIPFS enabled — " +
          "a key with no permissions still passes testAuthentication, which is why this is easy to miss.";

  return { usable: false, status: res.status, ...(reason ? { reason } : {}), message: fix };
}

export interface GatewayCheckResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Cutover checklist, section 9: "metadata JSON resolves from a public IPFS
 * gateway, not just your local node". Never throws — a failed check is a
 * result, not an exception, because the caller is a checklist runner.
 */
export async function checkGatewayResolves(
  gatewayUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GatewayCheckResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  try {
    const response = await fetchImpl(gatewayUrl, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `gateway responded ${response.status} ${response.statusText}`,
      };
    }
    return { ok: true, status: response.status };
  } catch (cause) {
    return { ok: false, error: describeCause(cause) };
  }
}

/**
 * Public gateways that must be able to serve a CID before a wallet can render
 * it. Requesting a CID from one of these is what makes it discoverable: the
 * gateway performs a DHT lookup, finds Pinata's node, and caches the result.
 */
const WARM_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
] as const;

export interface WarmResult {
  cid: string;
  /** Gateways that served the content within the timeout. */
  reachable: string[];
  /** Gateways that did not answer in time. Normal for a fresh pin. */
  pending: string[];
}

/**
 * Nudge public gateways into discovering a freshly pinned CID.
 *
 * MEASURED, AND THE REASON THIS EXISTS: a CID pinned to Pinata is served by
 * Pinata's own gateway within seconds, but public gateways 504 on it for
 * HOURS — a CID pinned hours earlier answered from ipfs.io in 0.9s while one
 * pinned minutes earlier timed out at 28s. Wallets resolve `ipfs://` through
 * their own gateway, not ours, so a badge minted against a fresh CID renders
 * as a blank tile until propagation catches up. Since NFTokenMint's URI is
 * immutable, that window is the difference between a badge that works and one
 * that is permanently broken on arrival.
 *
 * A request is enough to start the lookup even when it times out, so this is
 * fire-and-forget and never throws: warming is best effort, and a pin that has
 * not propagated yet is not a failure to pin.
 *
 * The real remedy is lead time — pin the roster before the event with
 * `npm run prepin`, not at the desk.
 */
export async function warmGateways(
  cid: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<WarmResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const reachable: string[] = [];
  const pending: string[] = [];

  await Promise.all(
    WARM_GATEWAYS.map(async (base) => {
      const host = base.split("/")[2] ?? base;
      try {
        const res = await doFetch(`${base}${cid}`, {
          method: "GET",
          signal: AbortSignal.timeout(timeoutMs),
        });
        (res.ok ? reachable : pending).push(host);
      } catch {
        pending.push(host);
      }
    }),
  );

  return { cid, reachable, pending };
}
