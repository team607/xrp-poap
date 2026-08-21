/**
 * Badge metadata and IPFS pipeline (brief section 8, step 4).
 *
 * Typical use: `publishBadge(new PinataPinner({ jwt }), { image, metadata })`,
 * then hand the returned `metadataUri` to the mint builder.
 */
export {
  BADGE_NFT_TYPE,
  TRAIT_EVENT_DATE,
  TRAIT_EVENT_ID,
  TRAIT_EVENT_NAME,
  TRAIT_VENUE,
  XLS24D_SCHEMA_URI,
  assertValidBadgeMetadata,
  badgeAttributeSchema,
  badgeCollectionSchema,
  badgeMetadataSchema,
  buildBadgeMetadata,
  isValidBadgeMetadata,
  type BuildBadgeMetadataInput,
} from "./schema.js";

export {
  DEFAULT_PINATA_GATEWAY,
  PINATA_API_BASE,
  PinataPinner,
  checkGatewayResolves,
  type GatewayCheckResult,
  type PinataOptions,
} from "./pinata.js";

export {
  MEMORY_CID_PREFIX,
  MEMORY_GATEWAY,
  MemoryPinner,
  fakeCidFor,
  getPinned,
  type MemoryPinEntry,
  type MemoryPinnerOptions,
} from "./memory-pinner.js";

export {
  publishBadge,
  type PublishBadgeImage,
  type PublishBadgeInput,
  type PublishBadgeResult,
} from "./publish.js";

export { renderBadgeArt, type BadgeArt, type BadgeArtInput } from "./badge-art.js";

export {
  DEFAULT_MANIFEST_DIR,
  PinningBadgeUriResolver,
  StaticBadgeUriResolver,
  TRAIT_ART_CORE,
  TRAIT_ART_DENSITY,
  TRAIT_ART_PALETTE,
  TRAIT_ART_TRACES,
  TRAIT_ATTENDEE,
  artLabel,
  badgeManifestPath,
  emptyBadgeManifest,
  loadBadgeManifest,
  saveBadgeManifest,
  type BadgeManifest,
  type BadgeManifestEntry,
  type LoadBadgeManifestOptions,
  type ManifestWarn,
  type PinningBadgeUriResolverOptions,
} from "./badge-uri-resolver.js";
