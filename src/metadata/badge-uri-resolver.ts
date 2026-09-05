/**
 * Per-attendee badge art, resolved to the URI that goes on chain.
 *
 * Two tiers, and the order matters. Before the event an operator pre-pins the
 * art for a roster of expected attendees (`npm run prepin`); at the desk a
 * claim looks the attendee up and gets a URI without touching the network. The
 * walk-up who was never on the list still gets a badge — their art is pinned
 * inside the claim — but that is the slow path, not the design.
 *
 * The manifest is the seam between the two. It is a plain JSON file mapping
 * classic address to the pair of URIs already pinned for it, written by the
 * script and read by the API. It is a CACHE, never a source of truth: losing
 * it costs a re-pin, and every failure in here is therefore a warning and a
 * re-pin rather than an exception thrown into an attendee's claim.
 *
 * Nothing here touches the ledger and nothing here logs a secret: the pinner
 * holds the Pinata JWT in a private field and is never serialised.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MetadataError } from "../errors.js";
import {
  MAX_URI_BYTES,
  type BadgeAttribute,
  type BadgeUri,
  type BadgeUriResolver,
  type EventId,
  type IpfsPinner,
} from "../types.js";
import { assertValidAddress, assertValidTaxon } from "../xrpl/encoding.js";
import { renderBadgeArt } from "./badge-art.js";
import { warmGateways } from "./pinata.js";
import { svgToPng } from "./rasterise.js";
import { publishBadge } from "./publish.js";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface BadgeManifestEntry {
  /** ipfs:// URI of the metadata JSON. This is what NFTokenMint carries. */
  metadataUri: string;
  /** ipfs:// URI of the artwork the metadata points at. */
  imageUri: string;
  /** ISO-8601. Informational — the manifest is a cache, not an audit trail. */
  pinnedAt: string;
}

export interface BadgeManifest {
  eventId: number;
  createdAt: string;
  /** Keyed by classic address. */
  entries: Record<string, BadgeManifestEntry>;
}

/** Manifests live beside the other operator output, which is gitignored. */
export const DEFAULT_MANIFEST_DIR = "out";

/**
 * Where the manifest for one event lives.
 *
 * Exported and used by BOTH the script that writes it and the resolver that
 * reads it, so the two cannot drift apart. A pre-pinned roster the API cannot
 * find is worse than no roster at all: it looks like it worked and then pins
 * every badge again at the desk.
 */
export function badgeManifestPath(eventId: EventId, dir: string = DEFAULT_MANIFEST_DIR): string {
  return join(dir, `badge-manifest-${eventId}.json`);
}

export function emptyBadgeManifest(eventId: EventId): BadgeManifest {
  return { eventId, createdAt: new Date().toISOString(), entries: {} };
}

/** Reported rather than thrown: every problem in here is survivable. */
export type ManifestWarn = (message: string, cause?: unknown) => void;

const defaultWarn: ManifestWarn = (message) => {
  console.warn(`[badge-manifest] ${message}`);
};

function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceEntry(value: unknown): BadgeManifestEntry | null {
  if (!isRecord(value)) return null;
  const { metadataUri, imageUri, pinnedAt } = value;
  if (typeof metadataUri !== "string" || metadataUri === "") return null;
  if (typeof imageUri !== "string") return null;
  return {
    metadataUri,
    imageUri,
    pinnedAt: typeof pinnedAt === "string" ? pinnedAt : "",
  };
}

export interface LoadBadgeManifestOptions {
  /**
   * The event the manifest must belong to. A file that claims a different
   * event is treated as corrupt rather than used: its entries point at art
   * generated for other badges, and NFTokenMint's URI cannot be edited after
   * the fact.
   */
  eventId: EventId;
  onWarn?: ManifestWarn;
}

/**
 * Read a manifest. NEVER throws.
 *
 * A missing file is an empty manifest — that is the first run. A corrupt file
 * is also an empty manifest, loudly: a half-written JSON blob must cost one
 * re-pin, not the event. Individually malformed entries are dropped and the
 * rest of the file is kept.
 */
export async function loadBadgeManifest(
  path: string,
  options: LoadBadgeManifestOptions,
): Promise<BadgeManifest> {
  const { eventId } = options;
  const warn = options.onWarn ?? defaultWarn;

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      warn(
        `Cannot read ${path} (${describe(cause)}). Continuing with an empty manifest; ` +
          "every badge for this event will be pinned on demand.",
        cause,
      );
    }
    return emptyBadgeManifest(eventId);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    warn(
      `${path} is not valid JSON (${describe(cause)}). Treating it as empty; ` +
        "badges will be re-pinned on demand and the file will be rewritten.",
      cause,
    );
    return emptyBadgeManifest(eventId);
  }

  if (!isRecord(parsed) || !isRecord(parsed["entries"])) {
    warn(`${path} is not a badge manifest. Treating it as empty.`);
    return emptyBadgeManifest(eventId);
  }

  if (parsed["eventId"] !== eventId) {
    warn(
      `${path} belongs to event ${String(parsed["eventId"])}, not ${eventId}. Its entries ` +
        "point at another event's artwork, so they are ignored and the file will be rewritten.",
    );
    return emptyBadgeManifest(eventId);
  }

  const entries: Record<string, BadgeManifestEntry> = {};
  let dropped = 0;
  for (const [address, value] of Object.entries(parsed["entries"])) {
    const entry = coerceEntry(value);
    if (entry === null) {
      dropped += 1;
      continue;
    }
    entries[address] = entry;
  }
  if (dropped > 0) {
    warn(`${path}: dropped ${dropped} malformed entr${dropped === 1 ? "y" : "ies"}; they will be re-pinned.`);
  }

  const createdAt = parsed["createdAt"];
  return {
    eventId,
    createdAt: typeof createdAt === "string" ? createdAt : new Date().toISOString(),
    entries,
  };
}

/**
 * Write a manifest atomically: full write to a temp file in the same
 * directory, then a rename, which is atomic on POSIX. A crash mid-write
 * therefore leaves either the old manifest or the new one — never a truncated
 * file that fails to parse on the morning of the event.
 */
export async function saveBadgeManifest(path: string, manifest: BadgeManifest): Promise<void> {
  const dir = dirname(path);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } catch (cause) {
    await unlink(tmp).catch(() => undefined);
    throw new MetadataError(
      "PIN_FAILED",
      `Could not write the badge manifest ${path}: ${describe(cause)}`,
      { path, entries: Object.keys(manifest.entries).length },
    );
  }
}

// ---------------------------------------------------------------------------
// Art label hygiene
// ---------------------------------------------------------------------------

/** renderBadgeArt() trims the label to 22 characters after uppercasing it. */
const ART_LABEL_MAX = 22;

/**
 * An operator-supplied event name goes straight into an SVG text node.
 *
 * A classic address is base58 and cannot carry XML metacharacters, but
 * "Rock & Roll 2026" can, and an unescaped `&` makes the whole document
 * unparseable — permanently, because the CID is minted into an immutable URI.
 * Escaping is not an option: the generator uppercases and slices the label
 * afterwards, which would turn `&amp;` into `&AMP;` or cut it in half. So the
 * metacharacters are removed, and the label is pre-trimmed on a code point
 * boundary so the generator's own slice cannot split a surrogate pair.
 *
 * The unmodified name still reaches the metadata as the `event_name` trait.
 */
export function artLabel(name: string): string {
  const stripped = name.replace(/[&<>"']/g, " ").replace(/\s+/g, " ").trim();
  if (stripped.toUpperCase().length <= ART_LABEL_MAX) return stripped;
  let out = "";
  for (const ch of stripped) {
    if (out.toUpperCase().length + ch.toUpperCase().length > ART_LABEL_MAX) break;
    out += ch;
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// Traits
// ---------------------------------------------------------------------------

/**
 * The attendee, plus the four parameters that generated their artwork. Without
 * these the JSON only points at an image; with them it describes one.
 */
export const TRAIT_ATTENDEE = "attendee";
export const TRAIT_ART_PALETTE = "art_palette";
export const TRAIT_ART_CORE = "art_core";
export const TRAIT_ART_TRACES = "art_traces";
export const TRAIT_ART_DENSITY = "art_density";

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

export interface PinningBadgeUriResolverOptions {
  pinner: IpfsPinner;
  /**
   * Manifest file. Defaults to `out/badge-manifest-<eventId>.json`, which is
   * per event; an explicit path pins this resolver to ONE event, because a
   * manifest holding another event's ids is discarded on load.
   */
  manifestPath?: string;
  /** Printed on the badge and recorded as the `event_name` trait. */
  eventName?: string;
  /**
   * The event's OWN name, looked up per taxon.
   *
   * Preferred over `eventName` above, which is one string for the whole
   * process and therefore wrong the moment a server hosts a second event —
   * measured on production, where badges for one event came back named after
   * another. This resolver bakes the name into pinned JSON, so getting it from
   * the events table matters more here than anywhere: IPFS content cannot be
   * corrected afterwards the way a self-hosted document can.
   *
   * Optional, and `eventName` stays as the fallback: a deployment with no
   * events table still has to render something.
   */
  lookupEventName?: (eventId: EventId) => Promise<string | undefined>;
  eventDate?: string;
  venue?: string;
  collection?: { name: string; family?: string };
  /** Overrides the generated per-attendee description. */
  description?: string;
  /**
   * Write new entries back to the manifest. Default true. A dry run sets this
   * false: its CIDs are fake and caching them would poison the real run.
   */
  persist?: boolean;
  /**
   * What the metadata's `image` points at. Defaults to "https" — the one that
   * actually renders, because a freshly pinned CID is unfindable on public
   * gateways for hours and the choice is permanent per badge. See
   * AppConfig.badgeImageUriMode.
   */
  imageUriMode?: "ipfs" | "https";
  /** What NFTokenMint's URI points at. Defaults to "https" — see AppConfig. */
  metadataUriMode?: "ipfs" | "https";
  /** Called once per address that was actually pinned. Never on a cache hit. */
  onPin?: (address: string, uri: BadgeUri) => void;
  onWarn?: ManifestWarn;
}

/**
 * Resolves a badge URI from the manifest, pinning the art when it is missing.
 *
 * Idempotent per (eventId, address) in two layers: the manifest survives a
 * restart, and an in-flight promise map collapses simultaneous claims for the
 * same attendee into a single pin. Without the second layer two volunteers
 * scanning the same badge at once produce two CIDs, two Pinata charges, and
 * two different images for one person.
 */
export class PinningBadgeUriResolver implements BadgeUriResolver {
  readonly #pinner: IpfsPinner;
  readonly #manifestPath: string | undefined;
  readonly #options: PinningBadgeUriResolverOptions;
  readonly #persist: boolean;
  readonly #warn: ManifestWarn;

  /** path -> manifest, once loaded. */
  readonly #manifests = new Map<string, BadgeManifest>();
  /** path -> in-flight load, so a burst of first claims reads the file once. */
  readonly #loading = new Map<string, Promise<BadgeManifest>>();
  /** `${eventId}:${address}` -> in-flight resolve. THE dedupe. */
  readonly #inflight = new Map<string, Promise<BadgeUri>>();
  /** path -> tail of the write chain. Serialised so a slow write cannot
   *  overwrite a newer manifest with an older snapshot. */
  readonly #writes = new Map<string, Promise<void>>();

  constructor(options: PinningBadgeUriResolverOptions) {
    this.#pinner = options.pinner;
    this.#manifestPath = options.manifestPath;
    this.#options = options;
    this.#persist = options.persist ?? true;
    this.#warn = options.onWarn ?? defaultWarn;
  }

  /** The file this resolver reads and writes for one event. */
  manifestPathFor(eventId: EventId): string {
    return this.#manifestPath ?? badgeManifestPath(eventId);
  }

  async resolve(input: { eventId: EventId; address: string }): Promise<BadgeUri> {
    const { eventId, address } = input;
    assertValidTaxon(eventId);
    assertValidAddress(address, "attendee address");

    const key = `${eventId}:${address}`;
    const existing = this.#inflight.get(key);
    if (existing !== undefined) return existing;

    // Registered before the first await, so a second caller in the same tick
    // finds it. On settle the entry is dropped: the manifest is the cache from
    // then on, and a failed pin must be retryable rather than sticky.
    const tracked = this.#resolveOne(eventId, address).finally(() => {
      if (this.#inflight.get(key) === tracked) this.#inflight.delete(key);
    });
    this.#inflight.set(key, tracked);
    return tracked;
  }

  /** Wait for every queued manifest write. Call before exiting a script. */
  async flush(): Promise<void> {
    await Promise.all([...this.#writes.values()]);
  }

  /** Entries known for this event, loading the manifest if it has not been. */
  async entryCount(eventId: EventId): Promise<number> {
    const manifest = await this.#manifestFor(eventId);
    return Object.keys(manifest.entries).length;
  }

  /** Never throws: a name is decoration, and this runs mid-claim. */
  async #eventName(eventId: EventId): Promise<string | undefined> {
    if (!this.#options.lookupEventName) return undefined;
    try {
      return await this.#options.lookupEventName(eventId);
    } catch {
      return undefined;
    }
  }

  async #resolveOne(eventId: EventId, address: string): Promise<BadgeUri> {
    const manifest = await this.#manifestFor(eventId);

    const hit = manifest.entries[address];
    if (hit !== undefined) {
      return { metadataUri: hit.metadataUri, imageUri: hit.imageUri, pinnedOnDemand: false };
    }

    const eventName = (await this.#eventName(eventId)) ?? this.#options.eventName;
    // An empty label is worse than none: renderBadgeArt only falls back to
    // "EVENT <id>" for undefined, so a name that is entirely metacharacters
    // would leave the badge captionless.
    const caption = eventName === undefined ? "" : artLabel(eventName);
    const art = renderBadgeArt({
      address,
      eventId,
      ...(caption === "" ? {} : { eventName: caption }),
    });

    const label = eventName ?? `Event ${eventId}`;
    const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
    const extraAttributes: BadgeAttribute[] = [
      { trait_type: TRAIT_ATTENDEE, value: address },
      { trait_type: TRAIT_ART_PALETTE, value: art.traits.palette },
      { trait_type: TRAIT_ART_CORE, value: art.traits.core },
      { trait_type: TRAIT_ART_TRACES, value: art.traits.traces },
      { trait_type: TRAIT_ART_DENSITY, value: art.traits.density },
    ];

    // PNG, not the SVG we just generated. Xaman renders an SVG badge as a
      // blank tile, and NFTokenMint's URI cannot be edited afterwards, so a
      // format a wallet will not draw is a permanent defect. The SVG stays the
      // source of truth and is what /demo/art serves to our own pages.
      const png = svgToPng(art.svg);

      const published = await publishBadge(this.#pinner, {
        imageUriMode: this.#options.imageUriMode ?? "https",
        metadataUriMode: this.#options.metadataUriMode ?? "https",
      image: {
        data: png,
        filename: `badge-${eventId}-${address}.png`,
        contentType: "image/png",
      },
      metadata: {
        name: `${label} · ${short}`,
        description:
          this.#options.description ??
          `Proof of attendance for ${label}, issued on the XRP Ledger. Soulbound to ${address}; ` +
            "the artwork is derived from that address and can be regenerated from it.",
        eventId,
        ...(eventName === undefined ? {} : { eventName }),
        ...(this.#options.eventDate === undefined ? {} : { eventDate: this.#options.eventDate }),
        ...(this.#options.venue === undefined ? {} : { venue: this.#options.venue }),
        ...(this.#options.collection === undefined ? {} : { collection: this.#options.collection }),
        extraAttributes,
      },
    });

    // Start propagation now rather than when a wallet first asks for it. A
    // freshly pinned CID 504s on public gateways for hours, and a wallet
    // resolves ipfs:// through its own gateway, not ours.
    //
    // BOTH CIDs, and the image especially. Warming only the metadata leaves a
    // wallet able to read the JSON and then fail on the picture it points at —
    // measured exactly that way: metadata 200 from ipfs.io in 0.13s while the
    // image still 504'd. The image is also the larger object, so it is the one
    // that needs the head start.
    //
    // Fire and forget: warming is best effort and must never fail a claim.
    for (const uriToWarm of [published.imageUri, published.metadataUri]) {
      const cid = uriToWarm.replace(/^ipfs:\/\//, "").split("/")[0];
      if (cid) void warmGateways(cid).catch(() => undefined);
    }

    const uri: BadgeUri = {
      metadataUri: published.metadataUri,
      imageUri: published.imageUri,
      pinnedOnDemand: true,
    };

    manifest.entries[address] = {
      metadataUri: uri.metadataUri,
      imageUri: uri.imageUri,
      pinnedAt: new Date().toISOString(),
    };
    if (this.#persist) await this.#save(this.manifestPathFor(eventId), manifest);

    this.#options.onPin?.(address, uri);
    return uri;
  }

  async #manifestFor(eventId: EventId): Promise<BadgeManifest> {
    const path = this.manifestPathFor(eventId);
    const cached = this.#manifests.get(path);
    if (cached !== undefined) return cached;
    const loading = this.#loading.get(path);
    if (loading !== undefined) return loading;

    const pending = loadBadgeManifest(path, { eventId, onWarn: this.#warn })
      .then((manifest) => {
        this.#manifests.set(path, manifest);
        return manifest;
      })
      .finally(() => {
        this.#loading.delete(path);
      });
    this.#loading.set(path, pending);
    return pending;
  }

  /**
   * Queue a write behind any write already running for this path.
   *
   * Unserialised, two concurrent saves each serialise their own snapshot and
   * the slower rename wins — silently dropping whichever entry landed in
   * between. Never rejects: the badge is already pinned, and failing a claim
   * because a cache file would not write would be the wrong trade.
   */
  #save(path: string, manifest: BadgeManifest): Promise<void> {
    const prior = this.#writes.get(path) ?? Promise.resolve();
    const next = prior
      .then(() => saveBadgeManifest(path, manifest))
      .catch((cause: unknown) => {
        this.#warn(
          `${describe(cause)} — the badge is pinned and usable, but this entry is not cached, ` +
            "so a restart will pin it again.",
          cause,
        );
      });
    this.#writes.set(path, next);
    return next;
  }
}

/**
 * One image for the whole event: every attendee gets the same URI.
 *
 * This is the fallback when no Pinata JWT is configured — a shared badge is a
 * degraded event, a failed claim is a ruined one.
 */
export class StaticBadgeUriResolver implements BadgeUriResolver {
  readonly metadataUri: string;
  readonly imageUri: string;

  constructor(uri: string | { metadataUri: string; imageUri?: string }) {
    // `uri?.` rather than `uri.`: a caller passing an unset EVENT_METADATA_URI
    // should get the sentence below, not a TypeError three frames down.
    const metadataUri = typeof uri === "string" ? uri : uri?.metadataUri;
    if (typeof metadataUri !== "string" || metadataUri.trim() === "") {
      throw new MetadataError(
        "METADATA_INVALID",
        "StaticBadgeUriResolver needs a metadata URI (EVENT_METADATA_URI). " +
          "Pin one with `npm run publish:badge`.",
      );
    }
    const bytes = Buffer.byteLength(metadataUri, "utf8");
    if (bytes > MAX_URI_BYTES) {
      throw new MetadataError(
        "URI_TOO_LONG",
        `Metadata URI is ${bytes} bytes; NFTokenMint's URI field caps at ${MAX_URI_BYTES}.`,
        { bytes, max: MAX_URI_BYTES },
      );
    }
    this.metadataUri = metadataUri;
    // Empty when only a metadata URI is known: the artwork is named inside
    // that document and this resolver does not fetch it to find out.
    this.imageUri = (typeof uri === "string" ? undefined : uri.imageUri) ?? "";
  }

  /** The input is ignored on purpose: one badge, every attendee. */
  async resolve(_input?: { eventId: EventId; address: string }): Promise<BadgeUri> {
    return {
      metadataUri: this.metadataUri,
      imageUri: this.imageUri,
      pinnedOnDemand: false,
    };
  }
}

/**
 * Badge URIs served by this application, with no pinning at all.
 *
 * WHY THIS EXISTS, MEASURED END TO END:
 *   - `ipfs://<CID>` — Xaman and Bithomp cannot resolve it. Pinata's free tier
 *     never announces content widely enough for a third-party gateway to find;
 *     only gateways we had explicitly warmed ever served it.
 *   - `https://gateway.pinata.cloud/ipfs/<CID>` — resolves, but takes 4-7
 *     SECONDS for a 700-byte JSON even on a cache hit. Browser-side viewers
 *     wait; server-side indexers time out and report the metadata missing.
 *   - Served from here — ~3ms locally, and it renders.
 *
 * There is nothing to pin, nothing to propagate and no manifest: the artwork
 * and the metadata are pure functions of (eventId, address), computed per
 * request by registerBadgeRoutes.
 *
 * THE TRADE IS PERMANENT. NFTokenMint's URI cannot be edited, so every badge
 * minted this way depends on `baseUrl` resolving forever. IPFS content outlives
 * its host; this does not. Never point baseUrl at a tunnel or a hostname you
 * might not keep. Attendance is unaffected either way — verifyClaim reads the
 * accept transaction, so a dead URL costs the picture and never the proof.
 */
export class SelfHostedBadgeUriResolver implements BadgeUriResolver {
  readonly #baseUrl: string;

  constructor(options: { baseUrl: string }) {
    const base = options.baseUrl.replace(/\/+$/, "");
    if (!/^https?:\/\//.test(base)) {
      throw new MetadataError(
        "CONFIG_INVALID",
        `BADGE_BASE_URL must be an absolute http(s) origin, got "${options.baseUrl}"`,
        { baseUrl: options.baseUrl },
      );
    }
    this.#baseUrl = base;
  }

  async resolve(input: { eventId: EventId; address: string }): Promise<BadgeUri> {
    assertValidTaxon(input.eventId);
    assertValidAddress(input.address, "address");
    const metadataUri = `${this.#baseUrl}/badge/${input.eventId}/${input.address}.json`;
    if (Buffer.byteLength(metadataUri, "utf8") > MAX_URI_BYTES) {
      throw new MetadataError(
        "URI_TOO_LONG",
        `Badge URI is ${Buffer.byteLength(metadataUri, "utf8")} bytes; NFTokenMint caps at ${MAX_URI_BYTES}. Use a shorter BADGE_BASE_URL.`,
        { metadataUri },
      );
    }
    return {
      metadataUri,
      imageUri: `${this.#baseUrl}/badge/${input.eventId}/${input.address}.png`,
      // Nothing is pinned, so nothing was pinned during the claim.
      pinnedOnDemand: false,
    };
  }
}
