/**
 * Environment parsing plus the mainnet guard rail.
 *
 * Nothing here reads process.env at import time — call loadConfig() from an
 * entrypoint so tests can build a config object directly.
 */
import { config as loadDotenv } from "dotenv";
import { ConfigError, NetworkGuardError } from "./errors.js";
import type { NetworkName } from "./types.js";

export interface SponsorConfig {
  enabled: boolean;
  amountXrp: string;
  dailyCapXrp: string;
}

export interface AppConfig {
  endpoint: string;
  fallbackEndpoints: string[];
  network: NetworkName;
  issuerAddress: string;
  /** Server-side only. Never log this, never serialise it, never ship it. */
  issuerSeed: string;
  sponsor: SponsorConfig;
  pinata: { jwt?: string; gateway: string };
  xumm: { apiKey?: string; apiSecret?: string };
  databaseUrl?: string;
  /**
   * Fallback NFTokenMint URI when a claim request does not carry its own.
   * Points at the metadata JSON, not the image. Capped at 256 bytes.
   */
  defaultMetadataUri?: string;
  /**
   * Testnet-only click-through demo at /demo. Generates wallets, takes faucet
   * funds and signs on an attendee's behalf, so it refuses to boot on mainnet
   * rather than quietly disabling itself.
   */
  demoEnabled: boolean;
  /**
   * Label drawn on the badge artwork. Feeds BOTH the locally-rendered preview
   * and the copy pinned to IPFS — they must be the same string or the two stop
   * being byte-identical, which is the guarantee the UI makes to attendees.
   * Read once here so there is no second place to set it inconsistently.
   */
  eventName?: string;
  /**
   * SourceTag stamped on every transaction this app submits, and on the
   * accept payload the attendee signs. A uint32 used for attribution — it
   * moves no funds and changes no behaviour, it just makes our traffic
   * identifiable on the ledger.
   */
  sourceTag?: number;
  /**
   * What a badge's metadata points at for its image.
   *
   * "https" (default) uses the pinning gateway, which serves the bytes
   * immediately. "ipfs" is content-addressed but unfindable on public
   * gateways for hours after pinning — and the choice is permanent, because
   * the metadata CID lands in an immutable NFTokenMint URI. Use "ipfs" only
   * when you pre-pin well ahead of the event.
   */
  badgeImageUriMode: "ipfs" | "https";
  admin: {
    email?: string;
    /** scrypt hash, produced by `npm run admin:hash`. Never a plaintext password. */
    passwordHash?: string;
    /** Signs the session cookie. Rotating it logs everyone out, which is the point. */
    sessionSecret?: string;
    sessionTtlHours: number;
  };
  api: {
    port: number;
    host: string;
    /**
     * Set the Secure flag on cookies. Must be true behind HTTPS and false on
     * plain-http localhost, because a Secure cookie is simply never sent over
     * http and the symptom is a login that silently does nothing.
     */
    secureCookies: boolean;
    /**
     * Whether to trust X-Forwarded-For. Rate limiting is keyed on the client
     * IP, so behind an ingress this must be set or every attendee shares one
     * bucket. Defaults to false — trusting a spoofable header by default would
     * hand an attacker unlimited buckets.
     */
    trustProxy: boolean | string | string[];
  };
}

const NETWORKS: NetworkName[] = ["testnet", "devnet", "mainnet"];

/**
 * `TRUST_PROXY` -> a Fastify trustProxy value. Booleans follow the same
 * vocabulary as bool(); anything else is passed through as an address or CIDR
 * list. There is deliberately no hop-count form: Fastify treats a numeric
 * trustProxy as fail-closed, so `TRUST_PROXY=1` would read as "trust one hop"
 * and silently mean "trust nothing".
 */
export function parseTrustProxy(raw: string | undefined): boolean | string {
  const v = raw?.trim();
  if (!v) return false;
  const lower = v.toLowerCase();
  if (["true", "1", "yes", "on"].includes(lower)) return true;
  if (["false", "0", "no", "off"].includes(lower)) return false;
  return v;
}

/** Substrings that can only ever appear in a non-production endpoint. */
const NON_MAINNET_MARKERS = ["altnet", "devnet", "rippletest", "sidechain", "localhost", "127.0.0.1"];

function env(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function required(key: string): string {
  const v = env(key);
  if (!v) throw new ConfigError(`Missing required environment variable ${key}`, { key });
  return v;
}

function bool(key: string, fallback: boolean): boolean {
  const v = env(key);
  if (v === undefined) return fallback;
  if (["true", "1", "yes", "on"].includes(v.toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(v.toLowerCase())) return false;
  throw new ConfigError(`${key} must be a boolean, got "${v}"`, { key });
}

function decimal(key: string, fallback: string): string {
  const v = env(key) ?? fallback;
  if (!/^\d+(\.\d+)?$/.test(v)) {
    throw new ConfigError(`${key} must be a positive decimal, got "${v}"`, { key });
  }
  return v;
}

/**
 * SOURCE_TAG must fit a uint32 — the ledger rejects anything wider, and it
 * would be rejected at submit time rather than at boot, which is the wrong
 * place to find out.
 */
function sourceTag(): number | undefined {
  const raw = env("SOURCE_TAG");
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 4_294_967_295) {
    throw new ConfigError(
      `SOURCE_TAG must be an integer in [0, 4294967295] (uint32), got "${raw}"`,
      { sourceTag: raw },
    );
  }
  return n;
}

function int(key: string, fallback: number): number {
  const v = env(key);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n)) throw new ConfigError(`${key} must be an integer, got "${v}"`, { key });
  return n;
}

/**
 * The guard rail from section 3. Cheap insurance against demoing on the wrong
 * chain — in either direction.
 */
export function assertNetworkMatchesEndpoint(network: NetworkName, endpoint: string): void {
  const lower = endpoint.toLowerCase();

  if (!/^wss?:\/\//.test(lower)) {
    throw new ConfigError(
      `XRPL_ENDPOINT must be a ws:// or wss:// URL, got "${endpoint}"`,
      { endpoint },
    );
  }

  const marker = NON_MAINNET_MARKERS.find((m) => lower.includes(m));

  if (network === "mainnet" && marker) {
    throw new NetworkGuardError(
      `XRPL_NETWORK=mainnet but endpoint "${endpoint}" looks like a test network (matched "${marker}"). Refusing to start.`,
      { network, endpoint, marker },
    );
  }

  if (network !== "mainnet" && !marker) {
    throw new NetworkGuardError(
      `XRPL_NETWORK=${network} but endpoint "${endpoint}" has no test-network marker. This looks like mainnet. Refusing to start.`,
      { network, endpoint },
    );
  }
}

export interface LoadConfigOptions {
  /** Skip reading a .env file. Useful in tests. */
  skipDotenv?: boolean;
  /** Issuer credentials are not needed by read-only entrypoints. */
  requireIssuer?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const { skipDotenv = false, requireIssuer = true } = options;
  if (!skipDotenv) loadDotenv({ quiet: true });

  const endpoint = required("XRPL_ENDPOINT");
  const networkRaw = (env("XRPL_NETWORK") ?? "testnet").toLowerCase();
  if (!NETWORKS.includes(networkRaw as NetworkName)) {
    throw new ConfigError(
      `XRPL_NETWORK must be one of ${NETWORKS.join(" | ")}, got "${networkRaw}"`,
    );
  }
  const network = networkRaw as NetworkName;

  assertNetworkMatchesEndpoint(network, endpoint);

  const fallbackEndpoints = (env("XRPL_FALLBACK_ENDPOINTS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const fb of fallbackEndpoints) assertNetworkMatchesEndpoint(network, fb);

  const issuerSeed = requireIssuer ? required("ISSUER_SEED") : (env("ISSUER_SEED") ?? "");
  const issuerAddress = requireIssuer ? required("ISSUER_ADDRESS") : (env("ISSUER_ADDRESS") ?? "");

  return {
    endpoint,
    fallbackEndpoints,
    network,
    issuerAddress,
    issuerSeed,
    sponsor: {
      enabled: bool("SPONSOR_ENABLED", false),
      amountXrp: decimal("SPONSOR_AMOUNT_XRP", "1.5"),
      dailyCapXrp: decimal("SPONSOR_DAILY_CAP_XRP", "50"),
    },
    pinata: { jwt: env("PINATA_JWT"), gateway: env("PINATA_GATEWAY") ?? "https://gateway.pinata.cloud" },
    xumm: { apiKey: env("XUMM_API_KEY"), apiSecret: env("XUMM_API_SECRET") },
    databaseUrl: env("DATABASE_URL"),
    defaultMetadataUri: env("EVENT_METADATA_URI"),
    demoEnabled: bool("DEMO_ENABLED", false),
    eventName: env("EVENT_NAME"),
    sourceTag: sourceTag(),
    badgeImageUriMode: env("BADGE_IMAGE_URI_MODE") === "ipfs" ? "ipfs" : "https",
    admin: {
      email: env("ADMIN_EMAIL"),
      passwordHash: env("ADMIN_PASSWORD_HASH"),
      sessionSecret: env("SESSION_SECRET"),
      sessionTtlHours: int("SESSION_TTL_HOURS", 12),
    },
    api: {
      port: int("PORT", 3000),
      host: env("HOST") ?? "127.0.0.1",
      secureCookies: bool("SECURE_COOKIES", false),
      trustProxy: parseTrustProxy(env("TRUST_PROXY")),
    },
  };
}

/** Redacted view, safe to log. */
export function describeConfig(cfg: AppConfig): Record<string, unknown> {
  return {
    endpoint: cfg.endpoint,
    fallbackEndpoints: cfg.fallbackEndpoints,
    network: cfg.network,
    issuerAddress: cfg.issuerAddress,
    issuerSeed: cfg.issuerSeed ? "[redacted]" : "[unset]",
    sponsor: cfg.sponsor,
    pinata: { jwt: cfg.pinata.jwt ? "[redacted]" : "[unset]", gateway: cfg.pinata.gateway },
    xumm: {
      apiKey: cfg.xumm.apiKey ? "[redacted]" : "[unset]",
      apiSecret: cfg.xumm.apiSecret ? "[redacted]" : "[unset]",
    },
    databaseUrl: cfg.databaseUrl ? "[redacted]" : "[unset]",
    defaultMetadataUri: cfg.defaultMetadataUri ?? "[unset]",
    admin: {
      email: cfg.admin.email ?? "[unset]",
      passwordHash: cfg.admin.passwordHash ? "[redacted]" : "[unset]",
      sessionSecret: cfg.admin.sessionSecret ? "[redacted]" : "[unset]",
      sessionTtlHours: cfg.admin.sessionTtlHours,
    },
    demoEnabled: cfg.demoEnabled,
    eventName: cfg.eventName ?? "[unset]",
    sourceTag: cfg.sourceTag ?? "[unset]",
    badgeImageUriMode: cfg.badgeImageUriMode,
    api: cfg.api,
  };
}
