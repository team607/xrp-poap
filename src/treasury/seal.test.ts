/**
 * Treasury seeds at rest: the seal, the vault that holds the key, and the
 * service that makes and opens treasuries.
 *
 * The properties that matter are the negative ones — a sealed value that does
 * not contain the seed, a key that cannot be read back off the vault, a seal
 * that will not open on another event's row — so most of what follows is about
 * what must NOT happen.
 */
import { describe, expect, it } from "vitest";
import { MemoryAttendanceRepository, MemoryEventRepository } from "../db/memory.js";
import { MemoryTreasuryRepository } from "../db/treasury-repo.js";
import type { XrplLayerError } from "../errors.js";
import { decodeMasterKey, keyIdOf, openSecret, sealSecret } from "./seal.js";
import { TreasuryService } from "./service.js";
import { TreasuryVault } from "./vault.js";

const KEY_HEX = "0123456789abcdef".repeat(4);
const OTHER_KEY_HEX = "fedcba9876543210".repeat(4);
const SEED = "sEdV6Xn3bRq9J2wY4tK8mZpL1cH7dQa";
const CONTEXT = "poap-treasury:v1:700012:rBdhYBA2uaVYG7ia2yusmPu5qMS4hE6oQ";

function thrown(fn: () => unknown): XrplLayerError | undefined {
  try {
    fn();
  } catch (err) {
    return err as XrplLayerError;
  }
  return undefined;
}

describe("decodeMasterKey", () => {
  it("reads 64 hex characters, base64 and base64url, all as the same 32 bytes", () => {
    const bytes = Buffer.from(KEY_HEX, "hex");
    expect(decodeMasterKey(KEY_HEX).equals(bytes)).toBe(true);
    expect(decodeMasterKey(bytes.toString("base64")).equals(bytes)).toBe(true);
    expect(decodeMasterKey(bytes.toString("base64url")).equals(bytes)).toBe(true);
    // Surrounding whitespace is a copy-paste artefact, not part of the key.
    expect(decodeMasterKey(`  ${KEY_HEX}\n`).equals(bytes)).toBe(true);
  });

  it("refuses anything that is not 32 bytes, and never repeats what it was given", () => {
    const candidates = [
      KEY_HEX.slice(2),
      `${KEY_HEX}00`,
      "correct horse battery staple",
      Buffer.alloc(16).toString("base64"),
    ];
    for (const bad of candidates) {
      const err = thrown(() => decodeMasterKey(bad));
      expect(err?.code, bad).toBe("CONFIG_INVALID");
      expect(JSON.stringify({ message: err?.message, details: err?.details }), bad).not.toContain(bad);
    }
    expect(thrown(() => decodeMasterKey(""))?.code).toBe("CONFIG_INVALID");
  });
});

describe("sealSecret / openSecret", () => {
  const key = decodeMasterKey(KEY_HEX);

  it("round-trips, and the sealed form holds nothing of the secret", () => {
    const sealed = sealSecret(SEED, key, CONTEXT);

    expect(sealed.startsWith(`v1.${keyIdOf(key)}.`)).toBe(true);
    expect(sealed).not.toContain(SEED);
    expect(openSecret(sealed, key, CONTEXT)).toBe(SEED);
  });

  it("seals the same secret differently every time", () => {
    expect(sealSecret(SEED, key, CONTEXT)).not.toBe(sealSecret(SEED, key, CONTEXT));
  });

  it("names a wrong key by its id, instead of failing opaquely", () => {
    const sealed = sealSecret(SEED, key, CONTEXT);
    const other = decodeMasterKey(OTHER_KEY_HEX);

    const err = thrown(() => openSecret(sealed, other, CONTEXT));

    expect(err?.code).toBe("CONFIG_INVALID");
    expect(err?.message).toContain(keyIdOf(key));
    expect(err?.message).toContain(keyIdOf(other));
    expect(err?.message).not.toContain(SEED);
  });

  it("will not open a seal moved to another event or address", () => {
    const sealed = sealSecret(SEED, key, CONTEXT);

    const err = thrown(() => openSecret(sealed, key, CONTEXT.replace("700012", "700013")));

    expect(err?.message).toMatch(/failed authentication/);
  });

  it("will not open a seal whose ciphertext was altered", () => {
    const parts = sealSecret(SEED, key, CONTEXT).split(".");
    const ciphertext = parts[4] ?? "";
    const flipped = (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1);

    const err = thrown(() => openSecret([...parts.slice(0, 4), flipped].join("."), key, CONTEXT));

    expect(err?.message).toMatch(/failed authentication/);
  });

  it("refuses something that is not a seal at all, including a bare seed", () => {
    for (const bad of ["", SEED, "v2.a.b.c.d", "v1.only.three"]) {
      const err = thrown(() => openSecret(bad, key, CONTEXT));
      expect(err?.code, bad).toBe("CONFIG_INVALID");
      expect(err?.message ?? "").not.toContain(SEED);
    }
  });
});

describe("TreasuryVault", () => {
  it("makes a wallet it can open again, and the stored seal does not hold the seed", () => {
    const vault = new TreasuryVault(KEY_HEX);

    const made = vault.create(700012);
    const wallet = vault.open({ eventId: 700012, ...made });

    expect(wallet.classicAddress).toBe(made.address);
    expect(wallet.seed).toBeTruthy();
    expect(made.sealedSeed).not.toContain(wallet.seed ?? "never");
  });

  it("gives every event a different wallet", () => {
    const vault = new TreasuryVault(KEY_HEX);
    expect(vault.create(1).address).not.toBe(vault.create(1).address);
  });

  it("will not open one event's seal on another event's row, or beside another address", () => {
    const vault = new TreasuryVault(KEY_HEX);
    const one = vault.create(1);
    const two = vault.create(2);

    expect(thrown(() => vault.open({ eventId: 2, address: one.address, sealedSeed: one.sealedSeed }))).toBeDefined();
    expect(thrown(() => vault.open({ eventId: 1, address: two.address, sealedSeed: one.sealedSeed }))).toBeDefined();
  });

  it("will not open a treasury sealed under a different key", () => {
    const made = new TreasuryVault(KEY_HEX).create(7);
    const err = thrown(() => new TreasuryVault(OTHER_KEY_HEX).open({ eventId: 7, ...made }));
    expect(err?.message).toMatch(/different TREASURY_MASTER_KEY/);
  });

  it("serialises as its key id and nothing else", () => {
    const vault = new TreasuryVault(KEY_HEX);

    const json = JSON.stringify({ vault });

    expect(json).toContain(vault.keyId);
    expect(json).not.toContain(KEY_HEX);
    expect(Object.keys(vault)).toEqual(["keyId"]);
  });
});

describe("TreasuryService", () => {
  async function eventsWith(ids: number[]) {
    const events = new MemoryEventRepository(new MemoryAttendanceRepository());
    for (const id of ids) await events.create({ eventId: id, name: `Event ${id}`, status: "open" });
    return events;
  }

  it("backfills every event that has no treasury, once, and leaves the rest alone", async () => {
    const events = await eventsWith([1, 2, 3]);
    const service = new TreasuryService(new MemoryTreasuryRepository(events), new TreasuryVault(KEY_HEX));
    const existing = await service.ensure(2);

    expect(await service.backfill(events)).toEqual({ created: 2, existing: 1, failed: 0 });
    expect((await service.find(2))?.address).toBe(existing?.address);

    // Idempotent: the next boot makes nothing new.
    expect(await service.backfill(events)).toEqual({ created: 0, existing: 3, failed: 0 });
  });

  it("reports an event it could not give a treasury to, and carries on with the rest", async () => {
    const events = await eventsWith([1, 2]);
    const repo = new MemoryTreasuryRepository(events);
    const failing = {
      find: (eventId: number) => repo.find(eventId),
      insertIfAbsent: async (record: Parameters<typeof repo.insertIfAbsent>[0]) => {
        if (record.eventId === 1) throw new Error("database went away");
        return repo.insertIfAbsent(record);
      },
    };
    const service = new TreasuryService(failing, new TreasuryVault(KEY_HEX));
    const failed: number[] = [];

    const report = await service.backfill(events, (eventId) => failed.push(eventId));

    expect(report).toEqual({ created: 1, existing: 0, failed: 1 });
    expect(failed).toEqual([1]);
  });

  it("without a key, shows a treasury that exists but makes and opens none", async () => {
    const events = await eventsWith([1, 2]);
    const repo = new MemoryTreasuryRepository(events);
    const made = await new TreasuryService(repo, new TreasuryVault(KEY_HEX)).ensure(2);

    const keyless = new TreasuryService(repo);

    expect(keyless.configured).toBe(false);
    expect(keyless.keyId).toBeUndefined();
    expect(await keyless.ensure(1)).toBeNull();
    expect((await keyless.find(2))?.address).toBe(made?.address);
    expect(await keyless.handle(2)).toBeNull();
    expect(await keyless.backfill(events)).toEqual({ created: 0, existing: 0, failed: 0 });
  });

  it("opens exactly the wallet it stored, and serialises without the key", async () => {
    const events = await eventsWith([5]);
    const service = new TreasuryService(new MemoryTreasuryRepository(events), new TreasuryVault(KEY_HEX));
    await service.ensure(5);

    const handle = await service.handle(5);

    expect(handle?.open().classicAddress).toBe(handle?.address);
    expect(JSON.stringify(service)).not.toContain(KEY_HEX);
    expect(JSON.parse(JSON.stringify(service))).toEqual({ configured: true, keyId: service.keyId });
  });
});
