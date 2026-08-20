/**
 * ONE contract suite, two implementations.
 *
 * `runRepositoryContract()` is exported and takes a factory, so the same
 * assertions can be pointed at anything that claims to be an
 * AttendanceRepository + SponsorLedger + ClaimRepository. It runs against the
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
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { dropsToXrp } from "xrpl";
import { XrplLayerError } from "../errors.js";
import type {
  AttendanceRecord,
  AttendanceRepository,
  ClaimRepository,
  SponsorLedger,
  SponsorReservation,
} from "../types.js";
import { PgAttendanceRepository } from "./attendance-repo.js";
import { PgClaimRepository } from "./claim-repo.js";
import {
  MemoryAttendanceRepository,
  MemoryClaimRepository,
  MemorySponsorLedger,
} from "./memory.js";
import { closePool, createPool } from "./pool.js";
import { dropsToXrpString, PgSponsorLedger } from "./sponsor-ledger.js";

// XRPL classic addresses: base58, mixed case, and case-SENSITIVE. Nothing in
// the persistence layer may fold these.
const ALICE = "rAliceQ7hK3xTn9vCJ8pW2dY4mZ6bLs1Nfg";
const BOB = "rBobW4nR8kL2sVc7QpX3jY9tD6hM5eZaUv";
const CAROL = "rCarolM2xF7bN4qT8sJ1wK6vP9dG3hLyRz";

const EVENT_A = 4201;
const EVENT_B = 4202;

/** Big enough to be irrelevant when the test is not about the cap. */
const NO_CAP = "1000000";

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

export interface ContractSubjects {
  repo: AttendanceRepository;
  ledger: SponsorLedger;
  claims: ClaimRepository;
}

export type ContractFactory = () => Promise<ContractSubjects> | ContractSubjects;

/**
 * The contract. Every assertion in here holds for any correct implementation;
 * nothing in here may reach for an implementation-specific method.
 */
export function runRepositoryContract(label: string, factory: ContractFactory): void {
  describe(`${label}: AttendanceRepository + SponsorLedger + ClaimRepository contract`, () => {
    async function fresh(): Promise<ContractSubjects> {
      return factory();
    }

    /** reserve() + confirm(), the whole two-phase spend, for tests about totals. */
    async function spend(
      ledger: SponsorLedger,
      over: {
        eventId?: number;
        address?: string;
        amountXrp?: string;
        dailyCapXrp?: string;
        txHash?: string;
      } = {},
    ): Promise<SponsorReservation | null> {
      const reservation = await ledger.reserve({
        eventId: over.eventId ?? EVENT_A,
        address: over.address ?? ALICE,
        amountXrp: over.amountXrp ?? "1.5",
        dailyCapXrp: over.dailyCapXrp ?? NO_CAP,
      });
      if (reservation) {
        await ledger.confirm(reservation.id, over.txHash ?? hash(Number(reservation.id)));
      }
      return reservation;
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
    // SponsorLedger (brief section 5.4), two-phase
    // -----------------------------------------------------------------------

    it("hasSponsored goes false then true, scoped per event", async () => {
      const { ledger } = await fresh();

      expect(await ledger.hasSponsored(EVENT_A, ALICE)).toBe(false);

      await spend(ledger, { txHash: hash(0x5a1) });

      expect(await ledger.hasSponsored(EVENT_A, ALICE)).toBe(true);
      // One sponsorship per event code per address — a different event is a
      // different budget line.
      expect(await ledger.hasSponsored(EVENT_B, ALICE)).toBe(false);
      expect(await ledger.hasSponsored(EVENT_A, BOB)).toBe(false);
    });

    it("reserve returns a usable reservation", async () => {
      const { ledger } = await fresh();

      const reservation = await ledger.reserve({
        eventId: EVENT_A,
        address: ALICE,
        amountXrp: "1.50",
        dailyCapXrp: NO_CAP,
      });

      expect(reservation).not.toBeNull();
      expect(reservation?.id).toBeTruthy();
      expect(typeof reservation?.id).toBe("string");
      expect(reservation?.eventId).toBe(EVENT_A);
      expect(reservation?.address).toBe(ALICE);
      // Normalised through drops on the way in and out.
      expect(reservation?.amountXrp).toBe("1.5");
    });

    it("refuses a second reservation for the same (event, address) with null, not a throw", async () => {
      const { ledger } = await fresh();
      await spend(ledger, { txHash: hash(0x5a2) });

      const second = await ledger.reserve({
        eventId: EVENT_A,
        address: ALICE,
        amountXrp: "1.5",
        dailyCapXrp: NO_CAP,
      });

      expect(second).toBeNull();
      // The drain guard held: still one payment's worth.
      expect(await ledger.sponsoredTodayXrp()).toBe("1.5");
    });

    it("refuses a repeat sponsorship tx_hash", async () => {
      const { ledger } = await fresh();
      await spend(ledger, { txHash: hash(0x5a4) });

      const second = await ledger.reserve({
        eventId: EVENT_B,
        address: BOB,
        amountXrp: "1.5",
        dailyCapXrp: NO_CAP,
      });
      expect(second).not.toBeNull();

      // One Payment is one sponsorship, across every event.
      await expect(ledger.confirm(second!.id, hash(0x5a4))).rejects.toMatchObject({
        code: "SPONSORSHIP_DENIED",
      });
    });

    it("sums the day's sponsorship as an exact decimal string", async () => {
      const { ledger } = await fresh();
      expect(await ledger.sponsoredTodayXrp()).toBe("0");

      await spend(ledger, { address: ALICE, txHash: hash(0x5b1) });
      expect(await ledger.sponsoredTodayXrp()).toBe("1.5");

      await spend(ledger, { address: BOB, txHash: hash(0x5b2) });

      // The whole point of drops-as-BigInt: exactly "3", not "2.9999999999".
      const total = await ledger.sponsoredTodayXrp();
      expect(total).toBe("3");
      expect(total).not.toContain("9999");
      expect(Number(total)).toBe(dropsToXrp("3000000"));
    });

    it("sums fractions that float addition would mangle", async () => {
      const { ledger } = await fresh();

      // 0.1 + 0.2 is the canonical float trap: 0.30000000000000004.
      await spend(ledger, { address: ALICE, amountXrp: "0.1", txHash: hash(0x5c1) });
      await spend(ledger, { address: BOB, amountXrp: "0.2", txHash: hash(0x5c2) });

      expect(await ledger.sponsoredTodayXrp()).toBe("0.3");

      await spend(ledger, { address: CAROL, amountXrp: "0.000001", txHash: hash(0x5c3) });
      expect(await ledger.sponsoredTodayXrp()).toBe("0.300001");
    });

    it("rejects an amountXrp that is not money", async () => {
      const { ledger } = await fresh();
      await expect(
        ledger.reserve({
          eventId: EVENT_A,
          address: ALICE,
          amountXrp: "not-a-number",
          dailyCapXrp: NO_CAP,
        }),
      ).rejects.toBeInstanceOf(XrplLayerError);
      expect(await ledger.sponsoredTodayXrp()).toBe("0");
    });

    it("enforces the cap inside reserve, to the drop", async () => {
      const { ledger } = await fresh();

      // 8.5 + 1.5 === the 10 XRP cap exactly. Allowed.
      expect(
        await spend(ledger, { address: ALICE, amountXrp: "8.5", dailyCapXrp: "10" }),
      ).not.toBeNull();
      expect(
        await spend(ledger, { address: BOB, amountXrp: "1.5", dailyCapXrp: "10" }),
      ).not.toBeNull();

      // One drop more is one drop too many.
      expect(
        await ledger.reserve({
          eventId: EVENT_A,
          address: CAROL,
          amountXrp: "0.000001",
          dailyCapXrp: "10",
        }),
      ).toBeNull();

      expect(await ledger.sponsoredTodayXrp()).toBe("10");
    });

    it("counts a reserved but unconfirmed spend against the cap", async () => {
      const { ledger } = await fresh();

      // Reserved only: the Payment is on the wire and has not landed.
      const inFlight = await ledger.reserve({
        eventId: EVENT_A,
        address: ALICE,
        amountXrp: "2",
        dailyCapXrp: "3",
      });
      expect(inFlight).not.toBeNull();

      // Money in flight is money spent. If the cap ignored reservations, this
      // second request would sail through and the day would end at 4 XRP.
      expect(await ledger.sponsoredTodayXrp()).toBe("2");
      expect(
        await ledger.reserve({
          eventId: EVENT_A,
          address: BOB,
          amountXrp: "2",
          dailyCapXrp: "3",
        }),
      ).toBeNull();

      // And the address slot is taken while the Payment is in flight, so a
      // retry cannot start a second one.
      expect(await ledger.hasSponsored(EVENT_A, ALICE)).toBe(true);
    });

    it("release frees both the address slot and the cap headroom", async () => {
      const { ledger } = await fresh();

      const reservation = await ledger.reserve({
        eventId: EVENT_A,
        address: ALICE,
        amountXrp: "2",
        dailyCapXrp: "3",
      });
      expect(reservation).not.toBeNull();

      await ledger.release(reservation!.id);

      expect(await ledger.sponsoredTodayXrp()).toBe("0");
      expect(await ledger.hasSponsored(EVENT_A, ALICE)).toBe(false);
      // Both halves are genuinely free again.
      expect(
        await ledger.reserve({
          eventId: EVENT_A,
          address: ALICE,
          amountXrp: "2",
          dailyCapXrp: "3",
        }),
      ).not.toBeNull();
    });

    it("confirm frees nothing, and release cannot erase a confirmed spend", async () => {
      const { ledger } = await fresh();

      const reservation = await spend(ledger, { amountXrp: "2", txHash: hash(0x5e1) });
      expect(reservation).not.toBeNull();

      // A stray release must never delete money that actually left.
      await ledger.release(reservation!.id);

      expect(await ledger.sponsoredTodayXrp()).toBe("2");
      expect(await ledger.hasSponsored(EVENT_A, ALICE)).toBe(true);
    });

    it("release is silent on an id that is already gone", async () => {
      const { ledger } = await fresh();
      await expect(ledger.release("999999")).resolves.toBeUndefined();
      await expect(ledger.release("not-an-id")).resolves.toBeUndefined();
    });

    it("confirm is idempotent for the same hash and NOT_FOUND for a vanished reservation", async () => {
      const { ledger } = await fresh();

      const reservation = await ledger.reserve({
        eventId: EVENT_A,
        address: ALICE,
        amountXrp: "1.5",
        dailyCapXrp: NO_CAP,
      });
      await ledger.confirm(reservation!.id, hash(0x5f1));
      // A retried confirm of the same Payment is a no-op, not a fault.
      await expect(ledger.confirm(reservation!.id, hash(0x5f1))).resolves.toBeUndefined();

      // A reservation that is gone means a Payment landed with nothing on the
      // books to account for it. That is an accounting hole and must be loud.
      await expect(ledger.confirm("999999", hash(0x5f2))).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await ledger.sponsoredTodayXrp()).toBe("1.5");
    });

    // ---- the two races that were measured -----------------------------------

    it("CONCURRENCY: eight simultaneous reserves for ONE address yield exactly one", async () => {
      const { ledger } = await fresh();

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          ledger.reserve({
            eventId: EVENT_A,
            address: ALICE,
            amountXrp: "1.5",
            dailyCapXrp: NO_CAP,
          }),
        ),
      );

      const won = results.filter((r): r is SponsorReservation => r !== null);
      // Measured against check-then-pay-then-record: eight Payments, one row.
      expect(won).toHaveLength(1);
      expect(new Set(won.map((r) => r.id)).size).toBe(1);
      expect(await ledger.sponsoredTodayXrp()).toBe("1.5");
    });

    it("CONCURRENCY: twenty simultaneous reserves for DISTINCT addresses stop at the cap", async () => {
      const { ledger } = await fresh();

      // A 3 XRP cap at 1.5 XRP each admits exactly two.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          ledger.reserve({
            eventId: EVENT_A,
            address: addr(i),
            amountXrp: "1.5",
            dailyCapXrp: "3",
          }),
        ),
      );

      const won = results.filter((r): r is SponsorReservation => r !== null);
      // Measured against the old ordering: twenty Payments, 30 XRP out of a
      // 3 XRP cap, because every caller read the sum before anyone wrote.
      expect(won).toHaveLength(2);
      expect(new Set(won.map((r) => r.address)).size).toBe(2);

      const total = await ledger.sponsoredTodayXrp();
      expect(total).toBe("3");
      expect(Number(total)).toBeLessThanOrEqual(3);

      // And the cap holds afterwards too — no phantom headroom left behind.
      expect(
        await ledger.reserve({
          eventId: EVENT_A,
          address: CAROL,
          amountXrp: "0.000001",
          dailyCapXrp: "3",
        }),
      ).toBeNull();
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
  });
}

// ---------------------------------------------------------------------------
// Implementation 1: in-memory. Always runs. Never touches a database.
// ---------------------------------------------------------------------------

runRepositoryContract("memory", () => ({
  repo: new MemoryAttendanceRepository(),
  ledger: new MemorySponsorLedger(),
  claims: new MemoryClaimRepository(),
}));

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
  describe.skip("postgres: AttendanceRepository + SponsorLedger + ClaimRepository contract", () => {
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
    // Every contract test starts from an empty index.
    await pool.query("TRUNCATE attendance, sponsorship, claims RESTART IDENTITY");
    return {
      repo: new PgAttendanceRepository(pool),
      ledger: new PgSponsorLedger(pool),
      claims: new PgClaimRepository(pool),
    };
  });
}
