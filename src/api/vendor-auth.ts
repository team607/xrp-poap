/**
 * Vendor sessions over HTTP: the cookie, and who it says is behind the counter.
 *
 * A vendor has no password and no account. They prove the wallet they are paid
 * into with a Xaman SignIn, and the session remembers that wallet; which vendor
 * rows they may act for is looked up fresh on every request, so an organiser
 * who hides a vendor or changes its wallet takes effect at once.
 *
 * THREE DECISIONS, and each is here for a reason:
 *
 *   1. A SEPARATE COOKIE AND A SEPARATE STORE from the admin session. The admin
 *      guard reads `poap_admin` and looks it up in `sessions`; a vendor's value
 *      lives in `poap_vendor` and `vendor_sessions`, so there is no request a
 *      vendor can send that the admin guard would treat as an operator.
 *   2. PARSED BY HAND. @fastify/cookie is registered only when an admin surface
 *      is configured, and the vendor screen must work on a deployment without
 *      one. The value is an opaque random id; there is nothing to unsign.
 *   3. CSRF BY CUSTOM HEADER on a SameSite=Strict cookie. Every state-changing
 *      vendor request must carry `x-poap-vendor: 1`. A cross-site form cannot
 *      set a header at all, and cross-origin script cannot without a CORS
 *      preflight this server never answers.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { VendorRecord, VendorSessionRecord } from "../types.js";
import type { ApiDeps } from "./deps.js";

export const VENDOR_COOKIE = "poap_vendor";
export const VENDOR_HEADER = "x-poap-vendor";
/** A long shift. Shorter than an admin session would be pointless: the wallet is the credential. */
export const VENDOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** One named cookie out of a Cookie header, or undefined. */
export function readCookieValue(header: string | undefined, name: string): string | undefined {
  if (typeof header !== "string" || header === "") return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

function cookieAttributes(config: AppConfig, maxAgeSeconds: number): string[] {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`];
  if (config.api.secureCookies) attrs.push("Secure");
  return attrs;
}

export function setVendorCookie(reply: FastifyReply, config: AppConfig, sessionId: string, ttlMs: number): void {
  reply.header(
    "set-cookie",
    [`${VENDOR_COOKIE}=${encodeURIComponent(sessionId)}`, ...cookieAttributes(config, Math.floor(ttlMs / 1000))].join(
      "; ",
    ),
  );
}

export function clearVendorCookie(reply: FastifyReply, config: AppConfig): void {
  reply.header("set-cookie", [`${VENDOR_COOKIE}=`, ...cookieAttributes(config, 0)].join("; "));
}

export interface SignedInVendor {
  session: VendorSessionRecord;
  /** Every vendor row paid into this wallet, at any event, hidden ones included. */
  vendors: VendorRecord[];
}

/** Null for no cookie, an unknown or expired session, or a server with no vendor stores. */
export async function readVendorSession(deps: ApiDeps, request: FastifyRequest): Promise<SignedInVendor | null> {
  const store = deps.vendorSessions;
  const repo = deps.vendors;
  if (!store || !repo) return null;
  const raw = readCookieValue(request.headers.cookie, VENDOR_COOKIE);
  if (!raw) return null;
  const session = await store.get(raw);
  if (!session) return null;
  return { session, vendors: await repo.listVendorsByWallet(session.walletAddress) };
}

export function hasVendorHeader(request: FastifyRequest): boolean {
  return request.headers[VENDOR_HEADER] === "1";
}
