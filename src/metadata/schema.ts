/**
 * XLS-24d shaped badge metadata: the JSON the NFTokenMint URI points at.
 *
 * Section 5.1 of the brief: the URI points at the metadata JSON, not the
 * image. The image lives inside this document as an `ipfs://` URI. Anything
 * that ends up on chain is immutable, so the JSON is validated before it is
 * pinned, never after.
 */
import { z } from "zod";
import { MetadataError } from "../errors.js";
import { MAX_TAXON, type BadgeAttribute, type BadgeMetadata } from "../types.js";

/** The published XLS-24d schema document. Every badge points at this. */
export const XLS24D_SCHEMA_URI =
  "ipfs://QmNpi8rcXEkohca8iXu7zysKKSJYqCvBJn3xJwga8jXqWU";

/** XLS-24d nftType for a static image collectible. */
export const BADGE_NFT_TYPE = "art.v0" as const;

/**
 * Trait names. `event_id` mirrors the NFTokenTaxon so the JSON is
 * self-describing: given only the metadata you can still work out which event
 * a badge belongs to without a ledger round trip.
 */
export const TRAIT_EVENT_ID = "event_id";
export const TRAIT_EVENT_NAME = "event_name";
export const TRAIT_EVENT_DATE = "event_date";
export const TRAIT_VENUE = "venue";

/** `image` must be a content address. An https:// image can be swapped later. */
const IPFS_URI = /^ipfs:\/\//;

export const badgeAttributeSchema = z.object({
  trait_type: z.string().min(1),
  value: z.union([z.string(), z.number()]),
});

export const badgeCollectionSchema = z.object({
  name: z.string().min(1),
  family: z.string().min(1).optional(),
});

/**
 * Loose rather than strict: XLS-24d permits extra top-level keys and dropping
 * someone else's fields on the floor while validating would be surprising.
 */
export const badgeMetadataSchema = z.looseObject({
  schema: z.string().min(1),
  nftType: z.literal(BADGE_NFT_TYPE),
  name: z.string().min(1),
  description: z.string(),
  image: z.string().regex(IPFS_URI, "image must be an ipfs:// URI"),
  collection: badgeCollectionSchema.optional(),
  attributes: z.array(badgeAttributeSchema),
});

export interface BuildBadgeMetadataInput {
  name: string;
  description: string;
  /** ipfs:// URI of the artwork, i.e. the result of pinning the image. */
  imageUri: string;
  /** Doubles as the NFTokenTaxon. */
  eventId: number;
  eventName?: string;
  eventDate?: string;
  venue?: string;
  collection?: { name: string; family?: string };
  extraAttributes?: BadgeAttribute[];
}

/**
 * Assembles the metadata document. Pure and total apart from the taxon guard —
 * validation is a separate step so callers can inspect what they built before
 * it is pinned.
 */
export function buildBadgeMetadata(input: BuildBadgeMetadataInput): BadgeMetadata {
  if (!Number.isInteger(input.eventId) || input.eventId < 0 || input.eventId > MAX_TAXON) {
    throw new MetadataError(
      "INVALID_TAXON",
      `eventId must be an integer in [0, ${MAX_TAXON}], got ${input.eventId}`,
      { eventId: input.eventId, max: MAX_TAXON },
    );
  }

  const attributes: BadgeAttribute[] = [
    { trait_type: TRAIT_EVENT_ID, value: input.eventId },
  ];
  if (input.eventName !== undefined) {
    attributes.push({ trait_type: TRAIT_EVENT_NAME, value: input.eventName });
  }
  if (input.eventDate !== undefined) {
    attributes.push({ trait_type: TRAIT_EVENT_DATE, value: input.eventDate });
  }
  if (input.venue !== undefined) {
    attributes.push({ trait_type: TRAIT_VENUE, value: input.venue });
  }
  if (input.extraAttributes?.length) {
    attributes.push(...input.extraAttributes);
  }

  const metadata: BadgeMetadata = {
    schema: XLS24D_SCHEMA_URI,
    nftType: BADGE_NFT_TYPE,
    name: input.name,
    description: input.description,
    image: input.imageUri,
    attributes,
  };
  if (input.collection) {
    metadata.collection = { name: input.collection.name };
    if (input.collection.family !== undefined) {
      metadata.collection.family = input.collection.family;
    }
  }
  return metadata;
}

/** Parses and returns the document, or throws with every zod issue attached. */
export function assertValidBadgeMetadata(value: unknown): BadgeMetadata {
  const result = badgeMetadataSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      code: issue.code,
      message: issue.message,
    }));
    throw new MetadataError(
      "METADATA_INVALID",
      `Badge metadata is invalid: ${issues.map((i) => `${i.path || "<root>"} ${i.message}`).join("; ")}`,
      { issues },
    );
  }
  return result.data;
}

/** Non-throwing variant, for callers that want to report every issue at once. */
export function isValidBadgeMetadata(value: unknown): value is BadgeMetadata {
  return badgeMetadataSchema.safeParse(value).success;
}
