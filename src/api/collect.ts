/**
 * Collecting an order at the counter.
 *
 * The attendee asks their pass for a collection code, the vendor scans it, and
 * the order is handed over. Hand-over used to be a button on the vendor's
 * screen, which told the vendor nothing about who was standing there; the code
 * is what shows that the person at the counter is holding the order.
 *
 * A CODE is a signed statement, "this order, until this moment". It needs no
 * storage, cannot be edited into a different order, and stops working a few
 * minutes after it is shown. It travels as a link to the vendor's screen, so a
 * vendor whose browser cannot scan can point the phone's own camera at it: the
 * link opens /vendor, which hands the order over for the counter signed in
 * there.
 *
 * WHO CAN ASK FOR ONE. Only the page that placed the order. The order's own
 * response carries a secret derived from the order id, which the pass keeps and
 * nothing else ever serves. A wallet address is public, and so are the ids of
 * its orders; neither is enough to be given a code for somebody else's order.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.js";

/** How long a code works once it is shown. */
export const COLLECT_CODE_TTL_MS = 3 * 60_000;

const CODE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{10})\.([A-Za-z0-9_-]{22})$/;

/** Used when there is no SESSION_SECRET, in which case codes and secrets last as long as this process. */
const PROCESS_KEY = randomBytes(32);

/**
 * The key codes and buyer secrets are signed with. Derived from SESSION_SECRET
 * when there is one, so a restart in the middle of a queue voids nothing.
 */
export function collectKey(config: Pick<AppConfig, "admin">): Buffer {
  const secret = config.admin.sessionSecret;
  return secret ? createHmac("sha256", secret).update("poap/collect/v1").digest() : PROCESS_KEY;
}

/** 128 bits of HMAC, as 22 characters that survive a URL untouched. */
function mac(key: Buffer, text: string): string {
  return createHmac("sha256", key).update(text).digest().subarray(0, 16).toString("base64url");
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** What the buyer's page is handed with its order, and shows to be given a code. */
export function buyerSecret(key: Buffer, purchaseId: string): string {
  return mac(key, `buyer:${purchaseId.toLowerCase()}`);
}

export function checkBuyerSecret(key: Buffer, purchaseId: string, secret: string): boolean {
  return same(buyerSecret(key, purchaseId), String(secret ?? ""));
}

export function issueCollectCode(
  key: Buffer,
  purchaseId: string,
  now: number = Date.now(),
): { code: string; expiresAt: string } {
  const expires = Math.floor((now + COLLECT_CODE_TTL_MS) / 1000);
  const payload = `${purchaseId.toLowerCase()}.${expires}`;
  return { code: `${payload}.${mac(key, payload)}`, expiresAt: new Date(expires * 1000).toISOString() };
}

export interface CollectCodeCheck {
  /** A genuine code that has not expired. */
  ok: boolean;
  /** The order a genuine code names, expired or not. Absent for anything else. */
  purchaseId?: string;
  reason?: "malformed" | "forged" | "expired";
}

/**
 * Read a code as it was scanned: the code alone, or the link it travels in.
 * Never throws. An expired code still names its order, so scanning one that
 * already did its job can say so instead of only "expired".
 */
export function readCollectCode(key: Buffer, scanned: string, now: number = Date.now()): CollectCodeCheck {
  const match = CODE.exec(codeFromScan(scanned));
  const purchaseId = match?.[1];
  const expires = match?.[2];
  const signature = match?.[3];
  if (!purchaseId || !expires || !signature) return { ok: false, reason: "malformed" };
  if (!same(mac(key, `${purchaseId}.${expires}`), signature)) return { ok: false, reason: "forged" };
  if (Number(expires) * 1000 <= now) return { ok: false, reason: "expired", purchaseId };
  return { ok: true, purchaseId };
}

/** The code out of whatever a scanner read: the link, or the code on its own. */
function codeFromScan(scanned: string): string {
  const text = String(scanned ?? "").trim();
  const inLink = /[#?&]collect=([^&#\s]+)/.exec(text)?.[1];
  if (!inLink) return text;
  try {
    return decodeURIComponent(inLink);
  } catch {
    return inLink;
  }
}
