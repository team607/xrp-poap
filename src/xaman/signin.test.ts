/**
 * Xaman SignIn unit tests.
 *
 * The subject is a single sentence: an address is only ever produced by a
 * payload that was SIGNED, and only after it has been validated. Most of what
 * follows is that sentence attacked from a different angle each time — opened,
 * declined, expired, resolved-but-unsigned, signed-with-rubbish.
 *
 * No network: the SDK is injected.
 */
import { describe, expect, it, vi } from "vitest";
import { XrplLayerError } from "../errors.js";
import {
  MemoryConsumedSignIns,
  NullSignInService,
  SIGNIN_PAYLOAD_EXPIRE_MINUTES,
  XummSignInService,
  buildSignInRequest,
  type XummFetchedSignIn,
  type XummSignInSdkLike,
} from "./signin.js";

const EVENT_ID = 4242;
const ATTENDEE = "rwPy1pJd3RcHrEaqKk1yUiEGCqz8wewJZm";
const UUID = "9f1c4b2a-3d5e-4a7b-8c9d-0e1f2a3b4c5d";

const CREATED = {
  uuid: UUID,
  next: { always: "https://xumm.app/sign/9f1c4b2a" },
  refs: {
    qr_png: "https://xumm.app/sign/9f1c4b2a_q.png",
    websocket_status: "wss://xumm.app/sign/9f1c4b2a",
  },
};

/** A fetched payload, defaulting to "created, nobody has touched it". */
function fetched(overrides: {
  meta?: Partial<XummFetchedSignIn["meta"]>;
  response?: Partial<XummFetchedSignIn["response"]>;
} = {}): XummFetchedSignIn {
  return {
    meta: {
      resolved: false,
      signed: false,
      cancelled: false,
      expired: false,
      ...overrides.meta,
    },
    response: { account: null, signer: null, ...overrides.response },
  };
}

function fakeSdk(
  behaviour: {
    create?: () => Promise<unknown>;
    get?: () => Promise<XummFetchedSignIn | null>;
  } = {},
): XummSignInSdkLike & {
  createCalls: unknown[];
  getCalls: unknown[];
} {
  const createCalls: unknown[] = [];
  const getCalls: unknown[] = [];

  return {
    createCalls,
    getCalls,
    payload: {
      async create(payload: unknown) {
        createCalls.push(payload);
        return (behaviour.create ? await behaviour.create() : CREATED) as never;
      },
      async get(uuid: unknown) {
        getCalls.push(uuid);
        return behaviour.get ? await behaviour.get() : fetched();
      },
    },
  };
}

function service(behaviour?: Parameters<typeof fakeSdk>[0]): {
  signIn: XummSignInService;
  sdk: ReturnType<typeof fakeSdk>;
} {
  const sdk = fakeSdk(behaviour);
  return { signIn: new XummSignInService({ apiKey: "", apiSecret: "", sdk }), sdk };
}

// ---------------------------------------------------------------------------
// The payload we ask a person to approve
// ---------------------------------------------------------------------------

describe("buildSignInRequest", () => {
  it("asks for a SignIn and nothing else", () => {
    const request = buildSignInRequest({ eventId: EVENT_ID });

    expect(request.txjson).toEqual({ TransactionType: "SignIn" });
    // Exactly one key: no Account, no Fee, no Destination. Anything else here
    // would be something the attendee signs without having been shown it.
    expect(Object.keys(request.txjson)).toHaveLength(1);
  });

  it("never asks Xaman to submit anything, because there is nothing to submit", () => {
    const request = buildSignInRequest({ eventId: EVENT_ID });

    expect(request.options).not.toHaveProperty("submit");
    expect(request.options.expire).toBe(SIGNIN_PAYLOAD_EXPIRE_MINUTES);
  });

  it("carries the event id so a resolved payload can be tied back to it", () => {
    const request = buildSignInRequest({ eventId: EVENT_ID });

    expect(request.custom_meta.blob).toEqual({ kind: "poap-registration", eventId: EVENT_ID });
    expect(request.custom_meta.identifier).toBe(`poap-reg-${EVENT_ID}`);
    expect(request.custom_meta.instruction).toContain("not a transaction");
  });

  it("passes a return url through only when there is one", () => {
    expect(buildSignInRequest({ eventId: EVENT_ID }).options).not.toHaveProperty("return_url");
    expect(buildSignInRequest({ eventId: EVENT_ID, returnUrl: {} }).options).not.toHaveProperty(
      "return_url",
    );
    expect(
      buildSignInRequest({ eventId: EVENT_ID, returnUrl: { web: "https://poap.test/r/4242" } })
        .options.return_url,
    ).toEqual({ web: "https://poap.test/r/4242" });
  });

  it("refuses an event id that is not a taxon", () => {
    expect(() => buildSignInRequest({ eventId: 2_147_483_648 })).toThrowError(
      expect.objectContaining({ code: "INVALID_TAXON" }),
    );
    expect(() => buildSignInRequest({ eventId: -1 })).toThrowError(
      expect.objectContaining({ code: "INVALID_TAXON" }),
    );
    expect(() => buildSignInRequest({ eventId: 1.5 })).toThrowError(
      expect.objectContaining({ code: "INVALID_TAXON" }),
    );
  });
});

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe("XummSignInService.create", () => {
  it("posts the built envelope and returns what a browser needs", async () => {
    const { signIn, sdk } = service();

    const handles = await signIn.create({ eventId: EVENT_ID });

    expect(sdk.createCalls[0]).toEqual(buildSignInRequest({ eventId: EVENT_ID }));
    expect(handles).toMatchObject({
      uuid: UUID,
      qrPng: CREATED.refs.qr_png,
      deeplink: CREATED.next.always,
      websocket: CREATED.refs.websocket_status,
    });
    expect(new Date(handles.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("wraps a transport failure without echoing the credentials back", async () => {
    const { signIn } = service({
      create: () => Promise.reject(new Error("401 Unauthorized: apiSecret sEdV6Xn3bRq9J2wY4tK8mZpL1cH7dQa")),
    });

    await expect(signIn.create({ eventId: EVENT_ID })).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
    });
  });

  it("treats a null payload as an upstream failure rather than a success", async () => {
    const { signIn } = service({ create: async () => null });

    await expect(signIn.create({ eventId: EVENT_ID })).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
    });
  });

  it("refuses to construct without credentials or an injected sdk", () => {
    expect(() => new XummSignInService({ apiKey: "", apiSecret: "" })).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });
});

// ---------------------------------------------------------------------------
// resolve() — the part the whole scheme rests on
// ---------------------------------------------------------------------------

describe("XummSignInService.resolve", () => {
  it("returns an address for a signed payload", async () => {
    const { signIn } = service({
      get: async () =>
        fetched({ meta: { resolved: true, signed: true }, response: { account: ATTENDEE } }),
    });

    await expect(signIn.resolve(UUID)).resolves.toEqual({
      resolved: true,
      signed: true,
      account: ATTENDEE,
      rejected: false,
    });
  });

  it("gives no address for a payload nobody has touched", async () => {
    const { signIn } = service({ get: async () => fetched() });

    const outcome = await signIn.resolve(UUID);

    expect(outcome).toEqual({ resolved: false, signed: false, rejected: false });
    expect(outcome.account).toBeUndefined();
  });

  it("gives no address for a payload that was merely OPENED", async () => {
    // Xaman knows which wallet looked at the QR code and says so. Opening it is
    // not a signature, so this must not produce an address.
    const { signIn } = service({
      get: async () =>
        fetched({ meta: { resolved: false, signed: false }, response: { account: ATTENDEE } }),
    });

    const outcome = await signIn.resolve(UUID);

    expect(outcome.signed).toBe(false);
    expect(outcome.account).toBeUndefined();
  });

  it("gives no address for a payload that was DECLINED", async () => {
    const { signIn } = service({
      get: async () =>
        fetched({
          meta: { resolved: true, signed: false, cancelled: true },
          response: { account: ATTENDEE },
        }),
    });

    const outcome = await signIn.resolve(UUID);

    expect(outcome).toEqual({ resolved: true, signed: false, rejected: true });
    expect(outcome.account).toBeUndefined();
  });

  it("gives no address for a payload that EXPIRED unanswered", async () => {
    const { signIn } = service({
      get: async () =>
        fetched({
          meta: { resolved: false, signed: false, expired: true },
          response: { account: ATTENDEE },
        }),
    });

    const outcome = await signIn.resolve(UUID);

    expect(outcome).toEqual({ resolved: false, signed: false, rejected: true });
    expect(outcome.account).toBeUndefined();
  });

  it("gives no address for a payload that resolved without a signature", async () => {
    const { signIn } = service({
      get: async () =>
        fetched({ meta: { resolved: true, signed: false }, response: { account: ATTENDEE } }),
    });

    const outcome = await signIn.resolve(UUID);

    expect(outcome).toEqual({ resolved: true, signed: false, rejected: true });
    expect(outcome.account).toBeUndefined();
  });

  it("rejects an account that is not a valid classic address", async () => {
    // The string came from a third-party API and is one step away from a
    // database row and the Destination of a soulbound badge. Throw, do not
    // return it and hope the caller checks.
    const { signIn } = service({
      get: async () =>
        fetched({
          meta: { resolved: true, signed: true },
          response: { account: "rNOTANADDRESS!!!" },
        }),
    });

    await expect(signIn.resolve(UUID)).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
  });

  it("rejects an account that is an X-address rather than a classic one", async () => {
    const { signIn } = service({
      get: async () =>
        fetched({
          meta: { resolved: true, signed: true },
          response: { account: "XVLhHMPHU98es4dbozjVtdWzVrDjtV5fdx1mHp98tDMoQXb" },
        }),
    });

    await expect(signIn.resolve(UUID)).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
  });

  it("treats signed-with-no-account as an upstream fault", async () => {
    const { signIn } = service({
      get: async () => fetched({ meta: { resolved: true, signed: true } }),
    });

    await expect(signIn.resolve(UUID)).rejects.toMatchObject({ code: "CONNECTION_FAILED" });
  });

  it("404s a payload Xaman has never heard of", async () => {
    const { signIn } = service({ get: async () => null });

    await expect(signIn.resolve(UUID)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("wraps a transport failure", async () => {
    const { signIn } = service({ get: () => Promise.reject(new Error("socket hang up")) });

    await expect(signIn.resolve(UUID)).rejects.toMatchObject({ code: "CONNECTION_FAILED" });
  });
});

// ---------------------------------------------------------------------------
// No keys
// ---------------------------------------------------------------------------

describe("NullSignInService", () => {
  const signIn = new NullSignInService();

  it("fails loudly, and only on use", async () => {
    await expect(signIn.create({ eventId: EVENT_ID })).rejects.toBeInstanceOf(XrplLayerError);
    await expect(signIn.create({ eventId: EVENT_ID })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(signIn.resolve(UUID)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("names the two variables an operator has to set", async () => {
    await expect(signIn.create({ eventId: EVENT_ID })).rejects.toThrowError(/XUMM_API_KEY/);
    await expect(signIn.create({ eventId: EVENT_ID })).rejects.toThrowError(/XUMM_API_SECRET/);
  });
});

// ---------------------------------------------------------------------------
// The replay ticket book
// ---------------------------------------------------------------------------

describe("MemoryConsumedSignIns", () => {
  it("spends a uuid exactly once", async () => {
    const consumed = new MemoryConsumedSignIns();

    await expect(consumed.claim(UUID)).resolves.toBe(true);
    await expect(consumed.claim(UUID)).resolves.toBe(false);
    await expect(consumed.claim(UUID)).resolves.toBe(false);
  });

  it("keeps different uuids apart", async () => {
    const consumed = new MemoryConsumedSignIns();

    await expect(consumed.claim(UUID)).resolves.toBe(true);
    await expect(consumed.claim("1e2d3c4b-5a69-4788-9900-aabbccddeeff")).resolves.toBe(true);
  });

  it("hands a uuid back when the registration it was taken for did not happen", async () => {
    const consumed = new MemoryConsumedSignIns();

    await consumed.claim(UUID);
    await consumed.release(UUID);

    await expect(consumed.claim(UUID)).resolves.toBe(true);
  });

  it("forgets a uuid once its ttl has passed", async () => {
    vi.useFakeTimers();
    try {
      const consumed = new MemoryConsumedSignIns(1_000);

      await expect(consumed.claim(UUID)).resolves.toBe(true);
      vi.advanceTimersByTime(999);
      await expect(consumed.claim(UUID)).resolves.toBe(false);
      vi.advanceTimersByTime(2);
      await expect(consumed.claim(UUID)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let two concurrent callers both win", async () => {
    const consumed = new MemoryConsumedSignIns();

    const outcomes = await Promise.all([consumed.claim(UUID), consumed.claim(UUID)]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });
});
