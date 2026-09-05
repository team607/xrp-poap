/**
 * Badge metadata and artwork, served directly.
 *
 * WHY THIS EXISTS. Badges were pinned to IPFS and pointed at with `ipfs://`,
 * which is the XLS-24d standard. Measured, it does not work:
 *
 *   - `ipfs://<CID>` — Xaman and Bithomp both fail to resolve it. Pinata's
 *     free tier never announces content widely enough for a third-party
 *     gateway to find; only gateways we had explicitly warmed could serve it.
 *   - `https://gateway.pinata.cloud/ipfs/<CID>` — resolves, but takes
 *     **4 to 7 seconds for a 700-byte JSON**, consistently, even on a
 *     Cloudflare cache HIT. testnet.xrpl.org renders it because the fetch
 *     happens in the viewer's browser and waits. Bithomp and Xaman resolve
 *     server-side on a timeout, and give up.
 *
 * Generated here, the same bytes come back in milliseconds. The artwork is a
 * pure function of (address, eventId), so nothing is stored and nothing can
 * drift — the metadata and the PNG are computed per request.
 *
 * THE TRADE, AND IT IS PERMANENT. NFTokenMint's URI cannot be edited, so a
 * badge minted against this server depends on this origin resolving forever.
 * IPFS content survives its host; this does not. Attendance does not depend on
 * either — verifyClaim reads the accept transaction, so a dead image costs the
 * picture and never the proof.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ValidationError } from "../../errors.js";
import type { EventId } from "../../types.js";
import { assertValidAddress, assertValidTaxon } from "../../xrpl/encoding.js";
import { renderBadgeArt } from "../../metadata/badge-art.js";
import { artLabel } from "../../metadata/badge-uri-resolver.js";
import { buildBadgeMetadata } from "../../metadata/schema.js";
import { svgToPng } from "../../metadata/rasterise.js";
import type { ApiDeps } from "../deps.js";

const paramsSchema = z.object({
  eventId: z.coerce.number().int().min(0).max(2_147_483_647),
  address: z.string().min(25).max(40),
});

/** Deterministic output, so it can be cached hard and forever. */
const IMMUTABLE = "public, max-age=31536000, immutable";

function requireValid(eventId: EventId, address: string): void {
  assertValidTaxon(eventId);
  assertValidAddress(address, "address");
}

export interface BadgeRouteOptions {
  /**
   * Public origin these URLs are reachable at, e.g. https://badges.example.com.
   * Required to build the absolute `image` URL inside the metadata — a wallet
   * fetching the JSON has no way to resolve a relative path.
   */
  baseUrl?: string;
}

/**
 * What this badge should call its event.
 *
 * THE EVENT'S OWN NAME, not a server-wide setting. `EVENT_NAME` is one string
 * for the whole process, and a server hosting more than one event stamps all of
 * them with it — measured on production, where a REDTAPE badge came back named
 * after a different event entirely because that was what the variable said.
 * The events table already knows, per taxon, and has since events became rows.
 *
 * `EVENT_NAME` stays as the fallback rather than being removed: a deployment
 * with no events table configured, or a taxon minted before the row existed,
 * still has to render something, and "Event 700012" is worse than a name the
 * operator set on purpose.
 *
 * NEVER FAILS THE REQUEST. This decorates a badge; a database that is briefly
 * unreachable must not turn the artwork into a 500, because the metadata URI is
 * immutable and a wallet that gets an error may cache it.
 */
async function eventLabel(deps: ApiDeps, eventId: EventId): Promise<string | undefined> {
  try {
    const event = await deps.events?.find(eventId);
    if (event?.name) return event.name;
  } catch {
    // Fall through to the configured name. Nothing here is worth a 500.
  }
  return deps.config.eventName;
}

export function badgeMetadataUrl(baseUrl: string, eventId: EventId, address: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/badge/${eventId}/${address}.json`;
}

export function badgeImageUrl(baseUrl: string, eventId: EventId, address: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/badge/${eventId}/${address}.png`;
}

export function registerBadgeRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
  options: BadgeRouteOptions = {},
): void {
  const baseUrl = options.baseUrl ?? deps.config.badgeBaseUrl;

  /** The artwork. Rasterised per request; deterministic, so cache forever. */
  app.get<{ Params: { eventId: number; address: string } }>(
    "/badge/:eventId/:address.png",
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const { eventId, address } = request.params;
      requireValid(eventId, address);
      const name = await eventLabel(deps, eventId);
      const { svg } = renderBadgeArt({
        address,
        eventId,
        ...(name ? { eventName: artLabel(name) } : {}),
      });
      return reply
        .code(200)
        .type("image/png")
        .header("cache-control", IMMUTABLE)
        .header("x-content-type-options", "nosniff")
        .send(svgToPng(svg));
    },
  );

  /** The metadata. This is what goes in NFTokenMint's URI. */
  app.get<{ Params: { eventId: number; address: string } }>(
    "/badge/:eventId/:address.json",
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const { eventId, address } = request.params;
      requireValid(eventId, address);

      if (!baseUrl) {
        // Without an origin the `image` field would be relative, which no
        // wallet can resolve. Fail loudly rather than serve a broken document.
        throw new ValidationError(
          "CONFIG_INVALID",
          "BADGE_BASE_URL is not set, so badge metadata cannot name an absolute image URL.",
        );
      }

      const name = await eventLabel(deps, eventId);
      const label = name ? artLabel(name) : `Event ${eventId}`;
      const art = renderBadgeArt({
        address,
        eventId,
        ...(name ? { eventName: label } : {}),
      });
      const short = `${address.slice(0, 6)}…${address.slice(-4)}`;

      const metadata = buildBadgeMetadata({
        name: `${label} · ${short}`,
        description:
          `Proof of attendance for ${label}, issued on the XRP Ledger. Soulbound to ${address}; ` +
          "the artwork is derived from that address and can be regenerated from it.",
        imageUri: badgeImageUrl(baseUrl, eventId, address),
        eventId,
        ...(name ? { eventName: label } : {}),
        extraAttributes: [
          { trait_type: "attendee", value: address },
          { trait_type: "art_palette", value: art.traits.palette },
          { trait_type: "art_core", value: art.traits.core },
          { trait_type: "art_traces", value: art.traits.traces },
          { trait_type: "art_density", value: art.traits.density },
        ],
      });

      // Emit the shape indexers actually read, not the fullest one.
      //
      // XLS-24d's `schema` and `nftType` are optional, and `schema` is an
      // ipfs:// URL — which we have measured Xaman and Bithomp cannot resolve.
      // An indexer that tries to fetch the schema to validate the document
      // stalls on it and reports the metadata as missing. A working testnet
      // NFT on Bithomp carries neither field and a plain string `collection`,
      // which is the widely-implemented convention. Match that: the extra
      // fields buy nothing if they stop the badge rendering at all.
      const { schema: _schema, nftType: _nftType, collection, ...rest } = metadata;
      return reply
        .code(200)
        .type("application/json; charset=utf-8")
        .header("cache-control", IMMUTABLE)
        .send({
          ...rest,
          ...(collection ? { collection: collection.name } : {}),
        });
    },
  );
}
