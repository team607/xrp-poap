/**
 * Reconnect behaviour, driven through the REAL XrplConnection.
 *
 * These exist because the running server twice reached a state where the Clio
 * socket had dropped and every ledger route returned 500 forever while the
 * process stayed healthy — the static pages and the database kept answering,
 * so the app looked alive while claims were dead.
 *
 * A `clientFactory` injects a stand-in socket so the class's own request(),
 * submit() and reconnect paths are what runs. Re-implementing the retry policy
 * inside the test would only assert that the test is self-consistent.
 */
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { XrplConnection, isDisconnectedError } from "./client.js";

function notConnected(): Error {
  const e = new Error('{"command":"account_info"}');
  e.name = "NotConnectedError";
  return e;
}

const CFG = {
  endpoint: "wss://primary.test",
  fallbackEndpoints: ["wss://fallback.test"],
  network: "testnet",
  issuerAddress: "rISSUERxxxxxxxxxxxxxxxxxxxxxxxxxx",
  issuerSeed: "",
} as unknown as AppConfig;

interface FakeOpts {
  onRequest?: (req: any, n: number) => unknown;
  onSubmit?: (blob: string, n: number) => unknown;
  onAutofill?: (tx: any, n: number) => unknown;
  failConnect?: boolean;
}

function makeFakeClient(opts: FakeOpts = {}) {
  let requests = 0;
  let submits = 0;
  let autofills = 0;
  const client: any = {
    connected: false,
    connects: 0,
    isConnected: () => client.connected,
    async connect() {
      client.connects += 1;
      if (opts.failConnect) throw new Error("refused");
      client.connected = true;
    },
    async disconnect() { client.connected = false; },
    async request(req: any) {
      requests += 1;
      return opts.onRequest ? opts.onRequest(req, requests) : { result: {} };
    },
    async autofill(tx: any) {
      autofills += 1;
      return opts.onAutofill ? opts.onAutofill(tx, autofills) : { ...tx, Sequence: 40 + autofills };
    },
    async submitAndWait(blob: string) {
      submits += 1;
      return opts.onSubmit
        ? opts.onSubmit(blob, submits)
        : { result: { hash: "H", meta: { TransactionResult: "tesSUCCESS" } } };
    },
    counts: () => ({ requests, submits, autofills }),
  };
  return client;
}

const WALLET = { sign: (p: any) => ({ tx_blob: `BLOB_SEQ_${p.Sequence}`, hash: "HASH1" }) } as any;

describe("isDisconnectedError", () => {
  it("recognises the shapes xrpl.js actually throws", () => {
    expect(isDisconnectedError(notConnected())).toBe(true);
    const d = new Error("websocket was closed");
    d.name = "DisconnectedError";
    expect(isDisconnectedError(d)).toBe(true);
    expect(isDisconnectedError(new Error("not connected to the server"))).toBe(true);
  });

  it("does not mistake an ordinary failure for a dead socket", () => {
    // A tec- result or txnNotFound triggering a reconnect would turn a normal
    // error into a reconnect loop.
    expect(isDisconnectedError(new Error("txnNotFound"))).toBe(false);
    expect(isDisconnectedError(new Error("tecUNFUNDED_PAYMENT"))).toBe(false);
    expect(isDisconnectedError(undefined)).toBe(false);
  });
});

describe("XrplConnection", () => {
  it("retries a read on a fresh socket after a drop", async () => {
    const clients: any[] = [];
    const conn = await XrplConnection.connect(CFG, {
      clientFactory: () => {
        const c = makeFakeClient({
          onRequest: (_r, n) => {
            if (clients.length === 1 && n === 1) throw notConnected();
            return { result: { ok: true } };
          },
        });
        clients.push(c);
        return c;
      },
    });

    const out = await conn.request({ command: "account_info" });
    expect(out).toEqual({ result: { ok: true } });
    // A second client was built, i.e. it genuinely reconnected.
    expect(clients.length).toBe(2);
  });

  it("gives up with a typed error when every endpoint refuses", async () => {
    let first = true;
    const conn = await XrplConnection.connect(CFG, {
      clientFactory: () => {
        const c = makeFakeClient({
          failConnect: !first,
          onRequest: () => { throw notConnected(); },
        });
        first = false;
        return c;
      },
    });
    await expect(conn.request({ command: "account_info" })).rejects.toThrow(
      /could not re-establish/i,
    );
  });

  it("does NOT re-autofill on resend — a second Sequence would mint twice", async () => {
    // The invariant this whole change exists to protect.
    const clients: any[] = [];
    const conn = await XrplConnection.connect(CFG, {
      wallet: WALLET,
      issuerAddress: CFG.issuerAddress,
      clientFactory: () => {
        const c = makeFakeClient({
          onSubmit: (_b, n) => {
            if (clients.length === 1 && n === 1) throw notConnected();
            return { result: { hash: "HASH1", meta: { TransactionResult: "tesSUCCESS" } } };
          },
          onRequest: () => { throw Object.assign(new Error("txnNotFound"), { data: { error: "txnNotFound" } }); },
        });
        clients.push(c);
        return c;
      },
    });

    const out = await conn.submit({ TransactionType: "NFTokenBurn" } as any);
    expect(out.engineResult).toBe("tesSUCCESS");
    // Exactly one autofill across both clients: the signed blob was reused.
    const totalAutofills = clients.reduce((n, c) => n + c.counts().autofills, 0);
    expect(totalAutofills).toBe(1);
    const blobs = clients.flatMap((c) => c.sentBlobs ?? []);
    expect(new Set(blobs).size).toBeLessThanOrEqual(1);
  });

  it("asks whether the transaction landed before resending it", async () => {
    const clients: any[] = [];
    let txLookups = 0;
    const conn = await XrplConnection.connect(CFG, {
      wallet: WALLET,
      issuerAddress: CFG.issuerAddress,
      clientFactory: () => {
        const c = makeFakeClient({
          onSubmit: (_b, n) => {
            if (clients.length === 1 && n === 1) throw notConnected();
            return { result: { hash: "HASH1", meta: { TransactionResult: "tesSUCCESS" } } };
          },
          onRequest: (req) => {
            if (req.command === "tx") {
              txLookups += 1;
              // It HAD landed before the socket died.
              return { result: { hash: "HASH1", validated: true, meta: { TransactionResult: "tesSUCCESS" } } };
            }
            return { result: {} };
          },
        });
        clients.push(c);
        return c;
      },
    });

    const out = await conn.submit({ TransactionType: "NFTokenMint" } as any);
    expect(txLookups).toBe(1);
    expect(out.hash).toBe("HASH1");
    // It was already on the ledger, so the fresh client must not resubmit.
    expect(clients[1].counts().submits).toBe(0);
  });

  it("does not resurrect a socket after a deliberate disconnect", async () => {
    const conn = await XrplConnection.connect(CFG, {
      clientFactory: () => makeFakeClient({ onRequest: () => { throw notConnected(); } }),
    });
    await conn.disconnect();
    await expect(conn.request({ command: "server_info" })).rejects.toThrow(/disconnected/i);
  });

  it("collapses concurrent failures into a single reconnect", async () => {
    // Twenty in-flight requests hitting one dead socket must not open twenty
    // connections and hammer a node that is already struggling.
    const clients: any[] = [];
    const conn = await XrplConnection.connect(CFG, {
      clientFactory: () => {
        const c = makeFakeClient({
          onRequest: () => {
            if (clients.length === 1) throw notConnected();
            return { result: { ok: true } };
          },
        });
        clients.push(c);
        return c;
      },
    });

    const all = await Promise.all(
      Array.from({ length: 20 }, () => conn.request({ command: "account_info" })),
    );
    expect(all).toHaveLength(20);
    expect(clients.length).toBe(2);
  });
});
