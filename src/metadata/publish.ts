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
    imageUri = imagePin.uri;
  }

  // 2. Build, 3. validate. Never pin a document we would reject on the way back.
  const metadata = buildBadgeMetadata({ ...input.metadata, imageUri });
  assertValidBadgeMetadata(metadata);

  // 4. Pin the JSON. Its URI is the one that goes on chain.
  const pin = await pinner.pinJson({
    json: metadata,
    name: `badge-${input.metadata.eventId}-metadata.json`,
  });
  assertUriFitsMintField(pin.uri);

  return { metadata, imageUri, metadataUri: pin.uri, pin };
}
