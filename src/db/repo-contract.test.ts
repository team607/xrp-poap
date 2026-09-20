/**
 * ONE contract suite, two implementations.
 *
 * `runRepositoryContract()` is exported and takes a factory, so the same
 * assertions can be pointed at anything that claims to be an
 * AttendanceRepository, ClaimRepository, AllowanceLedger and the rest. It runs against the
 * in-memory stores on every `npm test`, and against a real Postgres when
 * TEST_DATABASE_URL is set:
 *
 *   TEST_DATABASE_URL=postgres://localhost/xrpl_poap_test npx vitest run src/db/
 *
 * With the variable absent the Postgres block is a clean skip, never a
 * failure — the unit suite must pass with no database anywhere in sight.
 *
 * The concurrency cases below are not decoration. Both of the defects this
 * suite now pins were invisible to sequential tests and were reproduced
 * against a real Postgres: N simultaneous sponsorships for one address paid N
 * times and recorded one, and N simultaneous claims for one (event, address)
 * minted N badges. An implementation that is correct one call at a time and
 * wrong under Promise.all is wrong.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { XrplLayerError } from "../errors.js";
import {
  MAX_TAXON,
  type AttendanceRecord,
  type AttendanceRepository,
  type ClaimRepository,
  type EventRepository,
  type RegistrationRepository,
  type SessionStore,
  type AllowanceLedger,
  type AllowanceRecord,
  type AllowanceReserveInput,
  type PurchaseRepository,
  type PurchaseReserveInput,
  type TreasuryRepository,
  type VendorRepository,
  type VendorSessionStore,
} from "../types.js";
import { PgAttendanceRepository } from "./attendance-repo.js";
import { PgClaimRepository } from "./claim-repo.js";
import { PgEventRepository } from "./event-repo.js";
import { createMemoryStores } from "./memory.js";
import { closePool, createPool } from "./pool.js";
import { PgRegistrationRepository } from "./registration-repo.js";
import { hashSessionId, PgSessionStore } from "./session-store.js";
import { dropsToXrpString } from "../money.js";
import { PgAllowanceLedger } from "./allowance-ledger.js";
import { PgPurchaseRepository } from "./purchase-repo.js";
import { PgTreasuryRepository } from "./treasury-repo.js";
import { PgVendorRepository } from "./vendor-repo.js";
import { PgVendorSessionStore } from "./vendor-session-store.js";

// XRPL classic addresses: base58, mixed case, and case-SENSITIVE. Nothing in
// the persistence layer may fold these.
const ALICE = "rAliceQ7hK3xTn9vCJ8pW2dY4mZ6bLs1Nfg";
const BOB = "rBobW4nR8kL2sVc7QpX3jY9tD6hM5eZaUv";
const CAROL = "rCarolM2xF7bN4qT8sJ1wK6vP9dG3hLyRz";

const EVENT_A = 4201;
const EVENT_B = 4202;

/**
 * Real classic addresses. The allowance book validates them, because a
 * payment is about to be addressed to one.
 */
const TREASURY_1 = "rBdhYBA2uaVYG7ia2yusmPu5qMS4hE6oQ";
const TREASURY_2 = "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w";
const PAYEE_1 = "rwPy1pJd3RcHrEaqKk1yUiEGCqz8wewJZm";
const PAYEE_2 = "ra6pcMuGFgwSefKt4GPy6UCeEXkn2KtaNS";
const PAYEE_3 = "rPeZcWESwr1Wy64tw6JdVqtKNjhuUzHK2i";

/** Shaped like a seal. The repository stores it and never opens it. */
const SEALED = "v1.0000abcd.aXZpdg.dGFn.Y2lwaGVy";

function claim(overrides: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    eventId: EVENT_A,
    address: ALICE,
    nftokenId: "000100001E962F4C7B7E1A9C0D3F5A6B8C9D0E1F2A3B4C5D00000001",
    offerId: "9F1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F9",
    txHash: "A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90",
    ledgerIndex: 89_123_456,
    ...overrides,
  };
}

/** Distinct 64-hex tx hashes without hand-typing them. */
function hash(seed: number): string {
  return seed.toString(16).toUpperCase().padStart(64, "0");
}

/** Distinct, case-mixed, plausible-looking addresses for the fan-out cases. */
function addr(i: number): string {
  return `rConc${String(i).padStart(3, "0")}xF7bN4qT8sJ1wK6vP9dG3hLyRz`;
}

const ADMIN = "ops@example.test";
const OTHER_ADMIN = "second@example.test";

/** Enough of an event to satisfy the schema, for tests that are not about events. */
function eventInput(overrides: Partial<Parameters<EventRepository["create"]>[0]> = {}) {
  return {
    eventId: EVENT_A,
    name: "Ledger Days",
    status: "draft" as const,
    ...overrides,
  };
}

export interface ContractSubjects {
  repo: AttendanceRepository;
  treasuries: TreasuryRepository;
  allowances: AllowanceLedger;
  vendors: VendorRepository;
  purchases: PurchaseRepository;
  vendorSessions: VendorSessionStore;
  /** Every id the vendor session store persisted. Same purpose as storedSessionIds. */
  storedVendorSessionIds: () => Promise<string[]>;
  claims: ClaimRepository;
  events: EventRepository;
  registrations: RegistrationRepository;
  sessions: SessionStore;
  /**
   * Every id the session store actually persisted.
   *
   * Not part of SessionStore, and supplied by the wiring rather than reached
   * for through the interface, so the contract stays implementation-agnostic.
   * It exists for exactly one assertion, and that assertion is the reason the
   * column is hashed: a raw cookie value must not be recoverable from the
   * store.
   */
  storedSessionIds: () => Promise<string[]>;
}

export type ContractFactory = () => Promise<ContractSubjects> | ContractSubjects;

/**
 * The contract. Every assertion in here holds for any correct implementation;
 * nothing in here may reach for an implementation-specific method.
 */
export function runRepositoryContract(label: string, factory: ContractFactory): void {
  describe(`${label}: persistence layer contract`, () => {
    async function fresh(): Promise<ContractSubjects> {
      return factory();
    }

    /**
     * Registrations carry a foreign key to events, so anything that registers
     * needs the event to exist first. Postgres enforces it; the in-memory
     * store is wired to the event store so that it enforces it too.
     */
    async function withEvent(
      subjects: ContractSubjects,
      overrides: Partial<Parameters<EventRepository["create"]>[0]> = {},
    ): Promise<ContractSubjects> {
      await subjects.events.create(eventInput(overrides));
      return subjects;
    }

    /** One event with one vendor selling one item: the smallest store there is. */
    async function stall(
      subjects: ContractSubjects,
      opts: { stock?: number | null; priceXrp?: string; eventId?: number } = {},
    ) {
      const eventId = opts.eventId ?? EVENT_A;
      if (!(await subjects.events.find(eventId))) {
        await subjects.events.create(eventInput({ eventId, name: `Event ${eventId}` }));
      }
      const vendor = await subjects.vendors.createVendor({
        eventId,
        name: "Dominos",
        walletAddress: eventId === EVENT_A ? TREASURY_2 : PAYEE_3,
      });
      const item = await subjects.vendors.createItem({
        vendorId: vendor.id,
        name: "Garlic bread",
        priceXrp: opts.priceXrp ?? "1.5",
        stock: opts.stock ?? null,
      });
      return { vendor, item };
    }

    function order(
      s: { vendor: { id: string; eventId: number; walletAddress: string }; item: { id: string; priceXrp: string } },
      over: Partial<PurchaseReserveInput> = {},
    ): PurchaseReserveInput {
      return {
        id: randomUUID(),
        eventId: s.vendor.eventId,
        vendorId: s.vendor.id,
        itemId: s.item.id,
        buyerAddress: PAYEE_1,
        vendorAddress: s.vendor.walletAddress,
        vendorName: "Dominos",
        itemName: "Garlic bread",
        quantity: 1,
        unitPriceXrp: s.item.priceXrp,
        expiresAt: new Date(Date.now() + 5 * 60_000),
        maxOpenPerBuyer: 50,
        ...over,
      };
    }

    /** What a fresh wallet at a 5 XRP event is booked for. */
    function booking(over: Partial<AllowanceReserveInput> = {}): AllowanceReserveInput {
      return {
        eventId: EVENT_A,
        address: PAYEE_1,
        allowanceXrp: "5",
        topupXrp: "1.21",
        treasuryAddress: TREASURY_1,
        budgetXrp: "1000",
        ...over,
      };
    }

    // -----------------------------------------------------------------------
    // AttendanceRepository
    // -----------------------------------------------------------------------

    it("inserts a claim and reads it back", async () => {
      const { repo } = await fresh();
      const input = claim();

      const written = await repo.insert(input);

      expect(written.id).toBeTruthy();
      expect(written.eventId).toBe(EVENT_A);
      expect(written.address).toBe(ALICE);
      expect(written.nftokenId).toBe(input.nftokenId);
      expect(written.offerId).toBe(input.offerId);
      expect(written.txHash).toBe(input.txHash);
      expect(written.ledgerIndex).toBe(89_123_456);
      expect(typeof written.ledgerIndex).toBe("number");
      expect(written.claimedAt).toBeInstanceOf(Date);

      const read = await repo.findByEventAndAddress(EVENT_A, ALICE);
      expect(read).not.toBeNull();
      expect(read?.txHash).toBe(input.txHash);
      expect(read?.ledgerIndex).toBe(89_123_456);
      expect(read?.nftokenId).toBe(input.nftokenId);
    });

    it("returns null for an address that did not attend", async () => {
      const { repo } = await fresh();
      await repo.insert(claim());
      expect(await repo.findByEventAndAddress(EVENT_A, BOB)).toBeNull();
      expect(await repo.findByEventAndAddress(EVENT_B, ALICE)).toBeNull();
    });

    it("stores the address verbatim: base58 is case-sensitive", async () => {
      const { repo } = await fresh();
      await repo.insert(claim());

      // Lowercasing is the Ethereum reflex. If anything in the layer folded
      // case, this lookup would succeed and the index would be quietly wrong.
      expect(await repo.findByEventAndAddress(EVENT_A, ALICE.toLowerCase())).toBeNull();
      expect((await repo.findByEventAndAddress(EVENT_A, ALICE))?.address).toBe(ALICE);
    });

    it("accepts a null offer_id", async () => {
      const { repo } = await fresh();
      const written = await repo.insert(claim({ offerId: null }));
      expect(written.offerId ?? null).toBeNull();
    });

    it("throws DUPLICATE_CLAIM on a repeat (event_id, address)", async () => {
      const { repo } = await fresh();
      await repo.insert(claim());

      // Same wallet, same event, different transaction: still one badge.
      const second = repo.insert(claim({ txHash: hash(0xbeef) }));

      await expect(second).rejects.toBeInstanceOf(XrplLayerError);
      await expect(second).rejects.toMatchObject({ code: "DUPLICATE_CLAIM" });
      await second.catch((err: XrplLayerError) => {
        expect(err.message).toContain(String(EVENT_A));
        expect(err.details?.constraint).toBe("event_id,address");
      });

      expect(await repo.countByEvent(EVENT_A)).toBe(1);
    });

    it("throws DUPLICATE_CLAIM on a repeat tx_hash", async () => {
      const { repo } = await fresh();
      const first = claim();
      await repo.insert(first);

      // One NFTokenAcceptOffer cannot be two attendances, even across events.
      const second = repo.insert(
        claim({ eventId: EVENT_B, address: BOB, txHash: first.txHash }),
      );

      await expect(second).rejects.toBeInstanceOf(XrplLayerError);
      await expect(second).rejects.toMatchObject({ code: "DUPLICATE_CLAIM" });
      await second.catch((err: XrplLayerError) => {
        expect(err.details?.constraint).toBe("tx_hash");
      });

      expect(await repo.countByEvent(EVENT_B)).toBe(0);
    });

    it("paginates listByEvent in stable chronological order", async () => {
      const { repo } = await fresh();

      const base = Date.UTC(2026, 4, 1, 12, 0, 0);
      const addresses = [ALICE, BOB, CAROL, `${ALICE}D`, `${BOB}E`];
      for (const [i, address] of addresses.entries()) {
        await repo.insert(
          claim({
            address,
            txHash: hash(0x1000 + i),
            ledgerIndex: 89_000_000 + i,
            claimedAt: new Date(base + i * 1000),
          }),
        );
      }

      const all = await repo.listByEvent(EVENT_A);
      expect(all).toHaveLength(5);
      expect(all.map((r) => r.address)).toEqual(addresses);

      const page1 = await repo.listByEvent(EVENT_A, { limit: 2, offset: 0 });
      const page2 = await repo.listByEvent(EVENT_A, { limit: 2, offset: 2 });
      const page3 = await repo.listByEvent(EVENT_A, { limit: 2, offset: 4 });

      expect(page1.map((r) => r.address)).toEqual(addresses.slice(0, 2));
      expect(page2.map((r) => r.address)).toEqual(addresses.slice(2, 4));
      expect(page3.map((r) => r.address)).toEqual(addresses.slice(4));

      // No overlap and no gaps across pages.
      const paged = [...page1, ...page2, ...page3].map((r) => r.txHash);
      expect(paged).toEqual(all.map((r) => r.txHash));
      expect(new Set(paged).size).toBe(5);

      expect(await repo.listByEvent(EVENT_A, { offset: 99 })).toEqual([]);
      expect(await repo.listByEvent(EVENT_B)).toEqual([]);
    });

    it("counts by event without counting other events", async () => {
      const { repo } = await fresh();
      expect(await repo.countByEvent(EVENT_A)).toBe(0);

      await repo.insert(claim({ address: ALICE, txHash: hash(1) }));
      await repo.insert(claim({ address: BOB, txHash: hash(2) }));
      await repo.insert(claim({ eventId: EVENT_B, address: ALICE, txHash: hash(3) }));

      expect(await repo.countByEvent(EVENT_A)).toBe(2);
      expect(await repo.countByEvent(EVENT_B)).toBe(1);
      expect(typeof (await repo.countByEvent(EVENT_A))).toBe("number");
    });

    it("lists one wallet across two events", async () => {
      const { repo } = await fresh();
      const base = Date.UTC(2026, 4, 1, 12, 0, 0);

      await repo.insert(
        claim({ eventId: EVENT_A, address: ALICE, txHash: hash(11), claimedAt: new Date(base) }),
      );
      await repo.insert(
        claim({
          eventId: EVENT_B,
          address: ALICE,
          txHash: hash(12),
          claimedAt: new Date(base + 1000),
        }),
      );
      await repo.insert(claim({ eventId: EVENT_A, address: BOB, txHash: hash(13) }));

      const attended = await repo.listByAddress(ALICE);
      expect(attended.map((r) => r.eventId)).toEqual([EVENT_A, EVENT_B]);
      expect(attended.map((r) => r.txHash)).toEqual([hash(11), hash(12)]);

      expect(await repo.listByAddress(CAROL)).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // ClaimRepository — the mint guard
    // -----------------------------------------------------------------------

    it("opens a claim slot and reads it back", async () => {
      const { claims } = await fresh();
      const expiresAt = new Date(Date.UTC(2026, 4, 1, 12, 0, 0));

      const opened = await claims.open({ eventId: EVENT_A, address: ALICE, expiresAt });

      expect(opened).not.toBeNull();
      expect(opened?.id).toBeTruthy();
      expect(opened?.eventId).toBe(EVENT_A);
      expect(opened?.address).toBe(ALICE);
      expect(opened?.status).toBe("pending");
      expect(opened?.nftokenId ?? null).toBeNull();
      expect(opened?.offerId ?? null).toBeNull();
      expect(opened?.createdAt).toBeInstanceOf(Date);
      expect(opened?.expiresAt?.getTime()).toBe(expiresAt.getTime());

      const found = await claims.find(EVENT_A, ALICE);
      expect(found?.id).toBe(opened?.id);
      expect(found?.status).toBe("pending");
    });

    it("returns null for a slot nobody opened, and stores addresses verbatim", async () => {
      const { claims } = await fresh();
      await claims.open({ eventId: EVENT_A, address: ALICE });

      expect(await claims.find(EVENT_A, BOB)).toBeNull();
      expect(await claims.find(EVENT_B, ALICE)).toBeNull();
      expect(await claims.find(EVENT_A, ALICE.toLowerCase())).toBeNull();
    });

    it("refuses a second open for the same (event, address) with null, not a throw", async () => {
      const { claims } = await fresh();
      const first = await claims.open({ eventId: EVENT_A, address: ALICE });

      // A duplicate is the expected case: the caller reuses the existing
      // offer. Throwing here would turn a normal retry into a 500.
      expect(await claims.open({ eventId: EVENT_A, address: ALICE })).toBeNull();
      expect((await claims.find(EVENT_A, ALICE))?.id).toBe(first?.id);

      // A different event is a different badge.
      expect(await claims.open({ eventId: EVENT_B, address: ALICE })).not.toBeNull();
    });

    it("REOPENS an abandoned claim — a slow attendee is not locked out forever", async () => {
      const { claims } = await fresh();
      const first = await claims.open({ eventId: EVENT_A, address: ALICE });
      await claims.attach(first!.id, { nftokenId: "NFT-REOPEN", offerId: "OFFER-REOPEN" });

      // The reaper closes out a claim the attendee never signed and cancels
      // its offer. That is a timeout, not a forfeit.
      await claims.markAbandoned(first!.id);

      const reopened = await claims.open({ eventId: EVENT_A, address: ALICE });
      expect(reopened).not.toBeNull();
      expect(reopened!.status).toBe("pending");
      // The stale mint and the cancelled offer must not carry over — that
      // offer no longer exists on the ledger.
      expect(reopened!.nftokenId ?? null).toBeNull();
      expect(reopened!.offerId ?? null).toBeNull();

      // Still exactly one slot: reopening must not create a second row.
      expect(await claims.open({ eventId: EVENT_A, address: ALICE })).toBeNull();
    });

    it("does NOT reopen a claimed slot", async () => {
      const { claims } = await fresh();
      const first = await claims.open({ eventId: EVENT_A, address: ALICE });
      await claims.markClaimed(first!.id);

      // They already have the badge. Reopening would mint a second one.
      expect(await claims.open({ eventId: EVENT_A, address: ALICE })).toBeNull();
      expect((await claims.find(EVENT_A, ALICE))?.status).toBe("claimed");
    });

    it("CONCURRENCY: eight simultaneous opens for ONE slot yield exactly one", async () => {
      const { claims } = await fresh();

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          claims.open({ eventId: EVENT_A, address: ALICE }),
        ),
      );

      const won = results.filter((r) => r !== null);
      // Measured against dedupe-on-attendance: six concurrent claims, six
      // mints, six open offers at 0.2 XRP each, zero attendance rows.
      expect(won).toHaveLength(1);
      expect((await claims.find(EVENT_A, ALICE))?.id).toBe(won[0]?.id);
    });

    it("attaches the mint and the offer without either clobbering the other", async () => {
      const { claims } = await fresh();
      const opened = await claims.open({ eventId: EVENT_A, address: ALICE });

      await claims.attach(opened!.id, { nftokenId: "NFT-1" });
      await claims.attach(opened!.id, { offerId: "OFFER-1" });

      const after = await claims.find(EVENT_A, ALICE);
      // The second attach carried no nftokenId. It must not have blanked one.
      expect(after?.nftokenId).toBe("NFT-1");
      expect(after?.offerId).toBe("OFFER-1");
      expect(after?.status).toBe("pending");
    });

    it("moves a claim to claimed and to abandoned", async () => {
      const { claims } = await fresh();
      const a = await claims.open({ eventId: EVENT_A, address: ALICE });
      const b = await claims.open({ eventId: EVENT_A, address: BOB });

      await claims.markClaimed(a!.id);
      await claims.markAbandoned(b!.id);

      expect((await claims.find(EVENT_A, ALICE))?.status).toBe("claimed");
      expect((await claims.find(EVENT_A, BOB))?.status).toBe("abandoned");
    });

    it("delete frees the slot so a failed mint does not lock the attendee out", async () => {
      const { claims } = await fresh();
      const opened = await claims.open({ eventId: EVENT_A, address: ALICE });

      await claims.delete(opened!.id);

      expect(await claims.find(EVENT_A, ALICE)).toBeNull();
      expect(await claims.open({ eventId: EVENT_A, address: ALICE })).not.toBeNull();
      // Idempotent: a retried cleanup must not fail.
      await expect(claims.delete("999999")).resolves.toBeUndefined();
      await expect(claims.delete("not-an-id")).resolves.toBeUndefined();
    });

    it("throws NOT_FOUND when a mutation names a claim that does not exist", async () => {
      const { claims } = await fresh();
      await expect(claims.attach("999999", { offerId: "X" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(claims.markClaimed("999999")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(claims.markAbandoned("not-an-id")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("listExpired returns only pending, expired, offer-bearing claims", async () => {
      const { claims } = await fresh();
      const now = new Date(Date.UTC(2026, 4, 1, 12, 0, 0));
      const past = (ms: number) => new Date(now.getTime() - ms);
      const future = new Date(now.getTime() + 60_000);

      // The one that matters: pending, expired, still holding 0.2 XRP.
      const leaking = await claims.open({
        eventId: EVENT_A,
        address: ALICE,
        expiresAt: past(60_000),
      });
      await claims.attach(leaking!.id, { offerId: "OFFER-LEAK" });

      // Older, so it should come first.
      const older = await claims.open({
        eventId: EVENT_A,
        address: BOB,
        expiresAt: past(120_000),
      });
      await claims.attach(older!.id, { offerId: "OFFER-OLDER" });

      // Expired but never got as far as an offer: costs nothing, not swept.
      await claims.open({ eventId: EVENT_A, address: CAROL, expiresAt: past(90_000) });

      // Not expired yet.
      const early = await claims.open({
        eventId: EVENT_A,
        address: addr(901),
        expiresAt: future,
      });
      await claims.attach(early!.id, { offerId: "OFFER-EARLY" });

      // No deadline at all.
      const openEnded = await claims.open({ eventId: EVENT_A, address: addr(902) });
      await claims.attach(openEnded!.id, { offerId: "OFFER-FOREVER" });

      // Expired with an offer, but already settled.
      const settled = await claims.open({
        eventId: EVENT_A,
        address: addr(903),
        expiresAt: past(180_000),
      });
      await claims.attach(settled!.id, { offerId: "OFFER-DONE" });
      await claims.markClaimed(settled!.id);

      // Expired with an offer, but already written off.
      const gone = await claims.open({
        eventId: EVENT_A,
        address: addr(904),
        expiresAt: past(240_000),
      });
      await claims.attach(gone!.id, { offerId: "OFFER-GONE" });
      await claims.markAbandoned(gone!.id);

      const expired = await claims.listExpired(now);
      expect(expired.map((c) => c.offerId)).toEqual(["OFFER-OLDER", "OFFER-LEAK"]);
      expect(expired.every((c) => c.status === "pending")).toBe(true);

      // Oldest first, so a capped sweep frees the longest-held reserves.
      expect(await claims.listExpired(now, 1)).toHaveLength(1);
      expect((await claims.listExpired(now, 1))[0]?.offerId).toBe("OFFER-OLDER");

      // Nothing is expired before anything expired.
      expect(await claims.listExpired(past(300_000))).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // EventRepository — the event id IS the NFTokenTaxon
    // -----------------------------------------------------------------------

    it("creates an event and reads it back", async () => {
      const { events } = await fresh();

      const created = await events.create({
        eventId: EVENT_A,
        name: "Ledger Days",
        description: "One day, many badges",
        eventDate: "2026-05-01",
        venue: "Hall C",
        metadataUri: "ipfs://bafyEVENT/metadata.json",
        status: "open",
      });

      expect(created.eventId).toBe(EVENT_A);
      expect(created.name).toBe("Ledger Days");
      expect(created.description).toBe("One day, many badges");
      expect(created.eventDate).toBe("2026-05-01");
      expect(created.venue).toBe("Hall C");
      expect(created.metadataUri).toBe("ipfs://bafyEVENT/metadata.json");
      expect(created.status).toBe("open");
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.updatedAt).toBeInstanceOf(Date);

      const found = await events.find(EVENT_A);
      expect(found).not.toBeNull();
      expect(found?.name).toBe("Ledger Days");
      expect(found?.eventDate).toBe("2026-05-01");
      expect(await events.find(EVENT_B)).toBeNull();
    });

    it("defaults the optional columns to null", async () => {
      const { events } = await fresh();
      const created = await events.create(eventInput());

      expect(created.description ?? null).toBeNull();
      expect(created.eventDate ?? null).toBeNull();
      expect(created.venue ?? null).toBeNull();
      expect(created.metadataUri ?? null).toBeNull();
      expect(created.status).toBe("draft");
    });

    it("keeps event_date a calendar day, not an instant, in any timezone", async () => {
      const { events } = await fresh();
      await events.create(eventInput({ eventDate: "2026-05-01" }));

      // A `date` column has no zone, but node-postgres parses one into a Date
      // at LOCAL midnight — whose ISO form is the PREVIOUS day everywhere east
      // of Greenwich. UTC+14 is the worst case: without the to_char() cast in
      // event-repo.ts this reads back "2026-04-30" and an event silently moves
      // a day earlier for everyone on a server in Kiritimati.
      const original = process.env.TZ;
      process.env.TZ = "Pacific/Kiritimati";
      try {
        expect((await events.find(EVENT_A))?.eventDate).toBe("2026-05-01");
        const [listed] = await events.list();
        expect(listed?.eventDate).toBe("2026-05-01");
      } finally {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
      }
    });

    it("refuses to reuse an event id: it is a taxon, and badges point at it", async () => {
      const { events } = await fresh();
      await events.create(eventInput());

      const second = events.create(eventInput({ name: "A different event" }));
      await expect(second).rejects.toBeInstanceOf(XrplLayerError);
      await expect(second).rejects.toMatchObject({ code: "DUPLICATE_CLAIM" });
      await second.catch((err: XrplLayerError) => {
        expect(err.details?.constraint).toBe("event_id");
      });

      // The original survived; the loser did not overwrite it.
      expect((await events.find(EVENT_A))?.name).toBe("Ledger Days");
    });

    it("rejects an event id outside the NFTokenTaxon range", async () => {
      const { events } = await fresh();

      // Taxons are unsigned in the protocol's mind and signed on the wire;
      // 2147483648 and up are reserved, and a negative one cannot be minted.
      await expect(events.create(eventInput({ eventId: -1 }))).rejects.toMatchObject({
        code: "INVALID_TAXON",
      });
      await expect(
        events.create(eventInput({ eventId: MAX_TAXON + 1 })),
      ).rejects.toMatchObject({ code: "INVALID_TAXON" });
      await expect(events.create(eventInput({ eventId: 1.5 }))).rejects.toMatchObject({
        code: "INVALID_TAXON",
      });

      // The boundary itself is legal.
      expect((await events.create(eventInput({ eventId: MAX_TAXON }))).eventId).toBe(MAX_TAXON);
    });

    it("rejects a status or a date the table would reject", async () => {
      const { events } = await fresh();

      await expect(
        events.create(eventInput({ status: "cancelled" as never })),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(events.create(eventInput({ name: "  " }))).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      // Rolls over to 3 March, which is not the date anybody typed.
      await expect(
        events.create(eventInput({ eventDate: "2026-02-31" })),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        events.create(eventInput({ eventDate: "1 May 2026" })),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("updates only the fields the patch carries", async () => {
      const { events } = await fresh();
      const created = await events.create(
        eventInput({ description: "as first written", venue: "Hall C" }),
      );

      const updated = await events.update(EVENT_A, { name: "Ledger Nights", status: "live" });

      expect(updated.name).toBe("Ledger Nights");
      expect(updated.status).toBe("live");
      // Untouched by a patch that did not mention them.
      expect(updated.description).toBe("as first written");
      expect(updated.venue).toBe("Hall C");
      expect(updated.eventId).toBe(EVENT_A);
      expect(updated.createdAt?.getTime()).toBe(created.createdAt?.getTime());
      expect(updated.updatedAt!.getTime()).toBeGreaterThanOrEqual(
        created.updatedAt!.getTime(),
      );

      expect((await events.find(EVENT_A))?.name).toBe("Ledger Nights");
    });

    it("clears a nullable field when the patch says null", async () => {
      const { events } = await fresh();
      await events.create(eventInput({ venue: "Hall C", eventDate: "2026-05-01" }));

      const updated = await events.update(EVENT_A, { venue: null, eventDate: null });

      // "The venue is now unknown" and "leave the venue alone" are different
      // instructions, which is why the SET list is built from present keys
      // rather than with COALESCE.
      expect(updated.venue).toBeNull();
      expect(updated.eventDate).toBeNull();
      expect((await events.find(EVENT_A))?.venue).toBeNull();
    });

    it("an empty patch changes nothing, updated_at included", async () => {
      const { events } = await fresh();
      const created = await events.create(eventInput());

      const updated = await events.update(EVENT_A, {});

      expect(updated.updatedAt?.getTime()).toBe(created.updatedAt?.getTime());
      expect(updated.name).toBe(created.name);
    });

    it("REFUSES to change eventId — the taxon is on chain and cannot follow", async () => {
      const { events } = await fresh();
      await events.create(eventInput());
      await events.create(eventInput({ eventId: EVENT_B, name: "Other" }));

      // TypeScript omits eventId from the patch type, which stops nobody: this
      // patch is a parsed JSON body in production, and an admin form that
      // round-trips the whole record posts the id straight back.
      const renumber = events.update(EVENT_A, { eventId: 9999 } as never);
      await expect(renumber).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await renumber.catch((err: XrplLayerError) => {
        expect(err.message).toMatch(/eventId/i);
      });

      // Nothing moved, and nothing was created under the new number.
      expect((await events.find(EVENT_A))?.name).toBe("Ledger Days");
      expect(await events.find(9999)).toBeNull();

      // The same id is the harmless round trip, not a renumber.
      const echoed = await events.update(EVENT_A, {
        eventId: EVENT_A,
        name: "Ledger Days II",
      } as never);
      expect(echoed.eventId).toBe(EVENT_A);
      expect(echoed.name).toBe("Ledger Days II");
    });

    it("throws NOT_FOUND when updating an event that does not exist", async () => {
      const { events } = await fresh();
      await expect(events.update(EVENT_A, { name: "ghost" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(events.update(EVENT_A, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("lists events by event_id, filtered by status and paged", async () => {
      const { events } = await fresh();
      await events.create(eventInput({ eventId: 30, name: "third", status: "open" }));
      await events.create(eventInput({ eventId: 10, name: "first", status: "open" }));
      await events.create(eventInput({ eventId: 20, name: "second", status: "closed" }));

      // event_id, not event_date: the date is nullable and can tie, which makes
      // it a paging hazard. The PK cannot.
      expect((await events.list()).map((e) => e.eventId)).toEqual([10, 20, 30]);

      expect((await events.list({ status: "open" })).map((e) => e.eventId)).toEqual([10, 30]);
      expect(await events.list({ status: "draft" })).toEqual([]);

      const page1 = await events.list({ limit: 2, offset: 0 });
      const page2 = await events.list({ limit: 2, offset: 2 });
      expect(page1.map((e) => e.eventId)).toEqual([10, 20]);
      expect(page2.map((e) => e.eventId)).toEqual([30]);
      expect(await events.list({ offset: 99 })).toEqual([]);
    });

    it("records the minting issuer once, and leaves it alone after a rotation", async () => {
      const { events } = await fresh();
      await events.create(eventInput());

      // Nothing minted yet: the reader falls back to the configured issuer.
      expect((await events.find(EVENT_A))?.issuerAddress ?? null).toBeNull();

      await events.noteIssuer(EVENT_A, "rOLDISSUERxxxxxxxxxxxxxxxxxxxxxxx");
      expect((await events.find(EVENT_A))?.issuerAddress).toBe("rOLDISSUERxxxxxxxxxxxxxxxxxxxxxxx");

      // The badges on the ledger did not move when the server's issuer did.
      await events.noteIssuer(EVENT_A, "rNEWISSUERxxxxxxxxxxxxxxxxxxxxxxx");
      expect((await events.find(EVENT_A))?.issuerAddress).toBe("rOLDISSUERxxxxxxxxxxxxxxxxxxxxxxx");

      // An event that is not there is not an error: this runs beside a claim.
      await expect(events.noteIssuer(EVENT_B, "rOLDISSUERxxxxxxxxxxxxxxxxxxxxxxx")).resolves.toBeUndefined();
    });

    it("hasBadges answers from the attendance index", async () => {
      const { events, repo } = await fresh();
      await events.create(eventInput());
      await events.create(eventInput({ eventId: EVENT_B, name: "Other" }));

      // Nothing minted yet: an admin may still renumber or delete freely.
      expect(await events.hasBadges(EVENT_A)).toBe(false);

      await repo.insert(claim({ eventId: EVENT_A }));

      // Now a badge on chain carries this taxon. A destructive edit orphans it.
      expect(await events.hasBadges(EVENT_A)).toBe(true);
      expect(await events.hasBadges(EVENT_B)).toBe(false);
    });

    // -----------------------------------------------------------------------
    // RegistrationRepository — sign-ups, and the desk
    // -----------------------------------------------------------------------

    it("registers an attendee and reads them back", async () => {
      const { registrations } = await withEvent(await fresh());

      const created = await registrations.create({
        eventId: EVENT_A,
        address: ALICE,
        addressProof: "xaman_signin",
        displayName: "Alice",
        email: "alice@example.test",
        signinPayloadUuid: "3f2b8c1a-0000-4000-8000-0123456789ab",
      });

      expect(created.id).toBeTruthy();
      expect(typeof created.id).toBe("string");
      expect(created.eventId).toBe(EVENT_A);
      expect(created.address).toBe(ALICE);
      expect(created.addressProof).toBe("xaman_signin");
      expect(created.displayName).toBe("Alice");
      expect(created.email).toBe("alice@example.test");
      expect(created.signinPayloadUuid).toBe("3f2b8c1a-0000-4000-8000-0123456789ab");
      expect(created.registeredAt).toBeInstanceOf(Date);
      // Registering is an intention. Nobody has seen them yet.
      expect(created.checkedInAt ?? null).toBeNull();

      expect((await registrations.findById(created.id))?.address).toBe(ALICE);
      expect((await registrations.findByAddress(EVENT_A, ALICE))?.id).toBe(created.id);
      expect(await registrations.findByAddress(EVENT_A, BOB)).toBeNull();
      expect(await registrations.findById("999999")).toBeNull();
      expect(await registrations.findById("not-an-id")).toBeNull();
    });

    it("accepts a self-declared address with no contact details", async () => {
      const { registrations } = await withEvent(await fresh());

      const created = await registrations.create({
        eventId: EVENT_A,
        address: BOB,
        addressProof: "self_declared",
      });

      expect(created.addressProof).toBe("self_declared");
      expect(created.displayName ?? null).toBeNull();
      expect(created.email ?? null).toBeNull();
      expect(created.signinPayloadUuid ?? null).toBeNull();
    });

    it("rejects an addressProof outside the pair", async () => {
      const { registrations } = await withEvent(await fresh());
      await expect(
        registrations.create({
          eventId: EVENT_A,
          address: ALICE,
          addressProof: "trust_me" as never,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("stores the address verbatim: base58 is case-sensitive", async () => {
      const { registrations } = await withEvent(await fresh());
      await registrations.create({
        eventId: EVENT_A,
        address: ALICE,
        addressProof: "xaman_signin",
      });

      // If anything folded case, the desk would tell a registered attendee
      // they are not on the list — or find them under an address that is not
      // a real account.
      expect(await registrations.findByAddress(EVENT_A, ALICE.toLowerCase())).toBeNull();
      expect((await registrations.findByAddress(EVENT_A, ALICE))?.address).toBe(ALICE);
    });

    it("refuses a duplicate (event, address) with a typed error, not a 500", async () => {
      const { registrations } = await withEvent(await fresh());
      await registrations.create({
        eventId: EVENT_A,
        address: ALICE,
        addressProof: "xaman_signin",
      });

      // A refreshed form or a double-tapped button. Expected, not exceptional.
      const second = registrations.create({
        eventId: EVENT_A,
        address: ALICE,
        addressProof: "self_declared",
        displayName: "Alice again",
      });

      await expect(second).rejects.toBeInstanceOf(XrplLayerError);
      await expect(second).rejects.toMatchObject({ code: "DUPLICATE_CLAIM" });
      await second.catch((err: XrplLayerError) => {
        expect(err.details?.constraint).toBe("event_id,address");
      });

      const counts = await registrations.countByEvent(EVENT_A);
      expect(counts.total).toBe(1);
      // And the loser did not overwrite the winner.
      expect((await registrations.findByAddress(EVENT_A, ALICE))?.addressProof).toBe(
        "xaman_signin",
      );
    });

    it("lets one wallet register for two different events", async () => {
      const subjects = await withEvent(await fresh());
      await subjects.events.create(eventInput({ eventId: EVENT_B, name: "Second" }));

      await subjects.registrations.create({
        eventId: EVENT_A,
        address: ALICE,
        addressProof: "xaman_signin",
      });
      await expect(
        subjects.registrations.create({
          eventId: EVENT_B,
          address: ALICE,
          addressProof: "xaman_signin",
        }),
      ).resolves.toMatchObject({ eventId: EVENT_B });
    });

    it("refuses to register for an event that does not exist", async () => {
      const { registrations } = await fresh();

      // The foreign key firing. A typo in an event id is a 404, not a pg error
      // leaking out of the persistence layer.
      const orphan = registrations.create({
        eventId: 987_654,
        address: ALICE,
        addressProof: "xaman_signin",
      });
      await expect(orphan).rejects.toBeInstanceOf(XrplLayerError);
      await expect(orphan).rejects.toMatchObject({ code: "NOT_FOUND" });

      // An id no event could ever have is still just a missing event, not a
      // range error from an `integer` column.
      await expect(
        registrations.create({
          eventId: MAX_TAXON + 1,
          address: ALICE,
          addressProof: "xaman_signin",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("CONCURRENCY: eight simultaneous sign-ups for ONE wallet yield exactly one", async () => {
      const { registrations } = await withEvent(await fresh());

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          registrations.create({
            eventId: EVENT_A,
            address: ALICE,
            addressProof: "xaman_signin",
          }),
        ),
      );

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await registrations.countByEvent(EVENT_A)).total).toBe(1);
      for (const rejected of results.filter((r) => r.status === "rejected")) {
        expect((rejected.reason as XrplLayerError).code).toBe("DUPLICATE_CLAIM");
      }
    });

    it("pages listByEvent newest-first and filters on checked-in", async () => {
      const subjects = await withEvent(await fresh());
      await subjects.events.create(eventInput({ eventId: EVENT_B, name: "Second" }));
      const { registrations } = subjects;

      const addresses = [ALICE, BOB, CAROL, addr(11), addr(12)];
      const ids: string[] = [];
      for (const address of addresses) {
        const created = await registrations.create({
          eventId: EVENT_A,
          address,
          addressProof: "xaman_signin",
        });
        ids.push(created.id);
      }
      await registrations.create({
        eventId: EVENT_B,
        address: ALICE,
        addressProof: "xaman_signin",
      });

      // NEWEST FIRST. Oldest-first put whoever just signed up on the last
      // page, which is the wrong end for every screen that reads this.
      const all = await registrations.listByEvent(EVENT_A);
      expect(all).toHaveLength(5);
      expect(all.map((r) => r.address)).toEqual([...addresses].reverse());

      const page1 = await registrations.listByEvent(EVENT_A, { limit: 2, offset: 0 });
      const page2 = await registrations.listByEvent(EVENT_A, { limit: 2, offset: 2 });
      const page3 = await registrations.listByEvent(EVENT_A, { limit: 2, offset: 4 });
      const paged = [...page1, ...page2, ...page3].map((r) => r.id);
      expect(paged).toEqual(all.map((r) => r.id));
      expect(new Set(paged).size).toBe(5);
      expect(await registrations.listByEvent(EVENT_A, { offset: 99 })).toEqual([]);

      // Two people through the door.
      await registrations.markCheckedIn(ids[1]!);
      await registrations.markCheckedIn(ids[3]!);

      // The desk's two questions.
      const arrived = await registrations.listByEvent(EVENT_A, { checkedIn: true });
      const expected = await registrations.listByEvent(EVENT_A, { checkedIn: false });
      expect(arrived.map((r) => r.address)).toEqual([addr(11), BOB]);
      expect(expected.map((r) => r.address)).toEqual([addr(12), CAROL, ALICE]);
      expect(arrived.every((r) => r.checkedInAt instanceof Date)).toBe(true);
      expect(expected.every((r) => (r.checkedInAt ?? null) === null)).toBe(true);

      // The filter pages too, and does not leak the other event.
      expect(
        (await registrations.listByEvent(EVENT_A, { checkedIn: false, limit: 1 })).map(
          (r) => r.address,
        ),
      ).toEqual([addr(12)]);
      expect(await registrations.listByEvent(EVENT_B, { checkedIn: true })).toEqual([]);
    });

    it("counts totals and arrivals per event", async () => {
      const subjects = await withEvent(await fresh());
      await subjects.events.create(eventInput({ eventId: EVENT_B, name: "Second" }));
      const { registrations } = subjects;

      expect(await registrations.countByEvent(EVENT_A)).toEqual({ total: 0, checkedIn: 0 });

      const a = await registrations.create({
        eventId: EVENT_A,
        address: ALICE,
        addressProof: "xaman_signin",
      });
      await registrations.create({
        eventId: EVENT_A,
        address: BOB,
        addressProof: "self_declared",
      });
      await registrations.create({
        eventId: EVENT_B,
        address: CAROL,
        addressProof: "xaman_signin",
      });

      expect(await registrations.countByEvent(EVENT_A)).toEqual({ total: 2, checkedIn: 0 });

      await registrations.markCheckedIn(a.id);

      expect(await registrations.countByEvent(EVENT_A)).toEqual({ total: 2, checkedIn: 1 });
      expect(await registrations.countByEvent(EVENT_B)).toEqual({ total: 1, checkedIn: 0 });
      const counts = await registrations.countByEvent(EVENT_A);
      expect(typeof counts.total).toBe("number");
      expect(typeof counts.checkedIn).toBe("number");
    });

    it("markCheckedIn is IDEMPOTENT: a double-tap is not a second arrival", async () => {
      const { registrations } = await withEvent(await fresh());
      const created = await registrations.create({
        eventId: EVENT_A,
        address: ALICE,
        addressProof: "xaman_signin",
      });

      const first = new Date(Date.UTC(2026, 4, 1, 9, 0, 0));
      const later = new Date(Date.UTC(2026, 4, 1, 17, 30, 0));

      await registrations.markCheckedIn(created.id, first);
      const afterFirst = await registrations.findById(created.id);
      expect(afterFirst?.checkedInAt?.toISOString()).toBe(first.toISOString());

      // A volunteer leaning on the button at a noisy door. Neither an error
      // nor a rewrite: the first arrival is the one that happened.
      await expect(registrations.markCheckedIn(created.id, later)).resolves.toBeUndefined();
      await expect(registrations.markCheckedIn(created.id)).resolves.toBeUndefined();

      expect((await registrations.findById(created.id))?.checkedInAt?.toISOString()).toBe(
        first.toISOString(),
      );
      expect((await registrations.countByEvent(EVENT_A)).checkedIn).toBe(1);
    });

    it("markCheckedIn on a registration that does not exist is NOT_FOUND", async () => {
      const { registrations } = await withEvent(await fresh());
      // Telling the desk "checked in" for a row that is not there is a lie the
      // desk would act on.
      await expect(registrations.markCheckedIn("999999")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(registrations.markCheckedIn("not-an-id")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    // -----------------------------------------------------------------------
    // Events carry an allowance and a budget
    // -----------------------------------------------------------------------

    it("keeps an event's allowance and budget as exact XRP, defaulting to nothing", async () => {
      const { events } = await fresh();

      const plain = await events.create(eventInput());
      expect(plain.allowanceXrp).toBe("0");
      expect(plain.budgetXrp).toBe("0");

      const paid = await events.create(
        eventInput({ eventId: EVENT_B, name: "Paid", allowanceXrp: "2.50", budgetXrp: "0.1" }),
      );
      // One spelling, whichever way it was typed.
      expect(paid.allowanceXrp).toBe("2.5");
      expect(paid.budgetXrp).toBe("0.1");
      expect((await events.find(EVENT_B))?.allowanceXrp).toBe("2.5");
      expect((await events.list()).find((e) => e.eventId === EVENT_B)?.budgetXrp).toBe("0.1");

      // Far past 2^53 drops, where a JS number would quietly round.
      const raised = await events.update(EVENT_B, {
        allowanceXrp: "3.000001",
        budgetXrp: "99999999999.999999",
      });
      expect(raised.allowanceXrp).toBe("3.000001");
      expect(raised.budgetXrp).toBe("99999999999.999999");

      // Untouched by a patch that does not mention them.
      const renamed = await events.update(EVENT_B, { name: "Renamed" });
      expect(renamed.allowanceXrp).toBe("3.000001");
      expect(renamed.budgetXrp).toBe("99999999999.999999");
    });

    it("refuses an allowance or a budget that is not an XRP amount", async () => {
      const { events } = await fresh();

      for (const bad of ["-1", "1.0000001", "1e3", "one", ""]) {
        await expect(events.create(eventInput({ allowanceXrp: bad }))).rejects.toMatchObject({
          code: "INVALID_INPUT",
        });
      }

      await events.create(eventInput());
      await expect(events.update(EVENT_A, { budgetXrp: "0.1234567" })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      expect((await events.find(EVENT_A))?.budgetXrp).toBe("0");
    });

    // -----------------------------------------------------------------------
    // TreasuryRepository — one wallet per event, its seed sealed
    // -----------------------------------------------------------------------

    it("stores a treasury once, and hands the first one back to every later writer", async () => {
      const { treasuries } = await withEvent(await fresh());

      const first = await treasuries.insertIfAbsent({
        eventId: EVENT_A,
        address: TREASURY_1,
        sealedSeed: SEALED,
      });
      expect(first.created).toBe(true);
      expect(first.record).toMatchObject({ eventId: EVENT_A, address: TREASURY_1, sealedSeed: SEALED });
      expect(first.record.createdAt).toBeInstanceOf(Date);

      // A second writer — another instance backfilling at boot — gets the row
      // that is already there, never a second wallet for the same event.
      const second = await treasuries.insertIfAbsent({
        eventId: EVENT_A,
        address: TREASURY_2,
        sealedSeed: `${SEALED}x`,
      });
      expect(second.created).toBe(false);
      expect(second.record.address).toBe(TREASURY_1);
      expect((await treasuries.find(EVENT_A))?.address).toBe(TREASURY_1);

      expect(await treasuries.find(EVENT_B)).toBeNull();
      expect(await treasuries.find(MAX_TAXON + 1)).toBeNull();
    });

    it("CONCURRENCY: eight simultaneous backfills give an event exactly one treasury", async () => {
      const { treasuries } = await withEvent(await fresh());

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          treasuries.insertIfAbsent({
            eventId: EVENT_A,
            address: Wallet.generate().classicAddress,
            sealedSeed: SEALED,
          }),
        ),
      );

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.record.address)).size).toBe(1);
    });

    it("refuses an unsealed seed without repeating it, a missing event, and a taken address", async () => {
      const subjects = await withEvent(await fresh());
      await subjects.events.create(eventInput({ eventId: EVENT_B, name: "Other" }));
      const { treasuries } = subjects;

      // A plaintext family seed in that column would undo the whole point of sealing.
      const plaintext = "sEdV6Xn3bRq9J2wY4tK8mZpL1cH7dQa";
      const refused = await treasuries
        .insertIfAbsent({ eventId: EVENT_A, address: TREASURY_1, sealedSeed: plaintext })
        .catch((err: XrplLayerError) => err);
      expect(refused).toMatchObject({ code: "INVALID_INPUT" });
      const said = refused as XrplLayerError;
      expect(JSON.stringify({ message: said.message, details: said.details })).not.toContain(plaintext);
      expect(await treasuries.find(EVENT_A)).toBeNull();

      await expect(
        treasuries.insertIfAbsent({ eventId: 987_654, address: TREASURY_1, sealedSeed: SEALED }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      await treasuries.insertIfAbsent({ eventId: EVENT_A, address: TREASURY_1, sealedSeed: SEALED });
      await expect(
        treasuries.insertIfAbsent({ eventId: EVENT_B, address: TREASURY_1, sealedSeed: SEALED }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    // -----------------------------------------------------------------------
    // AllowanceLedger — once per attendee, inside the event's budget
    // -----------------------------------------------------------------------

    it("books an allowance and reads it back", async () => {
      const { allowances } = await withEvent(await fresh());

      const row = await allowances.reserve(booking({ allowanceXrp: "5.00" }));

      expect(row).toMatchObject({
        eventId: EVENT_A,
        address: PAYEE_1,
        allowanceXrp: "5",
        topupXrp: "1.21",
        amountXrp: "6.21",
        treasuryAddress: TREASURY_1,
        status: "reserved",
        txHash: null,
        confirmedAt: null,
      });
      expect(typeof row?.id).toBe("string");
      expect(row?.reservedAt).toBeInstanceOf(Date);
      expect((await allowances.find(EVENT_A, PAYEE_1))?.id).toBe(row?.id);
      expect(await allowances.find(EVENT_A, PAYEE_2)).toBeNull();
      // Base58 is case-sensitive; nothing here folds it.
      expect(await allowances.find(EVENT_A, PAYEE_1.toLowerCase())).toBeNull();
    });

    it("books one allowance per attendee per event, and says so with null", async () => {
      const subjects = await withEvent(await fresh());
      await subjects.events.create(eventInput({ eventId: EVENT_B, name: "Other" }));
      const { allowances } = subjects;

      expect(await allowances.reserve(booking())).not.toBeNull();
      // A double tap at the desk is the expected case, not an error.
      expect(await allowances.reserve(booking())).toBeNull();
      // Another event is another allowance.
      expect(await allowances.reserve(booking({ eventId: EVENT_B }))).not.toBeNull();
    });

    it("enforces the event's budget inside reserve, to the drop, counting what is in flight", async () => {
      const { allowances } = await withEvent(await fresh());

      // 6.21 + 3.79 === 10 exactly. Allowed, and neither is confirmed.
      expect(await allowances.reserve(booking({ budgetXrp: "10" }))).not.toBeNull();
      expect(
        await allowances.reserve(
          booking({ address: PAYEE_2, allowanceXrp: "3.78", topupXrp: "0.01", budgetXrp: "10" }),
        ),
      ).not.toBeNull();

      // One drop more is one drop too many.
      expect(
        await allowances.reserve(
          booking({ address: PAYEE_3, allowanceXrp: "0", topupXrp: "0.000001", budgetXrp: "10" }),
        ),
      ).toBeNull();
      expect((await allowances.summary(EVENT_A)).committedXrp).toBe("10");
    });

    it("keeps each event's budget to itself", async () => {
      const subjects = await withEvent(await fresh());
      await subjects.events.create(eventInput({ eventId: EVENT_B, name: "Other" }));
      const { allowances } = subjects;

      expect(await allowances.reserve(booking({ budgetXrp: "6.21" }))).not.toBeNull();
      // Event A is spent out. Event B has not paid anybody.
      expect(await allowances.reserve(booking({ address: PAYEE_2, budgetXrp: "6.21" }))).toBeNull();
      expect(
        await allowances.reserve(booking({ eventId: EVENT_B, address: PAYEE_2, budgetXrp: "6.21" })),
      ).not.toBeNull();
    });

    it("release frees the attendee and the headroom, and never erases a confirmed payment", async () => {
      const { allowances } = await withEvent(await fresh());

      const inFlight = await allowances.reserve(booking({ budgetXrp: "6.21" }));
      expect(await allowances.reserve(booking({ address: PAYEE_2, budgetXrp: "6.21" }))).toBeNull();

      await allowances.release(inFlight!.id);
      expect(await allowances.find(EVENT_A, PAYEE_1)).toBeNull();

      const paid = await allowances.reserve(booking({ address: PAYEE_2, budgetXrp: "6.21" }));
      expect(paid).not.toBeNull();
      await allowances.confirm(paid!.id, hash(0xa11));

      // A stray release must never delete money that actually left.
      await allowances.release(paid!.id);
      expect(await allowances.find(EVENT_A, PAYEE_2)).toMatchObject({
        status: "confirmed",
        txHash: hash(0xa11),
      });
      expect((await allowances.summary(EVENT_A)).committedXrp).toBe("6.21");

      await expect(allowances.release("999999")).resolves.toBeUndefined();
      await expect(allowances.release("not-an-id")).resolves.toBeUndefined();
    });

    it("confirm is idempotent for one hash, CONFLICT for a hash in use, NOT_FOUND with no booking", async () => {
      const { allowances } = await withEvent(await fresh());
      const a = await allowances.reserve(booking());
      const b = await allowances.reserve(booking({ address: PAYEE_2 }));

      await allowances.confirm(a!.id, hash(0xb01));
      // A retried confirm of the same Payment is a no-op, not a fault.
      await expect(allowances.confirm(a!.id, hash(0xb01))).resolves.toBeUndefined();
      // One Payment is one allowance.
      await expect(allowances.confirm(b!.id, hash(0xb01))).rejects.toMatchObject({ code: "CONFLICT" });
      // A Payment with no booking behind it is a hole in the books, and loud.
      await expect(allowances.confirm("999999", hash(0xb02))).rejects.toMatchObject({
        code: "NOT_FOUND",
      });

      const confirmed = await allowances.find(EVENT_A, PAYEE_1);
      expect(confirmed).toMatchObject({ status: "confirmed", txHash: hash(0xb01) });
      expect(confirmed?.confirmedAt).toBeInstanceOf(Date);
      expect((await allowances.find(EVENT_A, PAYEE_2))?.status).toBe("reserved");
    });

    it("adds an event up exactly, and lists it newest first", async () => {
      const subjects = await withEvent(await fresh());
      await subjects.events.create(eventInput({ eventId: EVENT_B, name: "Other" }));
      const { allowances } = subjects;

      expect(await allowances.summary(EVENT_A)).toEqual({
        committedXrp: "0",
        paidXrp: "0",
        paidCount: 0,
        inFlightCount: 0,
      });

      // 0.1 + 0.2 is the float trap. In drops it is exactly 0.3.
      const a = await allowances.reserve(booking({ address: PAYEE_1, allowanceXrp: "0.09", topupXrp: "0.01" }));
      const b = await allowances.reserve(booking({ address: PAYEE_2, allowanceXrp: "0.19", topupXrp: "0.01" }));
      const c = await allowances.reserve(booking({ address: PAYEE_3, allowanceXrp: "0", topupXrp: "0.000001" }));
      await allowances.reserve(booking({ eventId: EVENT_B }));
      await allowances.confirm(a!.id, hash(0xc01));
      await allowances.confirm(b!.id, hash(0xc02));

      expect(await allowances.summary(EVENT_A)).toEqual({
        committedXrp: "0.300001",
        paidXrp: "0.3",
        paidCount: 2,
        inFlightCount: 1,
      });

      expect((await allowances.listByEvent(EVENT_A)).map((r) => r.id)).toEqual([c!.id, b!.id, a!.id]);
      expect((await allowances.listByEvent(EVENT_A, { status: "reserved" })).map((r) => r.id)).toEqual([
        c!.id,
      ]);
      expect((await allowances.listByEvent(EVENT_A, { limit: 1, offset: 1 })).map((r) => r.id)).toEqual([
        b!.id,
      ]);
      expect(await allowances.listByEvent(EVENT_B)).toHaveLength(1);
    });

    it("refuses a payment of nothing, an address that is not one, and an event that does not exist", async () => {
      const { allowances } = await withEvent(await fresh());

      await expect(
        allowances.reserve(booking({ allowanceXrp: "0", topupXrp: "0" })),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(allowances.reserve(booking({ address: "rNope" }))).rejects.toMatchObject({
        code: "INVALID_ADDRESS",
      });
      await expect(allowances.reserve(booking({ allowanceXrp: "not money" }))).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      await expect(allowances.reserve(booking({ eventId: 987_654 }))).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await allowances.summary(EVENT_A)).toMatchObject({ paidCount: 0, inFlightCount: 0 });
    });

    // ---- the two races --------------------------------------------------------

    it("CONCURRENCY: eight simultaneous bookings for ONE attendee yield exactly one", async () => {
      const { allowances } = await withEvent(await fresh());

      const results = await Promise.all(Array.from({ length: 8 }, () => allowances.reserve(booking())));

      const won = results.filter((r): r is AllowanceRecord => r !== null);
      expect(won).toHaveLength(1);
      expect((await allowances.summary(EVENT_A)).committedXrp).toBe("6.21");
    });

    it("CONCURRENCY: twenty attendees racing for a budget that covers three get exactly three", async () => {
      const { allowances } = await withEvent(await fresh());
      const payees = Array.from({ length: 20 }, () => Wallet.generate().classicAddress);

      // 6.21 x 3 = 18.63. A fourth would need 24.84.
      const results = await Promise.all(
        payees.map((address) => allowances.reserve(booking({ address, budgetXrp: "18.63" }))),
      );

      const won = results.filter((r): r is AllowanceRecord => r !== null);
      expect(won).toHaveLength(3);
      expect(new Set(won.map((r) => r.address)).size).toBe(3);
      expect((await allowances.summary(EVENT_A)).committedXrp).toBe("18.63");
      // And no phantom headroom is left behind.
      expect(
        await allowances.reserve(
          booking({ address: PAYEE_3, allowanceXrp: "0", topupXrp: "0.000001", budgetXrp: "18.63" }),
        ),
      ).toBeNull();
    });

    // -----------------------------------------------------------------------
    // VendorRepository — who sells what
    // -----------------------------------------------------------------------

    it("adds vendors and their items, and reads them back in the order they were added", async () => {
      const subjects = await withEvent(await fresh());
      await subjects.events.create(eventInput({ eventId: EVENT_B, name: "Other" }));
      const { vendors } = subjects;

      const dominos = await vendors.createVendor({ eventId: EVENT_A, name: "  Dominos  ", walletAddress: TREASURY_2 });
      const adidas = await vendors.createVendor({ eventId: EVENT_A, name: "Adidas", walletAddress: PAYEE_3 });
      expect(dominos).toMatchObject({ eventId: EVENT_A, name: "Dominos", walletAddress: TREASURY_2, active: true });
      expect(dominos.createdAt).toBeInstanceOf(Date);

      const bread = await vendors.createItem({ vendorId: dominos.id, name: "Garlic bread", priceXrp: "2.50" });
      const bottle = await vendors.createItem({ vendorId: adidas.id, name: "Bottle", priceXrp: "3", stock: 40 });
      const pizza = await vendors.createItem({ vendorId: dominos.id, name: "Margherita", priceXrp: "0.000001" });

      // One spelling of every price, and the event copied from the vendor.
      expect(bread).toMatchObject({ vendorId: dominos.id, eventId: EVENT_A, priceXrp: "2.5", stock: null, active: true });
      expect(bottle.stock).toBe(40);
      expect(pizza.priceXrp).toBe("0.000001");

      expect((await vendors.listVendors(EVENT_A)).map((v) => v.name)).toEqual(["Dominos", "Adidas"]);
      expect((await vendors.listItems(EVENT_A)).map((i) => i.name)).toEqual(["Garlic bread", "Bottle", "Margherita"]);
      expect(await vendors.listVendors(EVENT_B)).toEqual([]);
      expect((await vendors.findItem(bottle.id))?.name).toBe("Bottle");
      expect((await vendors.findVendor(adidas.id))?.walletAddress).toBe(PAYEE_3);

      // One wallet can sell at two events, and signing in finds both.
      await vendors.createVendor({ eventId: EVENT_B, name: "Dominos again", walletAddress: TREASURY_2 });
      expect((await vendors.listVendorsByWallet(TREASURY_2)).map((v) => v.eventId)).toEqual([EVENT_A, EVENT_B]);
      expect(await vendors.listVendorsByWallet(PAYEE_1)).toEqual([]);
    });

    it("refuses a wallet already selling at the same event", async () => {
      const { vendors } = await withEvent(await fresh());
      const first = await vendors.createVendor({ eventId: EVENT_A, name: "Dominos", walletAddress: TREASURY_2 });
      const other = await vendors.createVendor({ eventId: EVENT_A, name: "Adidas", walletAddress: PAYEE_3 });

      await expect(
        vendors.createVendor({ eventId: EVENT_A, name: "Dominos two", walletAddress: TREASURY_2 }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(vendors.updateVendor(other.id, { walletAddress: TREASURY_2 })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect((await vendors.findVendor(other.id))?.walletAddress).toBe(PAYEE_3);
      expect((await vendors.findVendor(first.id))?.walletAddress).toBe(TREASURY_2);
    });

    it("refuses what the tables would: names, addresses, prices and stock", async () => {
      const { vendors } = await withEvent(await fresh());
      await expect(vendors.createVendor({ eventId: EVENT_A, name: "  ", walletAddress: TREASURY_2 })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      await expect(vendors.createVendor({ eventId: EVENT_A, name: "x".repeat(121), walletAddress: TREASURY_2 })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      await expect(vendors.createVendor({ eventId: EVENT_A, name: "Nope", walletAddress: "rNope" })).rejects.toMatchObject({
        code: "INVALID_ADDRESS",
      });

      const vendor = await vendors.createVendor({ eventId: EVENT_A, name: "Dominos", walletAddress: TREASURY_2 });
      for (const priceXrp of ["0", "-1", "1.0000001", "free"]) {
        await expect(vendors.createItem({ vendorId: vendor.id, name: "Bread", priceXrp })).rejects.toMatchObject({
          code: "INVALID_INPUT",
        });
      }
      for (const stock of [-1, 1.5, 1_000_001]) {
        await expect(vendors.createItem({ vendorId: vendor.id, name: "Bread", priceXrp: "1", stock })).rejects.toMatchObject({
          code: "INVALID_INPUT",
        });
      }
      expect(await vendors.listItems(EVENT_A)).toEqual([]);
    });

    it("refuses a vendor for an event that does not exist, and an item for a vendor that does not", async () => {
      const { vendors } = await fresh();
      await expect(vendors.createVendor({ eventId: 987_654, name: "Ghost", walletAddress: TREASURY_2 })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(vendors.createItem({ vendorId: "999999", name: "Ghost", priceXrp: "1" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(vendors.updateVendor("999999", { name: "Ghost" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(vendors.updateItem("999999", { name: "Ghost" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await vendors.findVendor("not-an-id")).toBeNull();
      expect(await vendors.findItem("0")).toBeNull();
      expect(await vendors.deleteVendor("999999")).toBe(false);
      expect(await vendors.deleteItem("not-an-id")).toBe(false);
    });

    it("changes only what a patch carries, including clearing stock and hiding", async () => {
      const { vendors } = await withEvent(await fresh());
      const vendor = await vendors.createVendor({ eventId: EVENT_A, name: "Dominos", walletAddress: TREASURY_2 });
      const item = await vendors.createItem({ vendorId: vendor.id, name: "Bread", priceXrp: "2", stock: 10 });

      const renamed = await vendors.updateVendor(vendor.id, { name: "Domino's" });
      expect(renamed).toMatchObject({ name: "Domino's", walletAddress: TREASURY_2, active: true });
      expect((await vendors.updateVendor(vendor.id, { active: false })).active).toBe(false);

      const repriced = await vendors.updateItem(item.id, { priceXrp: "2.25" });
      expect(repriced).toMatchObject({ name: "Bread", priceXrp: "2.25", stock: 10, active: true });
      expect((await vendors.updateItem(item.id, { stock: null })).stock).toBeNull();
      expect((await vendors.updateItem(item.id, { active: false, name: "Old bread" }))).toMatchObject({
        active: false,
        name: "Old bread",
        priceXrp: "2.25",
      });
    });

    it("deletes an unordered vendor with its items, and refuses once somebody has ordered", async () => {
      const subjects = await withEvent(await fresh());
      const { vendors, purchases } = subjects;

      const spare = await vendors.createVendor({ eventId: EVENT_A, name: "Spare", walletAddress: PAYEE_3 });
      await vendors.createItem({ vendorId: spare.id, name: "Nothing", priceXrp: "1" });
      expect(await vendors.deleteVendor(spare.id)).toBe(true);
      expect(await vendors.findVendor(spare.id)).toBeNull();
      expect(await vendors.listItems(EVENT_A)).toEqual([]);

      const s = await stall(subjects);
      const untouched = await vendors.createItem({ vendorId: s.vendor.id, name: "Unordered", priceXrp: "1" });
      expect((await purchases.reserve(order(s))).ok).toBe(true);

      await expect(vendors.deleteItem(s.item.id)).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(vendors.deleteVendor(s.vendor.id)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await vendors.findItem(s.item.id)).not.toBeNull();
      expect(await vendors.deleteItem(untouched.id)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // PurchaseRepository — stock held, then paid by the ledger
    // -----------------------------------------------------------------------

    it("reserves an order and reads it back", async () => {
      const subjects = await fresh();
      const s = await stall(subjects, { priceXrp: "1.25" });
      const input = order(s, { quantity: 3 });

      const outcome = await subjects.purchases.reserve(input);

      expect(outcome.ok).toBe(true);
      const purchase = outcome.ok ? outcome.purchase : null;
      expect(purchase).toMatchObject({
        id: input.id,
        eventId: EVENT_A,
        vendorId: s.vendor.id,
        itemId: s.item.id,
        buyerAddress: PAYEE_1,
        vendorAddress: TREASURY_2,
        quantity: 3,
        unitPriceXrp: "1.25",
        amountXrp: "3.75",
        status: "reserved",
        xamanUuid: null,
        txHash: null,
        paidAt: null,
        handedOverAt: null,
      });
      expect(purchase?.createdAt).toBeInstanceOf(Date);
      expect(purchase?.expiresAt.getTime()).toBe(input.expiresAt.getTime());

      await subjects.purchases.attachPayload(input.id, "3f2b8c1a-0000-4000-8000-0123456789ab");
      expect((await subjects.purchases.find(input.id))?.xamanUuid).toBe("3f2b8c1a-0000-4000-8000-0123456789ab");
      expect(await subjects.purchases.find(randomUUID())).toBeNull();
      expect(await subjects.purchases.find("not-a-uuid")).toBeNull();
    });

    it("holds stock to the unit, and says how many are left", async () => {
      const subjects = await fresh();
      const s = await stall(subjects, { stock: 3 });
      const { purchases } = subjects;

      expect((await purchases.reserve(order(s, { quantity: 2 }))).ok).toBe(true);
      expect(await purchases.reserve(order(s, { quantity: 2 }))).toEqual({ ok: false, reason: "sold_out", remaining: 1 });
      expect((await purchases.reserve(order(s, { quantity: 1 }))).ok).toBe(true);
      expect(await purchases.reserve(order(s, { quantity: 1 }))).toEqual({ ok: false, reason: "sold_out", remaining: 0 });
      expect(await purchases.unitsTaken(EVENT_A)).toEqual({ [s.item.id]: 3 });
    });

    it("stops holding stock when a reservation lapses, but never once it is paid", async () => {
      const subjects = await fresh();
      const s = await stall(subjects, { stock: 1 });
      const { purchases } = subjects;

      // Lapsed the moment it was made: it holds nothing.
      const lapsed = order(s, { expiresAt: new Date(Date.now() - 60_000) });
      expect((await purchases.reserve(lapsed)).ok).toBe(true);
      expect(await purchases.unitsTaken(EVENT_A)).toEqual({});

      const live = order(s);
      expect((await purchases.reserve(live)).ok).toBe(true);
      await purchases.markPaid(live.id, hash(0xd01));
      expect((await purchases.reserve(order(s))).ok).toBe(false);
      expect(await purchases.unitsTaken(EVENT_A)).toEqual({ [s.item.id]: 1 });
    });

    it("caps how many unpaid orders one buyer may hold at an event", async () => {
      const subjects = await fresh();
      const s = await stall(subjects);
      const { purchases } = subjects;

      const first = order(s, { maxOpenPerBuyer: 2 });
      expect((await purchases.reserve(first)).ok).toBe(true);
      expect((await purchases.reserve(order(s, { maxOpenPerBuyer: 2 }))).ok).toBe(true);
      expect(await purchases.reserve(order(s, { maxOpenPerBuyer: 2 }))).toEqual({
        ok: false,
        reason: "too_many_open",
        open: 2,
      });
      // Somebody else is somebody else.
      expect((await purchases.reserve(order(s, { maxOpenPerBuyer: 2, buyerAddress: PAYEE_2 }))).ok).toBe(true);
      // An order that ends frees a place.
      await purchases.markExpired(first.id);
      expect((await purchases.reserve(order(s, { maxOpenPerBuyer: 2 }))).ok).toBe(true);
    });

    it("marks paid from reserved or expired, once per payment, and never twice with different money", async () => {
      const subjects = await fresh();
      const s = await stall(subjects);
      const { purchases } = subjects;
      const a = order(s);
      const b = order(s);
      await purchases.reserve(a);
      await purchases.reserve(b);

      const paid = await purchases.markPaid(a.id, hash(0xe01));
      expect(paid).toMatchObject({ status: "paid", txHash: hash(0xe01) });
      expect(paid.paidAt).toBeInstanceOf(Date);
      // The same payment, reported again, is not a fault.
      expect((await purchases.markPaid(a.id, hash(0xe01))).status).toBe("paid");
      // A different payment for a paid order is.
      await expect(purchases.markPaid(a.id, hash(0xe02))).rejects.toMatchObject({ code: "CONFLICT" });
      // One payment pays for one order.
      await expect(purchases.markPaid(b.id, hash(0xe01))).rejects.toMatchObject({ code: "CONFLICT" });

      // Late money still counts: an expired order that was paid is paid.
      expect((await purchases.markExpired(b.id))?.status).toBe("expired");
      expect((await purchases.markPaid(b.id, hash(0xe03))).status).toBe("paid");
      // And a paid order does not expire.
      expect(await purchases.markExpired(b.id)).toBeNull();
      await expect(purchases.markPaid(randomUUID(), hash(0xe04))).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("hands over only a paid order, keeps the first time, and can be undone", async () => {
      const subjects = await fresh();
      const s = await stall(subjects);
      const { purchases } = subjects;
      const input = order(s);
      await purchases.reserve(input);

      await expect(purchases.setHandedOver(input.id, true)).rejects.toMatchObject({ code: "CONFLICT" });
      await purchases.markPaid(input.id, hash(0xf01));

      const handed = await purchases.setHandedOver(input.id, true);
      expect(handed.handedOverAt).toBeInstanceOf(Date);
      // A double tap is not a second hand-over.
      const again = await purchases.setHandedOver(input.id, true);
      expect(again.handedOverAt?.getTime()).toBe(handed.handedOverAt?.getTime());

      expect((await purchases.setHandedOver(input.id, false)).handedOverAt).toBeNull();
      await expect(purchases.setHandedOver(randomUUID(), true)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("lists orders newest first, filtered, and counts the filter", async () => {
      const subjects = await fresh();
      const s = await stall(subjects);
      const { purchases } = subjects;

      const ids: string[] = [];
      for (const buyerAddress of [PAYEE_1, PAYEE_2, PAYEE_1]) {
        const input = order(s, { buyerAddress });
        await purchases.reserve(input);
        ids.push(input.id);
        // Distinct created_at, so newest-first has one right answer.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await purchases.markPaid(ids[1]!, hash(0xa21));

      expect((await purchases.list()).map((p) => p.id)).toEqual([...ids].reverse());
      expect((await purchases.list({ buyerAddress: PAYEE_1 })).map((p) => p.id)).toEqual([ids[2], ids[0]]);
      expect((await purchases.list({ status: "paid" })).map((p) => p.id)).toEqual([ids[1]]);
      expect((await purchases.list({ vendorId: s.vendor.id, limit: 1, offset: 1 })).map((p) => p.id)).toEqual([ids[1]]);
      expect(await purchases.count({ eventId: EVENT_A })).toBe(3);
      expect(await purchases.count({ status: "reserved", buyerAddress: PAYEE_1 })).toBe(2);
      expect(await purchases.count({ vendorId: "999999" })).toBe(0);
      expect(await purchases.list({ vendorId: "not-an-id" })).toEqual([]);
    });

    it("adds paid sales up per vendor, exactly, under the vendor's current name", async () => {
      const subjects = await fresh();
      const s = await stall(subjects, { priceXrp: "0.1" });
      const other = await subjects.vendors.createVendor({ eventId: EVENT_A, name: "Adidas", walletAddress: PAYEE_3 });
      const bottle = await subjects.vendors.createItem({ vendorId: other.id, name: "Bottle", priceXrp: "0.2" });
      const { purchases } = subjects;

      const a = order(s, { quantity: 2 });
      const b = order(s);
      const c = order({ vendor: other, item: bottle }, { vendorName: "Adidas", itemName: "Bottle" });
      const unpaid = order(s, { quantity: 5 });
      for (const input of [a, b, c, unpaid]) await purchases.reserve(input);
      await purchases.markPaid(a.id, hash(0xb21));
      await purchases.markPaid(b.id, hash(0xb22));
      await purchases.markPaid(c.id, hash(0xb23));
      await purchases.setHandedOver(a.id, true);
      await subjects.vendors.updateVendor(s.vendor.id, { name: "Domino's" });

      expect(await purchases.salesByVendor({ eventId: EVENT_A })).toEqual([
        { vendorId: other.id, eventId: EVENT_A, vendorName: "Adidas", orders: 1, units: 1, totalXrp: "0.2", handedOver: 0 },
        // 0.2 + 0.1 without a float in sight.
        { vendorId: s.vendor.id, eventId: EVENT_A, vendorName: "Domino's", orders: 2, units: 3, totalXrp: "0.3", handedOver: 1 },
      ]);
      expect(await purchases.salesByVendor({ eventId: EVENT_B })).toEqual([]);
    });

    it("refuses an item that is not the vendor's or the event's, and an order that is malformed", async () => {
      const subjects = await fresh();
      const s = await stall(subjects);
      const { purchases } = subjects;

      await expect(purchases.reserve(order(s, { vendorId: "999999" }))).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(purchases.reserve(order(s, { eventId: EVENT_B }))).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(purchases.reserve(order(s, { quantity: 0 }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(purchases.reserve(order(s, { quantity: 101 }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(purchases.reserve(order(s, { id: "not-a-uuid" }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(purchases.reserve(order(s, { buyerAddress: "rNope" }))).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
      expect(await purchases.count()).toBe(0);
    });

    it("CONCURRENCY: twenty buyers racing for the last three units get exactly three", async () => {
      const subjects = await fresh();
      const s = await stall(subjects, { stock: 3 });
      const buyers = Array.from({ length: 20 }, () => Wallet.generate().classicAddress);

      const results = await Promise.all(
        buyers.map((buyerAddress) => subjects.purchases.reserve(order(s, { buyerAddress }))),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(3);
      expect(await subjects.purchases.unitsTaken(EVENT_A)).toEqual({ [s.item.id]: 3 });
    });

    it("CONCURRENCY: one buyer firing ten orders at once holds no more than the cap", async () => {
      const subjects = await fresh();
      const s = await stall(subjects);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => subjects.purchases.reserve(order(s, { maxOpenPerBuyer: 3 }))),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(3);
      expect(await subjects.purchases.count({ buyerAddress: PAYEE_1 })).toBe(3);
    });

    // -----------------------------------------------------------------------
    // VendorSessionStore — a wallet behind a counter
    // -----------------------------------------------------------------------

    it("creates a vendor session and reads it back, storing a hash and never the cookie", async () => {
      const { vendorSessions, storedVendorSessionIds } = await fresh();

      const created = await vendorSessions.create(TREASURY_2, 60_000);
      expect(created.walletAddress).toBe(TREASURY_2);
      expect(created.expiresAt.getTime()).toBeGreaterThan(created.createdAt.getTime());

      expect((await vendorSessions.get(created.id))?.walletAddress).toBe(TREASURY_2);
      const stored = await storedVendorSessionIds();
      expect(stored).not.toContain(created.id);
      expect(stored).toContain(hashSessionId(created.id));
      expect(await vendorSessions.get(hashSessionId(created.id))).toBeNull();
      expect(await vendorSessions.get("")).toBeNull();
    });

    it("refuses an expired vendor session, and revoke ends one", async () => {
      const { vendorSessions } = await fresh();
      const dead = await vendorSessions.create(TREASURY_2, -1_000);
      const live = await vendorSessions.create(PAYEE_3, 60_000);

      expect(await vendorSessions.get(dead.id)).toBeNull();
      await vendorSessions.revoke(live.id);
      expect(await vendorSessions.get(live.id)).toBeNull();
      await expect(vendorSessions.revoke("never-existed")).resolves.toBeUndefined();
      await expect(vendorSessions.create("rNope", 60_000)).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
    });

    // -----------------------------------------------------------------------
    // SessionStore — revocable, hashed, and on the server's clock
    // -----------------------------------------------------------------------

    it("creates a session and reads it back, refreshing last seen", async () => {
      const { sessions } = await fresh();

      const created = await sessions.create(ADMIN, 60_000);
      expect(created.id).toBeTruthy();
      expect(created.email).toBe(ADMIN);
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.expiresAt.getTime()).toBeGreaterThan(created.createdAt.getTime());

      // Long enough that both clocks — the database's now() and the memory
      // store's — have visibly moved on.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const read = await sessions.get(created.id);
      expect(read).not.toBeNull();
      expect(read?.email).toBe(ADMIN);
      expect(read?.id).toBe(created.id);
      expect(read?.lastSeenAt!.getTime()).toBeGreaterThan(created.createdAt.getTime());
    });

    it("returns null for a session id nobody minted", async () => {
      const { sessions } = await fresh();
      await sessions.create(ADMIN, 60_000);
      expect(await sessions.get("not-a-session-id")).toBeNull();
      expect(await sessions.get("")).toBeNull();
    });

    it("STORES A HASH, NOT THE COOKIE VALUE", async () => {
      const { sessions, storedSessionIds } = await fresh();

      const created = await sessions.create(ADMIN, 60_000);
      const stored = await storedSessionIds();

      // The raw id is a bearer token: whoever holds it is the admin, no
      // password involved. A leaked backup or a stray SELECT must not hand
      // over live sessions.
      expect(stored).not.toContain(created.id);
      expect(stored.join(" ")).not.toContain(created.id);
      expect(stored).toContain(hashSessionId(created.id));
      expect(stored).toHaveLength(1);

      // And the digest itself is not a working cookie.
      expect(await sessions.get(hashSessionId(created.id))).toBeNull();
      expect(await sessions.get(created.id)).not.toBeNull();
    });

    it("refuses an expired session, and does not let a caller argue", async () => {
      const { sessions } = await fresh();

      // Born expired. The only way to age a session without waiting out a TTL
      // or reaching past the interface for a clock.
      const dead = await sessions.create(ADMIN, -1_000);
      expect(dead.expiresAt.getTime()).toBeLessThan(Date.now() + 1_000);

      // Expiry is evaluated against the store's own clock — in SQL, against
      // now() — so nothing the caller holds can revive this.
      expect(await sessions.get(dead.id)).toBeNull();

      const live = await sessions.create(OTHER_ADMIN, 60_000);
      expect(await sessions.get(live.id)).not.toBeNull();
    });

    it("revoke ends one session and leaves the others alone", async () => {
      const { sessions } = await fresh();
      const first = await sessions.create(ADMIN, 60_000);
      const second = await sessions.create(ADMIN, 60_000);

      await sessions.revoke(first.id);

      expect(await sessions.get(first.id)).toBeNull();
      expect(await sessions.get(second.id)).not.toBeNull();

      // Silent on an id that is already gone: a retried logout cannot fail.
      await expect(sessions.revoke(first.id)).resolves.toBeUndefined();
      await expect(sessions.revoke("never-existed")).resolves.toBeUndefined();
    });

    it("revokeAll is the remedy after a leaked cookie", async () => {
      const { sessions } = await fresh();
      const laptop = await sessions.create(ADMIN, 60_000);
      const phone = await sessions.create(ADMIN, 60_000);
      const colleague = await sessions.create(OTHER_ADMIN, 60_000);

      await sessions.revokeAll(ADMIN);

      // Every session for that operator, including the one making the call.
      expect(await sessions.get(laptop.id)).toBeNull();
      expect(await sessions.get(phone.id)).toBeNull();
      // Scoped: somebody else's session is not collateral.
      expect(await sessions.get(colleague.id)).not.toBeNull();

      await expect(sessions.revokeAll("nobody@example.test")).resolves.toBeUndefined();
    });

    it("purgeExpired removes the dead and counts them, sparing the living", async () => {
      const { sessions, storedSessionIds } = await fresh();

      await sessions.create(ADMIN, -1_000);
      await sessions.create(ADMIN, -5_000);
      const live = await sessions.create(OTHER_ADMIN, 60_000);

      // An explicit cutoff before anything expired purges nothing.
      expect(await sessions.purgeExpired(new Date(Date.now() - 86_400_000))).toBe(0);

      expect(await sessions.purgeExpired()).toBe(2);
      expect(await storedSessionIds()).toHaveLength(1);
      expect(await sessions.get(live.id)).not.toBeNull();

      // Safe to call on a timer: a second sweep finds nothing left to do.
      expect(await sessions.purgeExpired()).toBe(0);
    });
  });
}

// ---------------------------------------------------------------------------
// Implementation 1: in-memory. Always runs. Never touches a database.
// ---------------------------------------------------------------------------

runRepositoryContract("memory", () => {
  // createMemoryStores, not six constructors: the cross-store links — the
  // events foreign key, the attendance count behind hasBadges — are the part
  // that is easy to wire wrongly, and wiring them wrongly here would quietly
  // weaken the contract rather than fail it.
  const stores = createMemoryStores();
  return {
    repo: stores.attendance,
    treasuries: stores.treasuries,
    allowances: stores.allowances,
    vendors: stores.vendors,
    purchases: stores.purchases,
    vendorSessions: stores.vendorSessions,
    storedVendorSessionIds: async () => stores.vendorSessions.storedIds(),
    claims: stores.claims,
    events: stores.events,
    registrations: stores.registrations,
    sessions: stores.sessions,
    storedSessionIds: async () => stores.sessions.storedIds(),
  };
});

// ---------------------------------------------------------------------------
// dropsToXrpString is the reason the sums above are exact, so pin it directly.
// ---------------------------------------------------------------------------

describe("dropsToXrpString", () => {
  it("renders exact decimal XRP", () => {
    expect(dropsToXrpString(0n)).toBe("0");
    expect(dropsToXrpString(1n)).toBe("0.000001");
    expect(dropsToXrpString(1_500_000n)).toBe("1.5");
    expect(dropsToXrpString(3_000_000n)).toBe("3");
    expect(dropsToXrpString(100_000n + 200_000n)).toBe("0.3");
    expect(dropsToXrpString(50_000_000n)).toBe("50");
    expect(dropsToXrpString(1_234_567n)).toBe("1.234567");
  });

  it("stays exact past the range where a JS number would not", () => {
    // 10^17 drops = 100 billion XRP, above Number.MAX_SAFE_INTEGER in drops.
    expect(dropsToXrpString(100_000_000_000_000_001n)).toBe("100000000000.000001");
  });
});

// ---------------------------------------------------------------------------
// Implementation 2: Postgres. Runs only when TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  describe.skip("postgres: persistence layer contract", () => {
    it("skipped: set TEST_DATABASE_URL to run this suite against a real database", () => {
      expect(true).toBe(true);
    });
  });
} else {
  const pool = createPool(TEST_DATABASE_URL);
  let schemaReady: Promise<void> | undefined;

  /**
   * Every migration in filename order, not a hard-coded list: migrations are
   * append-only, and a suite that has to be edited to see a new one is a suite
   * that will one day be run against the wrong schema.
   */
  const migrate = async (): Promise<void> => {
    const dir = fileURLToPath(new URL("./migrations/", import.meta.url));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b, "en"));
    for (const name of files) {
      await pool.query(readFileSync(`${dir}${name}`, "utf8"));
    }
  };

  afterAll(async () => {
    await closePool(pool);
  });

  runRepositoryContract("postgres", async () => {
    schemaReady ??= migrate();
    await schemaReady;
    // Every contract test starts from an empty index. registrations and events
    // are truncated in the same statement because the foreign key between them
    // makes truncating either alone illegal — which is the schema telling the
    // truth about the relationship.
    await pool.query(
      // CASCADE, because every table added since carries a foreign key to
      // events, and naming them all here is a list that goes stale.
      "TRUNCATE attendance, sponsorship, claims, registrations, allowances, event_treasuries, " +
        "purchases, vendor_items, vendors, vendor_sessions, event_photos, events, sessions " +
        "RESTART IDENTITY CASCADE",
    );
    const sessions = new PgSessionStore(pool);
    const vendorSessions = new PgVendorSessionStore(pool);
    return {
      repo: new PgAttendanceRepository(pool),
      treasuries: new PgTreasuryRepository(pool),
      allowances: new PgAllowanceLedger(pool),
      vendors: new PgVendorRepository(pool),
      purchases: new PgPurchaseRepository(pool),
      vendorSessions,
      storedVendorSessionIds: async () => vendorSessions.storedIds(),
      claims: new PgClaimRepository(pool),
      events: new PgEventRepository(pool),
      registrations: new PgRegistrationRepository(pool),
      sessions,
      storedSessionIds: async () => sessions.storedIds(),
    };
  });
}
