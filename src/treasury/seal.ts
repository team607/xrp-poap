/**
 * Sealing a secret at rest: AES-256-GCM under TREASURY_MASTER_KEY.
 *
 * WHAT THIS PROTECTS. Every event has its own treasury wallet, and its seed has
 * to live somewhere the server can read it back to sign a payment. The database
 * is that somewhere, which makes the database a place a seed could leak from: a
 * backup copied to a laptop, a read replica, a `SELECT *` pasted into a ticket.
 * Sealed, a leaked row is useless without the master key, and the master key
 * lives only in the server's environment — the same place, and the same rules,
 * as the issuer seed.
 *
 * WHAT IT DOES NOT PROTECT. Somebody holding both the database and the
 * environment holds the treasuries. That is the honest boundary: this moves the
 * secret from "anyone with the data" to "anyone with the server".
 *
 * THE CONTEXT IS PART OF THE SEAL. Each seed is sealed with its event id and
 * address as additional authenticated data, so a sealed value copied onto a
 * different event's row does not open. Without that, write access to the table
 * would be enough to point one event's payments at another event's money.
 *
 * Format, one line, dot-separated, every part base64url:
 *
 *     v1.<key id>.<iv>.<auth tag>.<ciphertext>
 *
 * The key id is the first eight hex characters of a hash of the master key. It
 * says nothing useful about the key, and it turns "wrong key" from an opaque
 * authentication failure into a message an operator can act on.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ConfigError } from "../errors.js";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
/** 96 bits: the size GCM is designed around. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * TREASURY_MASTER_KEY -> 32 bytes.
 *
 * Two spellings, both of exactly 32 bytes: 64 hex characters (what
 * `openssl rand -hex 32` prints) or base64 / base64url (`openssl rand -base64
 * 32`). Anything else is refused, and the refusal never repeats the value.
 */
export function decodeMasterKey(raw: string): Buffer {
  const value = typeof raw === "string" ? raw.trim() : "";
  let key: Buffer | undefined;

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(value)) {
    // Node reads both base64 alphabets under "base64".
    key = Buffer.from(value, "base64");
  }

  if (!key || key.length !== KEY_BYTES) {
    throw new ConfigError(
      "TREASURY_MASTER_KEY must be 32 random bytes, written as 64 hex characters " +
        "(openssl rand -hex 32) or as base64 (openssl rand -base64 32).",
      { expectedBytes: KEY_BYTES },
    );
  }
  return key;
}

/** A short, non-reversible label for a key. Safe to log, safe to store. */
export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update("poap-treasury-key-id:").update(key).digest("hex").slice(0, 8);
}

export function sealSecret(plaintext: string, key: Buffer, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    keyIdOf(key),
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Open a sealed value. Every failure is a ConfigError that names what is wrong
 * with the SEAL — never the plaintext, never the key, and never the ciphertext.
 */
export function openSecret(sealed: string, key: Buffer, context: string): string {
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  const [version, kid, ivPart, tagPart, ctPart] = parts;

  if (parts.length !== 5 || version !== VERSION || !kid || !ivPart || !tagPart || !ctPart) {
    throw new ConfigError("A sealed treasury seed is not in a format this build can read.", {});
  }

  const expectedKid = keyIdOf(key);
  if (kid !== expectedKid) {
    throw new ConfigError(
      `A treasury seed was sealed under a different TREASURY_MASTER_KEY (key id ${kid}; this ` +
        `server's key id is ${expectedKid}). Restore the key it was sealed with.`,
      { sealedKeyId: kid, serverKeyId: expectedKid },
    );
  }

  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new ConfigError("A sealed treasury seed is truncated.", {});
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(ctPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM does not say which of these it was, and that is the point of it.
    throw new ConfigError(
      "A sealed treasury seed failed authentication: it was altered, or it belongs to a " +
        "different event or address than the row it was read from.",
      {},
    );
  }
}
