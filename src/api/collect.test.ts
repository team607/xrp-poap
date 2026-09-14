/**
 * Collection codes: what an attendee shows at the counter to be handed their
 * order, and the buyer secret that has to come with the request for one.
 */
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import {
  COLLECT_CODE_TTL_MS,
  buyerSecret,
  checkBuyerSecret,
  collectKey,
  issueCollectCode,
  readCollectCode,
} from "./collect.js";

const ORDER = "2f1c6a4e-8d3b-4a57-9c1e-5b7d9e0f1a2b";
const OTHER = "3f1c6a4e-8d3b-4a57-9c1e-5b7d9e0f1a2b";
const NOW = Date.UTC(2026, 8, 14, 11, 0, 0);

const keyFor = (sessionSecret?: string) =>
  collectKey({ admin: { sessionTtlHours: 12, ...(sessionSecret ? { sessionSecret } : {}) } } as Pick<AppConfig, "admin">);

describe("collection codes", () => {
  const key = keyFor("a long random session secret for the tests");

  it("reads back the order a code was issued for, alone or inside the link it travels in", () => {
    const { code, expiresAt } = issueCollectCode(key, ORDER, NOW);

    expect(Date.parse(expiresAt) - NOW).toBeGreaterThan(COLLECT_CODE_TTL_MS - 1_000);
    expect(Date.parse(expiresAt) - NOW).toBeLessThanOrEqual(COLLECT_CODE_TTL_MS);
    expect(readCollectCode(key, code, NOW)).toEqual({ ok: true, purchaseId: ORDER });
    expect(readCollectCode(key, `https://poap.example/vendor#collect=${code}`, NOW)).toEqual({
      ok: true,
      purchaseId: ORDER,
    });
  });

  it("refuses a code edited to name another order, one signed with another key, and anything that is not a code", () => {
    const { code } = issueCollectCode(key, ORDER, NOW);

    expect(readCollectCode(key, code.replace(ORDER, OTHER), NOW)).toEqual({ ok: false, reason: "forged" });
    expect(readCollectCode(keyFor("some other secret entirely"), code, NOW)).toEqual({ ok: false, reason: "forged" });
    // A wallet address is public: it is not a code.
    expect(readCollectCode(key, "rPeZcWESwr1Wy64tw6JdVqtKNjhuUzHK2i", NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(readCollectCode(key, "", NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("says a code has expired, and still names its order", () => {
    const { code } = issueCollectCode(key, ORDER, NOW);

    expect(readCollectCode(key, code, NOW + COLLECT_CODE_TTL_MS + 1)).toEqual({
      ok: false,
      reason: "expired",
      purchaseId: ORDER,
    });
  });

  it("keeps a code working across a restart when the server has a session secret", () => {
    const { code } = issueCollectCode(keyFor("shared"), ORDER, NOW);
    expect(readCollectCode(keyFor("shared"), code, NOW).ok).toBe(true);
  });
});

describe("buyer secrets", () => {
  const key = keyFor("a long random session secret for the tests");

  it("differ per order, and only the right one checks out", () => {
    const secret = buyerSecret(key, ORDER);

    expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(buyerSecret(key, OTHER)).not.toBe(secret);
    expect(checkBuyerSecret(key, ORDER, secret)).toBe(true);
    expect(checkBuyerSecret(key, OTHER, secret)).toBe(false);
    expect(checkBuyerSecret(key, ORDER, "short")).toBe(false);
  });
});
