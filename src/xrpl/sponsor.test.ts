import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { MockGateway, rippledError } from "../../test/helpers/mock-gateway.js";
import type { SponsorConfig } from "../config.js";
import { MemorySponsorLedger } from "../db/memory.js";
import { AccountNotFoundError, SponsorshipDeniedError } from "../errors.js";
import type {
  EventId,
  SponsorLedger,
  SponsorReservation,
  SponsorReserveInput,
} from "../types.js";
import { accountExists, getAccountBalanceXrp, sponsorWallet } from "./sponsor.js";

const ISSUER = "rBdhYBA2uaVYG7ia2yusmPu5qMS4hE6oQ";
const ATTENDEE = "rPeZcWESwr1Wy64tw6JdVqtKNjhuUzHK2i";
const OTHER = "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w";
const EVENT_ID = 7331;

const CONFIG: SponsorConfig = { enabled: true, amountXrp: "1.5", dailyCapXrp: "10" };

function gateway(): MockGateway {
  return new MockGateway({ issuerAddress: ISSUER });
}

/** account_info answer for an activated account. */
function accountInfo(balanceDrops = "25000000"): Record<string, unknown> {
  return { result: { account_data: { Balance: balanceDrops }, validated: true } };
}

/**
 * A real two-phase ledger, plus a call log.
 *
 * The cap and duplicate logic are delegated to MemorySponsorLedger rather than
 * stubbed: the thing under test is the ORDER in which sponsorWallet touches the
 * ledger and the gateway, and a stub that always says yes cannot show that a
 * lost race stops a Payment. Every call is appended to `log`, which the gateway
 * also writes "submit" into, so ordering is asserted directly and not inferred
 * from outcomes.
 */
class FakeLedger implements SponsorLedger {
  readonly hasSponsoredCalls: Array<{ eventId: EventId; address: string }> = [];
  readonly confirmed: Array<{ reservationId: string; txHash: string }> = [];
  readonly released: string[] = [];
  private readonly book = new MemorySponsorLedger();

  constructor(
    readonly log: string[] = [],
    private readonly opts: { releaseThrows?: boolean } = {},
  ) {}

  /** Book a spend the way an earlier request would have. Not logged. */
  async seed(input: SponsorReserveInput): Promise<void> {
    expect(await this.book.reserve(input)).not.toBeNull();
  }

  async hasSponsored(eventId: EventId, address: string): Promise<boolean> {
    this.log.push("hasSponsored");
    this.hasSponsoredCalls.push({ eventId, address });
    return this.book.hasSponsored(eventId, address);
  }

  async sponsoredTodayXrp(): Promise<string> {
    this.log.push("sponsoredTodayXrp");
    return this.book.sponsoredTodayXrp();
  }

  async reserve(input: SponsorReserveInput): Promise<SponsorReservation | null> {
    this.log.push("reserve");
    return this.book.reserve(input);
  }

  async confirm(reservationId: string, txHash: string): Promise<void> {
    this.log.push("confirm");
    this.confirmed.push({ reservationId, txHash });
    await this.book.confirm(reservationId, txHash);
  }

  async release(reservationId: string): Promise<void> {
    this.log.push("release");
    this.released.push(reservationId);
    if (this.opts.releaseThrows) throw new Error("ledger unreachable");
    await this.book.release(reservationId);
  }

  spentTodayXrp(): Promise<string> {
    return this.book.sponsoredTodayXrp();
  }
}

/** Queues a Payment outcome that also stamps its position in the call log. */
function payment(log: string[], out: Record<string, unknown> = {}) {
  return () => {
    log.push("submit");
    return { hash: "PAYHASH", ledgerIndex: 90_400, ...out };
  };
}

describe("accountExists", () => {
  it("is true when account_info resolves", async () => {
    const gw = gateway().onRequest("account_info", accountInfo());
    await expect(accountExists(gw, ATTENDEE)).resolves.toBe(true);
    expect(gw.lastRequest("account_info")?.account).toBe(ATTENDEE);
  });

  it("is false only for actNotFound", async () => {
    const gw = gateway().onRequest("account_info", rippledError("actNotFound"));
    await expect(accountExists(gw, ATTENDEE)).resolves.toBe(false);
  });

  it("rethrows any other rippled error rather than reporting 'does not exist'", async () => {
    const gw = gateway().onRequest("account_info", rippledError("tooBusy"));
    await expect(accountExists(gw, ATTENDEE)).rejects.toThrowError("tooBusy");
  });

  it("rethrows a transport failure", async () => {
    const gw = gateway().onRequest(
      "account_info",
      new Error("WebSocket closed before a response was received"),
    );
    await expect(accountExists(gw, ATTENDEE)).rejects.toThrowError("WebSocket closed");
  });
});

describe("getAccountBalanceXrp", () => {
  it("converts drops to a decimal XRP string", async () => {
    const gw = gateway().onRequest("account_info", accountInfo("25000000"));
    await expect(getAccountBalanceXrp(gw, ATTENDEE)).resolves.toBe("25");
  });

  it("keeps the fractional part", async () => {
    const gw = gateway().onRequest("account_info", accountInfo("1500001"));
    await expect(getAccountBalanceXrp(gw, ATTENDEE)).resolves.toBe("1.500001");
  });

  it("maps actNotFound onto AccountNotFoundError", async () => {
    const gw = gateway().onRequest("account_info", rippledError("actNotFound"));
    await expect(getAccountBalanceXrp(gw, ATTENDEE)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
  });

  it("throws when the node returns no Balance", async () => {
    const gw = gateway().onRequest("account_info", { result: { account_data: {} } });
    await expect(getAccountBalanceXrp(gw, ATTENDEE)).rejects.toMatchObject({
      code: "LEDGER_QUERY_FAILED",
    });
  });
});

describe("sponsorWallet", () => {
  it("rejects an invalid address before any ledger round trip", async () => {
    const gw = gateway();
    await expect(
      sponsorWallet(gw, { address: "rNope", eventId: EVENT_ID, config: CONFIG }),
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
    expect(gw.requests).toHaveLength(0);
    expect(gw.submits).toHaveLength(0);
  });

  it("refuses when sponsorship is disabled, without querying the ledger", async () => {
    const gw = gateway();
    const err = await sponsorWallet(gw, {
      address: ATTENDEE,
      eventId: EVENT_ID,
      config: { ...CONFIG, enabled: false },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorshipDeniedError);
    expect((err as SponsorshipDeniedError).kind).toBe("disabled");
    expect(gw.requests).toHaveLength(0);
    expect(gw.submits).toHaveLength(0);
  });

  it("skips an account that is already activated, without booking anything", async () => {
    const gw = gateway().onRequest("account_info", accountInfo());
    const ledger = new FakeLedger();

    await expect(
      sponsorWallet(gw, { address: ATTENDEE, eventId: EVENT_ID, config: CONFIG, ledger }),
    ).resolves.toEqual({ sponsored: false, alreadyActivated: true, address: ATTENDEE });

    expect(gw.submits).toHaveLength(0);
    expect(ledger.log).toEqual([]);
    expect(await ledger.spentTodayXrp()).toBe("0");
  });

  // ---------------------------------------------------------------------------
  // Ordering. This is the fix: the spend is booked before the money moves.
  // ---------------------------------------------------------------------------

  it("reserves BEFORE submitting the Payment, and confirms after", async () => {
    const log: string[] = [];
    const ledger = new FakeLedger(log);
    const gw = gateway()
      .onRequest("account_info", rippledError("actNotFound"))
      .onSubmit("Payment", payment(log));

    await sponsorWallet(gw, { address: ATTENDEE, eventId: EVENT_ID, config: CONFIG, ledger });

    // Not "reserve happened and submit happened" — reserve happened FIRST.
    // Under the old check-then-pay-then-record order this reads
    // ["hasSponsored", "sponsoredTodayXrp", "submit", "record"].
    expect(log).toEqual(["reserve", "submit", "confirm"]);
    expect(log.indexOf("reserve")).toBeLessThan(log.indexOf("submit"));
  });

  it("confirms with the hash the ledger actually returned", async () => {
    const log: string[] = [];
    const ledger = new FakeLedger(log);
    const gw = gateway()
      .onRequest("account_info", rippledError("actNotFound"))
      .onSubmit("Payment", payment(log, { hash: "REALHASH", ledgerIndex: 90_401 }));

    const result = await sponsorWallet(gw, {
      address: ATTENDEE,
      eventId: EVENT_ID,
      config: CONFIG,
      ledger,
    });

    expect(ledger.confirmed).toHaveLength(1);
    expect(ledger.confirmed[0]?.txHash).toBe("REALHASH");
    expect(ledger.confirmed[0]?.reservationId).toBeTruthy();
    expect(ledger.released).toEqual([]);
    expect(result.txHash).toBe("REALHASH");
    // Confirmed, not merely reserved: the spend is on the books either way.
    expect(await ledger.spentTodayXrp()).toBe("1.5");
  });

  it("releases the reservation exactly once when the Payment throws, and never confirms", async () => {
    const log: string[] = [];
    const ledger = new FakeLedger(log);
    const gw = gateway()
      .onRequest("account_info", rippledError("actNotFound"))
      .onSubmit("Payment", () => {
        log.push("submit");
        return new Error("tecUNFUNDED_PAYMENT");
      });

    await expect(
      sponsorWallet(gw, { address: ATTENDEE, eventId: EVENT_ID, config: CONFIG, ledger }),
    ).rejects.toThrowError("tecUNFUNDED_PAYMENT");

    expect(log).toEqual(["reserve", "submit", "release"]);
    expect(ledger.released).toHaveLength(1);
    expect(ledger.confirmed).toEqual([]);

    // The headroom came back: a Payment that never landed must not cost cap.
    expect(await ledger.spentTodayXrp()).toBe("0");
    // And the attendee is not locked out by a reservation nobody cleaned up.
    expect(await ledger.hasSponsored(EVENT_ID, ATTENDEE)).toBe(false);
  });

  it("surfaces the Payment failure even when the release itself fails", async () => {
    const log: string[] = [];
    const ledger = new FakeLedger(log, { releaseThrows: true });
    const gw = gateway()
      .onRequest("account_info", rippledError("actNotFound"))
      .onSubmit("Payment", new Error("WebSocket closed before a response was received"));

    // A release that also fails leaves the reservation blocking one attendee,
    // which is the safe direction. It must not replace the real cause.
    await expect(
      sponsorWallet(gw, { address: ATTENDEE, eventId: EVENT_ID, config: CONFIG, ledger }),
    ).rejects.toThrowError("WebSocket closed");
    expect(ledger.released).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Concurrency. These are the two failures that were measured against a real
  // Postgres, reproduced at the sponsorWallet seam.
  // ---------------------------------------------------------------------------

  it("sends ONE Payment when five claims for one new address race", async () => {
    const ledger = new FakeLedger();
    const gw = gateway()
      .onRequest("account_info", rippledError("actNotFound"))
      .onSubmit("Payment", () => ({ hash: `H${gw.submits.length}`, ledgerIndex: 1 }));

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        sponsorWallet(gw, { address: ATTENDEE, eventId: EVENT_ID, config: CONFIG, ledger }),
      ),
    );

    const funded = results.filter((r) => r.status === "fulfilled");
    // Measured against the old ordering: five Payments, 7.5 XRP, one row.
    expect(gw.submits).toHaveLength(1);
    expect(funded).toHaveLength(1);
    expect(await ledger.spentTodayXrp()).toBe("1.5");

    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SponsorshipDeniedError);
      expect((r as PromiseRejectedResult).reason.kind).toBe("duplicate");
    }
  });

  it("stops at the daily cap when twenty distinct addresses race", async () => {
    const ledger = new FakeLedger();
    const gw = gateway()
      .onRequest("account_info", rippledError("actNotFound"))
      .onSubmit("Payment", () => ({ hash: `H${gw.submits.length}`, ledgerIndex: 1 }));

    // 3 XRP of cap at 1.5 XRP each admits exactly two.
    const config: SponsorConfig = { enabled: true, amountXrp: "1.5", dailyCapXrp: "3" };
    const addresses = Array.from({ length: 20 }, () => Wallet.generate().classicAddress);

    const results = await Promise.allSettled(
      addresses.map((address) =>
        sponsorWallet(gw, { address, eventId: EVENT_ID, config, ledger }),
      ),
    );

    // Measured against the old ordering: twenty Payments, 30 XRP, a 10x
    // overshoot of a cap that every one of them had read as clear.
    expect(gw.submits).toHaveLength(2);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await ledger.spentTodayXrp()).toBe("3");

    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason.kind).toBe("daily_cap");
    }
  });

  // ---------------------------------------------------------------------------
  // The guards themselves.
  // ---------------------------------------------------------------------------

  it("refuses a second sponsorship of the same address for the same event", async () => {
    const gw = gateway().onRequest("account_info", rippledError("actNotFound"));
    const ledger = new FakeLedger();
    await ledger.seed({
      eventId: EVENT_ID,
      address: ATTENDEE,
      amountXrp: "1.5",
      dailyCapXrp: "10",
    });

    const err = await sponsorWallet(gw, {
      address: ATTENDEE,
      eventId: EVENT_ID,
      config: CONFIG,
      ledger,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorshipDeniedError);
    expect((err as SponsorshipDeniedError).kind).toBe("duplicate");
    expect(ledger.hasSponsoredCalls).toEqual([{ eventId: EVENT_ID, address: ATTENDEE }]);
    expect(gw.submits).toHaveLength(0);
  });

  it("denies a duplicate even when the reservation is still unconfirmed", async () => {
    const gw = gateway().onRequest("account_info", rippledError("actNotFound"));
    const ledger = new FakeLedger();
    // No confirm() — a Payment is on the wire right now for this address.
    await ledger.seed({
      eventId: EVENT_ID,
      address: ATTENDEE,
      amountXrp: "1.5",
      dailyCapXrp: "10",
    });

    const err = await sponsorWallet(gw, {
      address: ATTENDEE,
      eventId: EVENT_ID,
      config: CONFIG,
      ledger,
    }).catch((e: unknown) => e);

    expect((err as SponsorshipDeniedError).kind).toBe("duplicate");
    expect(gw.submits).toHaveLength(0);
  });

  it("allows a sponsorship that lands exactly on the daily cap", async () => {
    const gw = gateway()
      .onRequest("account_info", rippledError("actNotFound"))
      .onSubmit("Payment", { hash: "PAYHASH", ledgerIndex: 90_400 });
    const ledger = new FakeLedger();
    // 8.5 already spent + 1.5 requested === the 10 XRP cap.
    await ledger.seed({
      eventId: EVENT_ID,
      address: OTHER,
      amountXrp: "8.5",
      dailyCapXrp: "10",
    });

    await expect(
      sponsorWallet(gw, { address: ATTENDEE, eventId: EVENT_ID, config: CONFIG, ledger }),
    ).resolves.toMatchObject({ sponsored: true });
  });

  it("refuses a sponsorship that goes one drop over the daily cap", async () => {
    const gw = gateway()
      .onRequest("account_info", rippledError("actNotFound"))
      .onSubmit("Payment", { hash: "PAYHASH" });
    const ledger = new FakeLedger();
    // 8.500001 + 1.5 === 10.000001 XRP, one drop past the cap.
    await ledger.seed({
      eventId: EVENT_ID,
      address: OTHER,
      amountXrp: "8.500001",
      dailyCapXrp: "10",
    });

    const err = await sponsorWallet(gw, {
      address: ATTENDEE,
      eventId: EVENT_ID,
      config: CONFIG,
      ledger,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorshipDeniedError);
    expect((err as SponsorshipDeniedError).kind).toBe("daily_cap");
    expect((err as SponsorshipDeniedError).details?.spentTodayXrp).toBe("8.500001");
    expect(gw.submits).toHaveLength(0);
  });

  it("compares the cap in integer drops, so 0.1 + 0.2 still fits under 0.3", async () => {
    const gw = gateway()
      .onRequest("account_info", rippledError("actNotFound"))
      .onSubmit("Payment", { hash: "PAYHASH", ledgerIndex: 1 });
    const ledger = new FakeLedger();
    await ledger.seed({
      eventId: EVENT_ID,
      address: OTHER,
      amountXrp: "0.2",
      dailyCapXrp: "0.3",
    });

    // Float arithmetic gives 0.30000000000000004 > 0.3 and would deny this.
    await expect(
      sponsorWallet(gw, {
        address: ATTENDEE,
        eventId: EVENT_ID,
        config: { enabled: true, amountXrp: "0.1", dailyCapXrp: "0.3" },
        ledger,
      }),
    ).resolves.toMatchObject({ sponsored: true });
  });

  it("pays the configured amount in drops from the issuer and books it", async () => {
    const gw = gateway()
      .onRequest("account_info", rippledError("actNotFound"))
      .onSubmit("Payment", { hash: "PAYHASH", ledgerIndex: 90_400, fee: "12" });
    const ledger = new FakeLedger();

    const result = await sponsorWallet(gw, {
      address: ATTENDEE,
      eventId: EVENT_ID,
      config: CONFIG,
      ledger,
    });

    const tx = gw.lastSubmit("Payment");
    expect(tx?.TransactionType).toBe("Payment");
    expect(tx?.Account).toBe(ISSUER);
    expect(tx?.Destination).toBe(ATTENDEE);
    expect(tx?.Amount).toBe("1500000");

    expect(result).toEqual({
      sponsored: true,
      alreadyActivated: false,
      address: ATTENDEE,
      amountXrp: "1.5",
      txHash: "PAYHASH",
      ledgerIndex: 90_400,
    });
    expect(ledger.confirmed).toEqual([
      { reservationId: expect.any(String), txHash: "PAYHASH" },
    ]);
    expect(await ledger.hasSponsored(EVENT_ID, ATTENDEE)).toBe(true);
  });

  it("rethrows a non-actNotFound account_info error instead of sponsoring", async () => {
    const gw = gateway()
      .onRequest("account_info", rippledError("tooBusy"))
      .onSubmit("Payment", { hash: "PAYHASH" });
    const ledger = new FakeLedger();

    await expect(
      sponsorWallet(gw, { address: ATTENDEE, eventId: EVENT_ID, config: CONFIG, ledger }),
    ).rejects.toThrowError("tooBusy");
    // The whole point: a transport hiccup must never fund an already-funded
    // wallet, and must not burn a reservation either.
    expect(gw.submits).toHaveLength(0);
    expect(ledger.log).toEqual([]);
  });

  it("pays with no ledger attached, which is why an API route must always pass one", async () => {
    const gw = gateway()
      .onRequest("account_info", rippledError("actNotFound"))
      .onSubmit("Payment", { hash: "PAYHASH", ledgerIndex: 1 });

    // UNGUARDED: no duplicate check, no cap, no reservation. Scripts only.
    await expect(
      sponsorWallet(gw, { address: ATTENDEE, eventId: EVENT_ID, config: CONFIG }),
    ).resolves.toMatchObject({ sponsored: true, amountXrp: "1.5" });
  });
});
