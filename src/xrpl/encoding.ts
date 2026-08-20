/**
 * Field encoding and validation shared by every transaction builder.
 *
 * The URI trap from section 10: a plain string will not error usefully, it
 * will just be wrong. Everything goes through here.
 */
import { convertHexToString, convertStringToHex, isValidClassicAddress } from "xrpl";
import { ValidationError } from "../errors.js";
import { MAX_TAXON, MAX_URI_BYTES, type EventId } from "../types.js";

/** Hex-encodes a URI after asserting the 256-byte cap. */
export function encodeUri(uri: string): string {
  if (!uri || uri.trim() === "") {
    throw new ValidationError("URI_TOO_LONG", "URI must not be empty");
  }
  const bytes = Buffer.byteLength(uri, "utf8");
  if (bytes > MAX_URI_BYTES) {
    throw new ValidationError(
      "URI_TOO_LONG",
      `URI is ${bytes} bytes, the NFTokenMint limit is ${MAX_URI_BYTES}`,
      { uri, bytes, max: MAX_URI_BYTES },
    );
  }
  return convertStringToHex(uri);
}

/** Decodes a hex URI back to a string, tolerating already-decoded input. */
export function decodeUri(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return hex;
  try {
    return convertHexToString(hex);
  } catch {
    return hex;
  }
}

/** Event ids double as taxons; values at or above 2147483648 are reserved. */
export function assertValidTaxon(eventId: EventId): void {
  if (!Number.isInteger(eventId) || eventId < 0 || eventId > MAX_TAXON) {
    throw new ValidationError(
      "INVALID_TAXON",
      `eventId must be an integer in [0, ${MAX_TAXON}], got ${eventId}`,
      { eventId },
    );
  }
}

export function assertValidAddress(address: string, label = "address"): void {
  if (!isValidClassicAddress(address)) {
    throw new ValidationError("INVALID_ADDRESS", `${label} "${address}" is not a valid XRPL classic address`, {
      address,
      label,
    });
  }
}
