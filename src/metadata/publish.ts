/**
 * Build order step 4: upload the badge image and JSON to IPFS, return the CID.
 *
 * Order matters — the image has to be content-addressed before the metadata
 * that references it can be written, and the metadata has to be valid before
 * it is pinned, because pinning is the last moment anything is still cheap to
 * change. This module never logs and never touches the ledger.
 */
import { MetadataError } from "../errors.js";
import { MAX_URI_BYTES, type BadgeMetadata, type IpfsPinner, type PinResult } from "../types.js";
import {
  assertValidBadgeMetadata,
  buildBadgeMetadata,
  type BuildBadgeMetadataInput,
} from "./schema.js";

/** Either raw bytes to pin, or an image already living on IPFS. */
export type PublishBadgeImage =
  | { data: Uint8Array | Buffer; filename: string; contentType?: string }
  | { alreadyPinnedUri: string };

export interface PublishBadgeInput {
  image: PublishBadgeImage;
  /**
   * What the metadata's `image` field points at.
   *
   * "ipfs" is the purist answer — content-addressed, no host to trust. It is
   * also the one that fails on arrival: a freshly pinned CID is unfindable on
   * public gateways for hours, and a wallet resolves ipfs:// through its own
   * gateway, not ours. Measured: a 676-byte metadata JSON propagated to
   * ipfs.io in seconds while its 313 KB PNG still 504'd long after.
   *
   * "https" points at the pinning service's gateway, which serves the bytes
   * immediately. The trade is real and permanent — the metadata CID is
   * embedded in an immutable NFTokenMint URI, so this choice cannot be changed
   * for a badge once minted. Pick "ipfs" when you can pre-pin well ahead of
   * the event; pick "https" when a badge must render the moment it lands.
   */
  imageUriMode?: "ipfs" | "https";
  /**
   * What goes in NFTokenMint's URI field — the pointer to the metadata JSON.
   *
   * "ipfs" is the standard and what XLS-24d specifies. It is also, measured
   * across Xaman, Bithomp and testnet.xrpl.org, the one nothing renders: they
   * display the raw `ipfs://CID` string and never resolve it. A correct URI
   * that no viewer follows is worth nothing to an attendee looking at a blank
   * tile.
   *
   * "https" puts the pinning gateway's URL on the token, so any viewer can
   * fetch it with a plain GET and no IPFS resolution at all. The CID is still
   * inside that URL, so the content stays content-addressed and re-pinnable —
   * what breaks if the gateway dies is the URL, not the bytes.
   *
   * PERMANENT PER BADGE: NFTokenMint's URI cannot be edited.
   */
  metadataUriMode?: "ipfs" | "https";
  /** Everything buildBadgeMetadata needs except the image URI, which we derive. */
  metadata: Omit<BuildBadgeMetadataInput, "imageUri">;
}

export interface PublishBadgeResult {
  metadata: BadgeMetadata;
  /** ipfs:// URI of the artwork. */
  imageUri: string;
  /** ipfs:// URI of the JSON. This is what goes in NFTokenMint's URI field. */
  metadataUri: string;
  /** The metadata pin, including its public gateway URL. */
  pin: PinResult;
}

function isAlreadyPinned(
  image: PublishBadgeImage,
): image is { alreadyPinnedUri: string } {
  return "alreadyPinnedUri" in image;
}

/**
 * The 256-byte cap from section 5.1 and gotcha 10, asserted here rather than
 * at mint time so a bad URI is caught before anything is written to a ledger
 * that cannot be edited. A bare `ipfs://<cid>` is around 60 bytes, so this
 * only ever bites when a caller appends a long path or query to the CID.
 */
function assertUriFitsMintField(uri: string): void {
  const bytes = Buffer.byteLength(uri, "utf8");
  if (bytes > MAX_URI_BYTES) {
    throw new MetadataError(
      "URI_TOO_LONG",
      `Metadata URI is ${bytes} bytes; NFTokenMint's URI field caps at ${MAX_URI_BYTES}. A bare ipfs://<cid> is ~60 bytes, so something long is appended to the CID.`,
      { uri, bytes, max: MAX_URI_BYTES },
    );
  }
}

export async function publishBadge(
  pinner: IpfsPinner,
  input: PublishBadgeInput,
): Promise<PublishBadgeResult> {
  // 1. The image, so we have something to point `image` at.
  let imageUri: string;
  if (isAlreadyPinned(input.image)) {
    imageUri = input.image.alreadyPinnedUri;
    if (!imageUri.startsWith("ipfs://")) {
      throw new MetadataError(
        "METADATA_INVALID",
        `alreadyPinnedUri must be an ipfs:// URI, got "${imageUri}"`,
        { alreadyPinnedUri: imageUri },
      );
    }
  } else {
    const imagePin = await pinner.pinFile(input.image);
    imageUri = input.imageUriMode === "https" ? imagePin.gatewayUrl : imagePin.uri;
  }

  // 2. Build, 3. validate. Never pin a document we would reject on the way back.
  const metadata = buildBadgeMetadata({ ...input.metadata, imageUri });
  assertValidBadgeMetadata(metadata);

  // 4. Pin the JSON. Its URI is the one that goes on chain.
  const pin = await pinner.pinJson({
    json: metadata,
    name: `badge-${input.metadata.eventId}-metadata.json`,
  });

  // This is the string that goes on the ledger and can never be changed.
  const metadataUri = input.metadataUriMode === "ipfs" ? pin.uri : pin.gatewayUrl;
  assertUriFitsMintField(metadataUri);

  return { metadata, imageUri, metadataUri, pin };
}
