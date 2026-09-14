/**
 * Paying an attendee's allowance.
 *
 * Driven against the REAL in-memory allowance book rather than a stub that
 * always says yes: what is under test is the order in which payAllowance
 * touches the book and the ledger, and a stub cannot show that a lost race
 * stops a Payment. Every book call and every submit is written to one log, so
 * ordering is asserted directly rather than inferred from outcomes.
 */
import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { MockGateway, rippledError } from "../../test/helpers/mock-gateway.js";
import { MemoryAllowanceLedger } from "../db/allowance-ledger.js";
import { AllowanceDeniedError, ConnectionError, TransactionFailedError } from "../errors.js";
import type {
  AllowanceLedger,
  AllowanceRecord,
  AllowanceReserveInput,
  AllowanceSummary,
  EventId,
} from "../types.js";
import {
  ALLOWANCE_MEMO_TYPE,
  STALE_ALLOWANCE_MS,
  findAllowancePayment,
  isAmbiguousSubmitFailure,
  payAllowance,
  quoteAllowance,
  type PayAllowanceInput,
} from "./allowance.js";
import { memo, readMemos } from "./memos.js";

const ISSUER = "rBdhYBA2uaVYG7ia2yusmPu5qMS4hE6oQ";
const ATTENDEE = "rPeZcWESwr1Wy64tw6JdVqtKNjhuUzHK2i";
const OTHER = "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w";
const EVENT_ID = 7331;
const TREASURY = Wallet.generate();
const PAY_HASH = "AB".repeat(32);

/** The book, with every call written to a shared log. */
class LoggedLedger implements AllowanceLedger {
  constructor(
    readonly log: string[] = [],
    readonly book = new MemoryAllowanceLedger(),
  ) {}

  find(eventId: EventId, address: string): Promise<AllowanceRecord | null> {
    this.log.push("find");
    return this.book.find(eventId, address);
  }
  reserve(input: AllowanceReserveInput): Promise<AllowanceRecord | null> {
    this.log.push("reserve");
    return this.book.reserve(input);
  }
  confirm(id: string, txHash: string): Promise<void> {
    this.log.push("confirm");
    return this.book.confirm(id, txHash);
  }
  release(id: string): Promise<void> {
    this.log.push("release");
    return this.book.release(id);
  }
  summary(eventId: EventId): Promise<AllowanceSummary> {
    this.log.push("summary");
    return this.book.summary(eventId);
  }
  listByEvent(eventId: EventId): Promise<AllowanceRecord[]> {
    return this.book.listByEvent(eventId);
  }
}

function gateway(): MockGateway {
  return new MockGateway({ issuerAddress: ISSUER });
}

/** An empty wallet: the account does not exist. */
function emptyWallet(gw: MockGateway): MockGateway {
  return gw.onRequest("account_info", rippledError("actNotFound"));
}

function paying(log: string[], out: Record<string, unknown> = {}) {
  return () => {
    log.push("submit");
    return { hash: PAY_HASH, ledgerIndex: 90_400, ...out };
  };
}

function input(ledger: AllowanceLedger, over: Partial<PayAllowanceInput> = {}): PayAllowanceInput {
  return {
    eventId: EVENT_ID,
    address: ATTENDEE,
    allowanceXrp: "5",
    budgetXrp: "100",
    feeBufferXrp: "0.01",
    maxPerAttendeeXrp: "10",
    treasury: { address: TREASURY.classicAddress, open: () => TREASURY },
    ledger,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("quoteAllowance", () => {
  const opts = { allowanceXrp: "5", feeBufferXrp: "0.01" };

  it("adds what an empty wallet lacks and the fee buffer to the allowance", () => {
    expect(quoteAllowance("0", opts)).toEqual({
      allowanceXrp: "5",
      topupXrp: "1.21",
      amountXrp: "6.21",
      shortfallXrp: "1.2",
    });
  });

  it("tops up a dust wallet by exactly what it is short", () => {
    expect(quoteAllowance("1", opts)).toMatchObject({ topupXrp: "0.21", amountXrp: "5.21" });
  });

  it("sends a wallet that can hold a badge its allowance and the buffer", () => {
    expect(quoteAllowance("250", opts)).toMatchObject({ topupXrp: "0.01", amountXrp: "5.01", shortfallXrp: "0" });
  });

  it("owes nothing when there is no allowance and the wallet can already hold a badge", () => {
    expect(quoteAllowance("1.2", { allowanceXrp: "0", feeBufferXrp: "0.01" })).toEqual({
      allowanceXrp: "0",
      topupXrp: "0",
      amountXrp: "0",
      shortfallXrp: "0",
    });
  });

  it("still switches on an empty wallet at an event with no allowance", () => {
    expect(quoteAllowance("0.5", { allowanceXrp: "0", feeBufferXrp: "0.01" })).toMatchObject({
      topupXrp: "0.71",
      amountXrp: "0.71",
    });
  });

  it("does its sums in drops: 0.1 + 0.1 + 0.01 is exactly 0.21", () => {
    expect(quoteAllowance("1.1", { allowanceXrp: "0.1", feeBufferXrp: "0.01" }).amountXrp).toBe("0.21");
  });
});

// ---------------------------------------------------------------------------

describe("payAllowance", () => {
  it("books BEFORE paying, pays from the treasury with its memo, and confirms after", async () => {
    const log: string[] = [];
    const ledger = new LoggedLedger(log);
    const gw = emptyWallet(gateway()).onSubmit("Payment", paying(log));

    const result = await payAllowance(gw, input(ledger));

    expect(log).toEqual(["find", "reserve", "submit", "confirm"]);
    expect(result).toEqual({
      outcome: "paid",
      eventId: EVENT_ID,
      address: ATTENDEE,
      allowanceXrp: "5",
      topupXrp: "1.21",
      amountXrp: "6.21",
      txHash: PAY_HASH,
      ledgerIndex: 90_400,
    });

    const [sent] = gw.submits;
    expect(sent?.tx).toMatchObject({
      TransactionType: "Payment",
      Account: TREASURY.classicAddress,
      Destination: ATTENDEE,
      Amount: "6210000",
    });
    // Signed by the treasury wallet, never the gateway's default (the issuer).
    expect(sent?.options?.wallet).toBe(TREASURY);

    const booked = await ledger.book.find(EVENT_ID, ATTENDEE);
    expect(booked).toMatchObject({ status: "confirmed", txHash: PAY_HASH });
    expect(readMemos(sent?.tx ?? {})).toEqual([
      { type: ALLOWANCE_MEMO_TYPE, data: `${EVENT_ID}:${booked?.id}` },
    ]);
  });

  it("answers a second call with the first payment instead of paying again", async () => {
    const ledger = new LoggedLedger();
    const gw = emptyWallet(gateway()).onSubmit("Payment", { hash: PAY_HASH, ledgerIndex: 1 });

    await payAllowance(gw, input(ledger));
    const again = await payAllowance(gw, input(ledger));

    expect(again).toMatchObject({ outcome: "already_paid", amountXrp: "6.21", txHash: PAY_HASH });
    expect(gw.submits).toHaveLength(1);
  });

  it("books nothing and sends nothing when nothing is owed", async () => {
    const log: string[] = [];
    const ledger = new LoggedLedger(log);
    const gw = gateway().onRequest("account_info", {
      result: { account_data: { Balance: "25000000" } },
    });

    const result = await payAllowance(gw, input(ledger, { allowanceXrp: "0" }));

    expect(result).toMatchObject({ outcome: "nothing_owed", amountXrp: "0" });
    expect(log).toEqual(["find"]);
    expect(gw.submits).toHaveLength(0);
  });

  it("uses the balance it is handed rather than asking the ledger again", async () => {
    const ledger = new LoggedLedger();
    const gw = gateway().onSubmit("Payment", { hash: PAY_HASH, ledgerIndex: 1 });

    const result = await payAllowance(gw, input(ledger, { balanceXrp: "1" }));

    expect(result.amountXrp).toBe("5.21");
    expect(gw.requests).toHaveLength(0);
  });

  it("refuses past the server's ceiling, before booking and without opening the treasury", async () => {
    const log: string[] = [];
    const ledger = new LoggedLedger(log);
    let opened = false;
    const gw = emptyWallet(gateway());

    const err = await payAllowance(
      gw,
      input(ledger, {
        allowanceXrp: "9",
        treasury: {
          address: TREASURY.classicAddress,
          open: () => {
            opened = true;
            return TREASURY;
          },
        },
      }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AllowanceDeniedError);
    expect((err as AllowanceDeniedError).kind).toBe("ceiling");
    expect((err as AllowanceDeniedError).details).toMatchObject({ amountXrp: "10.21", maxPerAttendeeXrp: "10" });
    expect(log).toEqual(["find"]);
    expect(opened).toBe(false);
    expect(gw.submits).toHaveLength(0);
  });

  it("refuses with no treasury to pay from, before booking", async () => {
    const log: string[] = [];
    const ledger = new LoggedLedger(log);

    const err = await payAllowance(emptyWallet(gateway()), input(ledger, { treasury: null })).catch(
      (e: unknown) => e,
    );

    expect((err as AllowanceDeniedError).kind).toBe("unavailable");
    expect(log).toEqual(["find"]);
  });

  it("refuses when the budget cannot cover it, and says how much is committed", async () => {
    const ledger = new LoggedLedger();
    await ledger.book.reserve({
      eventId: EVENT_ID,
      address: OTHER,
      allowanceXrp: "4",
      topupXrp: "0",
      treasuryAddress: TREASURY.classicAddress,
      budgetXrp: "10",
    });
    const gw = emptyWallet(gateway());

    const err = await payAllowance(gw, input(ledger, { budgetXrp: "10" })).catch((e: unknown) => e);

    expect((err as AllowanceDeniedError).kind).toBe("budget");
    expect((err as AllowanceDeniedError).details).toMatchObject({
      committedXrp: "4",
      budgetXrp: "10",
      amountXrp: "6.21",
    });
    expect(gw.submits).toHaveLength(0);
    expect(await ledger.book.find(EVENT_ID, ATTENDEE)).toBeNull();
  });

  it("releases the booking when the ledger says no, and never confirms", async () => {
    const log: string[] = [];
    const ledger = new LoggedLedger(log);
    const gw = emptyWallet(gateway()).onSubmit("Payment", () => {
      log.push("submit");
      return new TransactionFailedError("tecNO_DST_INSUF_XRP", "Payment failed with tecNO_DST_INSUF_XRP");
    });

    await expect(payAllowance(gw, input(ledger))).rejects.toBeInstanceOf(TransactionFailedError);

    expect(log).toEqual(["find", "reserve", "submit", "release"]);
    // The budget headroom came back, and the attendee is not locked out.
    expect(await ledger.book.find(EVENT_ID, ATTENDEE)).toBeNull();
    expect((await ledger.book.summary(EVENT_ID)).committedXrp).toBe("0");
  });

  it("refuses from a treasury nobody has funded, saying what to send, and books nothing", async () => {
    const log: string[] = [];
    const ledger = new LoggedLedger(log);
    // What xrpl.js throws when it fills in a Payment from an account the
    // ledger has never seen.
    const neverFunded = Object.assign(new Error("Account not found."), {
      name: "RippledError",
      data: { error: "actNotFound", error_code: 19 },
    });
    const gw = emptyWallet(gateway()).onSubmit("Payment", () => {
      log.push("submit");
      return neverFunded;
    });

    const err = await payAllowance(gw, input(ledger)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AllowanceDeniedError);
    expect((err as AllowanceDeniedError).kind).toBe("unfunded");
    // 5 allowance + 1.2 to hold a badge + 0.01 buffer, and 1 more for the treasury to exist at all.
    expect((err as AllowanceDeniedError).details).toMatchObject({
      treasuryAddress: TREASURY.classicAddress,
      amountXrp: "6.21",
      neededXrp: "7.21",
      reason: "treasury_not_activated",
    });
    expect((err as AllowanceDeniedError).message).toContain(TREASURY.classicAddress);
    expect(log).toEqual(["find", "reserve", "submit", "release"]);
    expect(await ledger.book.find(EVENT_ID, ATTENDEE)).toBeNull();
  });

  it("says a treasury holding too little is short, rather than passing on the ledger's code", async () => {
    const log: string[] = [];
    const ledger = new LoggedLedger(log);
    const gw = emptyWallet(gateway()).onSubmit("Payment", () => {
      log.push("submit");
      return new TransactionFailedError("tecUNFUNDED_PAYMENT", "Payment failed with tecUNFUNDED_PAYMENT");
    });

    const err = await payAllowance(gw, input(ledger)).catch((e: unknown) => e);

    expect((err as AllowanceDeniedError).kind).toBe("unfunded");
    expect((err as AllowanceDeniedError).details).toMatchObject({ reason: "treasury_short", amountXrp: "6.21" });
    expect(log).toEqual(["find", "reserve", "submit", "release"]);
    expect(await ledger.book.find(EVENT_ID, ATTENDEE)).toBeNull();
  });

  it("KEEPS the booking when the payment's fate is unknown, so a retry cannot pay twice", async () => {
    const log: string[] = [];
    const ledger = new LoggedLedger(log);
    const gw = emptyWallet(gateway()).onSubmit("Payment", () => {
      log.push("submit");
      return new ConnectionError("Lost the XRPL connection and could not re-establish it (tried 2).");
    });

    await expect(payAllowance(gw, input(ledger))).rejects.toBeInstanceOf(ConnectionError);

    expect(log).toEqual(["find", "reserve", "submit"]);
    expect(await ledger.book.find(EVENT_ID, ATTENDEE)).toMatchObject({ status: "reserved" });

    // Pressed again straight away: refused while that payment may still land.
    const retry = await payAllowance(gw, input(ledger)).catch((e: unknown) => e);
    expect((retry as AllowanceDeniedError).kind).toBe("in_flight");
    expect(gw.submits).toHaveLength(1);
  });

  it("settles a stale booking from the treasury's history: found, it is recorded and not paid again", async () => {
    const t0 = new Date("2026-09-14T10:00:00.000Z");
    const ledger = new LoggedLedger([], new MemoryAllowanceLedger({ now: () => t0 }));
    const booked = await ledger.book.reserve({
      eventId: EVENT_ID,
      address: ATTENDEE,
      allowanceXrp: "5",
      topupXrp: "1.21",
      treasuryAddress: TREASURY.classicAddress,
      budgetXrp: "100",
    });
    const gw = gateway().onRequest("account_tx", {
      result: {
        transactions: [
          {
            hash: PAY_HASH,
            validated: true,
            meta: { TransactionResult: "tesSUCCESS" },
            tx_json: {
              TransactionType: "Payment",
              Account: TREASURY.classicAddress,
              Destination: ATTENDEE,
              Amount: "6210000",
              Memos: [memo(ALLOWANCE_MEMO_TYPE, `${EVENT_ID}:${booked?.id}`)],
            },
          },
        ],
      },
    });

    const result = await payAllowance(
      gw,
      input(ledger, { now: () => new Date(t0.getTime() + STALE_ALLOWANCE_MS + 1) }),
    );

    expect(result).toMatchObject({ outcome: "already_paid", txHash: PAY_HASH });
    expect(gw.submits).toHaveLength(0);
    expect(await ledger.book.find(EVENT_ID, ATTENDEE)).toMatchObject({ status: "confirmed", txHash: PAY_HASH });
    expect(gw.lastRequest("account_tx")?.account).toBe(TREASURY.classicAddress);
  });

  it("settles a stale booking that never landed by releasing it, then pays", async () => {
    const t0 = new Date("2026-09-14T10:00:00.000Z");
    const ledger = new LoggedLedger([], new MemoryAllowanceLedger({ now: () => t0 }));
    await ledger.book.reserve({
      eventId: EVENT_ID,
      address: ATTENDEE,
      allowanceXrp: "5",
      topupXrp: "1.21",
      treasuryAddress: TREASURY.classicAddress,
      budgetXrp: "100",
    });
    const gw = emptyWallet(gateway())
      .onRequest("account_tx", { result: { transactions: [] } })
      .onSubmit("Payment", { hash: PAY_HASH, ledgerIndex: 7 });

    const result = await payAllowance(
      gw,
      input(ledger, { now: () => new Date(t0.getTime() + STALE_ALLOWANCE_MS + 1) }),
    );

    expect(result).toMatchObject({ outcome: "paid", txHash: PAY_HASH });
    expect(gw.submits).toHaveLength(1);
  });

  it("CONCURRENCY: five presses for one attendee send ONE payment", async () => {
    const ledger = new LoggedLedger();
    const gw = emptyWallet(gateway()).onSubmit("Payment", { hash: PAY_HASH, ledgerIndex: 1 });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => payAllowance(gw, input(ledger))),
    );

    expect(gw.submits).toHaveLength(1);
    const outcomes = results.map((r) =>
      r.status === "fulfilled" ? r.value.outcome : (r.reason as AllowanceDeniedError).kind,
    );
    expect(outcomes.filter((o) => o === "paid")).toHaveLength(1);
    for (const o of outcomes) expect(["paid", "already_paid", "in_flight"]).toContain(o);
  });

  it("CONCURRENCY: twenty attendees against a budget for two send exactly two payments", async () => {
    const ledger = new LoggedLedger();
    let n = 0;
    const gw = emptyWallet(gateway()).onSubmit("Payment", () => {
      n += 1;
      return { hash: n.toString(16).toUpperCase().padStart(64, "0"), ledgerIndex: n };
    });
    const addresses = Array.from({ length: 20 }, () => Wallet.generate().classicAddress);

    const results = await Promise.allSettled(
      addresses.map((address) => payAllowance(gw, input(ledger, { address, budgetXrp: "12.42" }))),
    );

    expect(gw.submits).toHaveLength(2);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect(((r as PromiseRejectedResult).reason as AllowanceDeniedError).kind).toBe("budget");
    }
    expect((await ledger.book.summary(EVENT_ID)).committedXrp).toBe("12.42");
  });

  it("rejects an address that is not one before any round trip", async () => {
    const log: string[] = [];
    const gw = gateway();

    await expect(payAllowance(gw, input(new LoggedLedger(log), { address: "rNope" }))).rejects.toMatchObject({
      code: "INVALID_ADDRESS",
    });
    expect(log).toEqual([]);
    expect(gw.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("isAmbiguousSubmitFailure", () => {
  it("treats a result code as an answer and a dead connection as a question", () => {
    expect(isAmbiguousSubmitFailure(new TransactionFailedError("tecNO_DST", "no"))).toBe(false);
    expect(isAmbiguousSubmitFailure(new Error("Account not found."))).toBe(false);
    expect(isAmbiguousSubmitFailure(new ConnectionError("gone"))).toBe(true);
    expect(isAmbiguousSubmitFailure(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(true);
    expect(isAmbiguousSubmitFailure(Object.assign(new Error("x"), { name: "DisconnectedError" }))).toBe(true);
  });
});

describe("findAllowancePayment", () => {
  const wanted = { treasuryAddress: TREASURY.classicAddress, destination: ATTENDEE, eventId: EVENT_ID, reservationId: "42" };

  function entry(over: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
    return {
      hash: PAY_HASH.toLowerCase(),
      validated: true,
      meta: { TransactionResult: "tesSUCCESS" },
      ...over,
      tx_json: {
        TransactionType: "Payment",
        Account: TREASURY.classicAddress,
        Destination: ATTENDEE,
        Memos: [memo(ALLOWANCE_MEMO_TYPE, `${EVENT_ID}:42`)],
        ...body,
      },
    };
  }

  it("finds only a validated, successful Payment to that attendee carrying that booking's memo", async () => {
    const gw = gateway().onRequest("account_tx", {
      result: {
        transactions: [
          entry({ meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } }),
          entry({ validated: false }),
          entry({}, { Destination: OTHER }),
          entry({}, { Memos: [memo(ALLOWANCE_MEMO_TYPE, `${EVENT_ID}:43`)] }),
          entry({}, { TransactionType: "OfferCreate" }),
          entry(),
        ],
      },
    });

    await expect(findAllowancePayment(gw, wanted)).resolves.toEqual({ txHash: PAY_HASH });
  });

  it("finds nothing in a history without it, or in a treasury that never existed", async () => {
    const empty = gateway().onRequest("account_tx", { result: { transactions: [entry({}, { Memos: [] })] } });
    await expect(findAllowancePayment(empty, wanted)).resolves.toBeUndefined();

    const unfunded = gateway().onRequest("account_tx", rippledError("actNotFound"));
    await expect(findAllowancePayment(unfunded, wanted)).resolves.toBeUndefined();
  });

  it("turns any other ledger failure into a typed error", async () => {
    const gw = gateway().onRequest("account_tx", rippledError("tooBusy"));
    await expect(findAllowancePayment(gw, wanted)).rejects.toMatchObject({ code: "LEDGER_QUERY_FAILED" });
  });
});
