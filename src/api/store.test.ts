/**
 * The store end to end: the organiser's price list, an attendee ordering from
 * their pass, the ledger deciding what was paid, and the vendor's screen.
 *
 * Real stores and the real ledger operations against a MockGateway; fakes only
 * for Xaman, which is somebody else's server, and for the admin session, which
 * src/api/auth.test.ts owns.
 */
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "xrpl";
import type { ZodType } from "zod";
import { MockGateway, rippledError } from "../../test/helpers/mock-gateway.js";
import type { AppConfig } from "../config.js";
import { createMemoryStores, type MemoryStores } from "../db/memory.js";
import { ConnectionError } from "../errors.js";
import type { EventStatus } from "../types.js";
import type { XamanPayloadStatus, XamanService } from "../xaman/client.js";
import type { PurchaseSignRequestParams } from "../xaman/payloads.js";
import type { SignInResolution, SignInService } from "../xaman/signin.js";
import { readAccount } from "../xrpl/account.js";
import { memo, PURCHASE_MEMO_TYPE } from "../xrpl/memos.js";
import { findPurchasePayment, verifyPurchasePayment } from "../xrpl/purchase.js";
import type { ApiDeps } from "./deps.js";
import { registerErrorHandler } from "./http-errors.js";
import type { AdminGuard } from "./routes/events.js";
import { registerStoreRoutes } from "./routes/store.js";
import { registerVendorPortalRoutes } from "./routes/vendor-portal.js";
import { registerVendorRoutes } from "./routes/vendors.js";
import { registerXamanWebhookRoute } from "./routes/xaman-webhook.js";

const ISSUER = "rBdhYBA2uaVYG7ia2yusmPu5qMS4hE6oQ";
const ATTENDEE = "rPeZcWESwr1Wy64tw6JdVqtKNjhuUzHK2i";
const STRANGER = "rwPy1pJd3RcHrEaqKk1yUiEGCqz8wewJZm";
const DOMINOS = "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w";
const ADIDAS = "ra6pcMuGFgwSefKt4GPy6UCeEXkn2KtaNS";
const EVENT = 700012;
const TAG = 2607210007;
const ADMIN_HEADER = "x-test-admin";
const asAdmin = { [ADMIN_HEADER]: "yes" };

/** lsfRequireDestTag and lsfDepositAuth. */
const REQUIRE_DEST_TAG = 0x00020000;
const DEPOSIT_AUTH = 0x01000000;

function testConfig(): AppConfig {
  return {
    endpoint: "wss://clio.altnet.rippletest.net:51233",
    fallbackEndpoints: [],
    network: "testnet",
    issuerAddress: ISSUER,
    issuerSeed: "sEdV6Xn3bRq9J2wY4tK8mZpL1cH7dQa",
    reward: { maxPerAttendeeXrp: "10", feeBufferXrp: "0.01" },
    pinata: { gateway: "https://gateway.pinata.cloud" },
    xumm: { apiKey: "test-key", apiSecret: "test-secret" },
    sourceTag: TAG,
    demoEnabled: false,
    badgeImageUriMode: "https" as const,
    badgeMetadataUriMode: "https" as const,
    admin: { sessionTtlHours: 12 },
    api: { port: 0, host: "127.0.0.1", trustProxy: false, secureCookies: false },
  };
}

const fakeRequireAdmin: AdminGuard = (request: FastifyRequest, reply: FastifyReply) => {
  if (request.headers[ADMIN_HEADER] === "yes") return undefined;
  return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Not signed in." } });
};

interface Harness {
  app: FastifyInstance;
  stores: MemoryStores;
  gateway: MockGateway;
  /** account_info by address, in drops. Absent: the account does not exist. */
  accounts: Map<string, { Balance: string; OwnerCount?: number; Flags?: number }>;
  /** tx by hash. */
  transactions: Map<string, unknown>;
  /** account_tx by account. */
  histories: Map<string, unknown[]>;
  payloads: Map<string, XamanPayloadStatus>;
  purchaseRequests: PurchaseSignRequestParams[];
  signIns: Map<string, SignInResolution>;
  xaman: { failNext: boolean };
}

async function harness(options: { status?: EventStatus } = {}): Promise<Harness> {
  const stores = createMemoryStores();
  await stores.events.create({ eventId: EVENT, name: "Ledger Days", status: options.status ?? "live" });

  const accounts = new Map<string, { Balance: string; OwnerCount?: number; Flags?: number }>([
    [DOMINOS, { Balance: "50000000" }],
    [ADIDAS, { Balance: "50000000" }],
    // An attendee holding their badge, with 10.01 XRP to spend.
    [ATTENDEE, { Balance: "11210000", OwnerCount: 1 }],
    [STRANGER, { Balance: "90000000" }],
  ]);
  const transactions = new Map<string, unknown>();
  const histories = new Map<string, unknown[]>();

  const gateway = new MockGateway({ issuerAddress: ISSUER })
    .onRequest("account_info", (payload: Record<string, unknown>) => {
      const data = accounts.get(String(payload.account));
      return data ? { result: { account_data: data } } : rippledError("actNotFound");
    })
    .onRequest("tx", (payload: Record<string, unknown>) => transactions.get(String(payload.transaction)) ?? rippledError("txnNotFound"))
    .onRequest("account_tx", (payload: Record<string, unknown>) => ({
      result: { transactions: histories.get(String(payload.account)) ?? [] },
    }));

  const payloads = new Map<string, XamanPayloadStatus>();
  const purchaseRequests: PurchaseSignRequestParams[] = [];
  const xamanControl = { failNext: false };
  const xaman: XamanService = {
    async createClaimRequest() {
      throw new Error("claims are not part of the store");
    },
    async createPurchaseRequest(params) {
      if (xamanControl.failNext) {
        xamanControl.failNext = false;
        throw new ConnectionError("Xaman rejected the payment request");
      }
      purchaseRequests.push(params);
      const uuid = randomUUID();
      payloads.set(uuid, { resolved: false, signed: false });
      return {
        uuid,
        qrPng: `https://xumm.app/sign/${uuid}_q.png`,
        deeplink: `https://xumm.app/sign/${uuid}`,
        websocket: `wss://xumm.app/sign/${uuid}`,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
    },
    async getPayload(uuid) {
      return payloads.get(uuid) ?? { resolved: false, signed: false };
    },
  };

  const signIns = new Map<string, SignInResolution>();
  const signIn: SignInService = {
    async create() {
      return {
        uuid: randomUUID(),
        qrPng: "https://xumm.app/sign/q.png",
        deeplink: "https://xumm.app/sign/x",
        websocket: "wss://xumm.app/sign/x",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    },
    async resolve(uuid) {
      return signIns.get(uuid) ?? { resolved: false, signed: false, rejected: false };
    },
  };

  const deps = {
    config: testConfig(),
    gateway,
    attendance: stores.attendance,
    events: stores.events,
    allowances: stores.allowances,
    vendors: stores.vendors,
    purchases: stores.purchases,
    vendorSessions: stores.vendorSessions,
    chain: { readAccount, verifyPurchasePayment, findPurchasePayment },
    xaman,
    signIn,
    requireAdmin: fakeRequireAdmin,
    rateLimit: { enabled: false },
  } as unknown as ApiDeps;

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(({ schema }) => (data) => {
    const result = (schema as ZodType).safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  });
  registerErrorHandler(app);
  registerVendorRoutes(app, deps);
  registerStoreRoutes(app, deps);
  registerVendorPortalRoutes(app, deps);
  registerXamanWebhookRoute(app, deps);

  return {
    app,
    stores,
    gateway,
    accounts,
    transactions,
    histories,
    payloads,
    purchaseRequests,
    signIns,
    xaman: xamanControl,
  };
}

/** A badge holder at EVENT. */
async function attendee(h: Harness, address = ATTENDEE): Promise<void> {
  await h.stores.attendance.insert({
    eventId: EVENT,
    address,
    nftokenId: randomUUID().replace(/-/g, "").padEnd(64, "0").toUpperCase(),
    txHash: randomUUID().replace(/-/g, "").padEnd(64, "1").toUpperCase(),
    ledgerIndex: 1_000,
  });
}

async function stall(h: Harness, item: { priceXrp?: string; stock?: number | null } = {}) {
  const vendor = await h.stores.vendors.createVendor({ eventId: EVENT, name: "Dominos", walletAddress: DOMINOS });
  const bread = await h.stores.vendors.createItem({
    vendorId: vendor.id,
    name: "Garlic bread",
    priceXrp: item.priceXrp ?? "1.5",
    stock: item.stock ?? null,
  });
  return { vendor, bread };
}

function buy(h: Harness, body: Record<string, unknown>) {
  return h.app.inject({ method: "POST", url: `/api/events/${EVENT}/purchases`, payload: body });
}

/** What the ledger holds once a buyer has paid for an order, in the tx shape Clio answers with. */
function paidOnLedger(
  h: Harness,
  order: { id: string; amountXrp: string },
  over: { from?: string; to?: string; drops?: string; delivered?: string } = {},
): string {
  const hash = randomUUID().replace(/-/g, "").padEnd(64, "A").toUpperCase();
  const drops = over.drops ?? String(Math.round(Number(order.amountXrp) * 1_000_000));
  h.transactions.set(hash, {
    result: {
      hash,
      ledger_index: 99_000_000,
      validated: true,
      tx_json: {
        TransactionType: "Payment",
        Account: over.from ?? ATTENDEE,
        Destination: over.to ?? DOMINOS,
        Amount: drops,
        SourceTag: TAG,
        Memos: [memo(PURCHASE_MEMO_TYPE, order.id)],
      },
      meta: { TransactionResult: "tesSUCCESS", delivered_amount: over.delivered ?? drops },
    },
  });
  return hash;
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The organiser's price list
// ---------------------------------------------------------------------------

describe("organiser: vendors and items", () => {
  const addVendor = (h: Harness, body: Record<string, unknown>) =>
    h.app.inject({ method: "POST", url: `/admin/api/events/${EVENT}/vendors`, headers: asAdmin, payload: body });

  it("adds a vendor with any wallet the ledger would pay into, a brand-new one included", async () => {
    const h = await harness();
    const fresh = Wallet.generate().classicAddress;
    h.accounts.set(ADIDAS, { Balance: "50000000", Flags: REQUIRE_DEST_TAG });
    h.accounts.set(STRANGER, { Balance: "50000000", Flags: DEPOSIT_AUTH });

    const refusals = [
      [ADIDAS, "requires_destination_tag"],
      [STRANGER, "deposit_auth"],
    ] as const;
    for (const [walletAddress, reason] of refusals) {
      const res = await addVendor(h, { name: "Nope", walletAddress });
      expect(res.statusCode, reason).toBe(409);
      expect(res.json().error.details.reason, reason).toBe(reason);
    }
    expect((await addVendor(h, { name: "Issuer", walletAddress: ISSUER })).statusCode).toBe(409);

    const ok = await addVendor(h, { name: "Dominos", walletAddress: DOMINOS });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().vendor).toMatchObject({ name: "Dominos", walletAddress: DOMINOS, active: true, items: [] });

    // A vendor only receives. A wallet the ledger has never seen is created by
    // its first payment, so it is not a reason to turn the vendor away.
    const brandNew = await addVendor(h, { name: "Pop-up", walletAddress: fresh });
    expect(brandNew.statusCode).toBe(201);
    expect(await h.stores.vendors.listVendors(EVENT)).toHaveLength(2);
  });

  it("adds items, changes price and stock, hides them, and lists what is left", async () => {
    const h = await harness();
    const { vendor } = await stall(h);

    const added = await h.app.inject({
      method: "POST",
      url: `/admin/api/vendors/${vendor.id}/items`,
      headers: asAdmin,
      payload: { name: "Margherita", priceXrp: "4.5", stock: 10 },
    });
    expect(added.statusCode).toBe(201);
    const pizza = added.json().item;
    expect(pizza).toMatchObject({ name: "Margherita", priceXrp: "4.5", stock: 10, taken: 0, remaining: 10 });

    for (const payload of [{ priceXrp: "0" }, { priceXrp: "1e2" }, { stock: -1 }, {}]) {
      const res = await h.app.inject({ method: "PATCH", url: `/admin/api/items/${pizza.id}`, headers: asAdmin, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }

    const edited = await h.app.inject({
      method: "PATCH",
      url: `/admin/api/items/${pizza.id}`,
      headers: asAdmin,
      payload: { priceXrp: "5", stock: null, active: false },
    });
    expect(edited.json().item).toMatchObject({ priceXrp: "5", stock: null, remaining: null, active: false });

    const listed = await h.app.inject({ method: "GET", url: `/admin/api/events/${EVENT}/vendors`, headers: asAdmin });
    expect(listed.json().vendors[0].items.map((i: { name: string }) => i.name)).toEqual(["Garlic bread", "Margherita"]);
  });

  it("will not delete a vendor or an item somebody has ordered", async () => {
    const h = await harness();
    await attendee(h);
    const { vendor, bread } = await stall(h);
    expect((await buy(h, { address: ATTENDEE, itemId: bread.id })).statusCode).toBe(201);

    const item = await h.app.inject({ method: "DELETE", url: `/admin/api/items/${bread.id}`, headers: asAdmin });
    const counter = await h.app.inject({ method: "DELETE", url: `/admin/api/vendors/${vendor.id}`, headers: asAdmin });

    expect(item.statusCode).toBe(409);
    expect(counter.statusCode).toBe(409);
    expect(counter.json().error.message).toMatch(/Hide it instead/);
  });

  it("turns everybody without a session away", async () => {
    const h = await harness();
    const { vendor, bread } = await stall(h);
    for (const [method, url] of [
      ["GET", `/admin/api/events/${EVENT}/vendors`],
      ["DELETE", `/admin/api/vendors/${vendor.id}`],
      ["DELETE", `/admin/api/items/${bread.id}`],
      ["GET", "/admin/api/purchases"],
      ["GET", "/admin/api/sales"],
    ] as const) {
      expect((await h.app.inject({ method, url })).statusCode, url).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// The attendee's store
// ---------------------------------------------------------------------------

describe("attendee: the store", () => {
  it("shows only what is on sale, never a vendor's wallet, and says whether it is open", async () => {
    const h = await harness();
    const { vendor } = await stall(h, { stock: 2 });
    const hidden = await h.stores.vendors.createItem({ vendorId: vendor.id, name: "Old stock", priceXrp: "1" });
    await h.stores.vendors.updateItem(hidden.id, { active: false });
    const closedStall = await h.stores.vendors.createVendor({ eventId: EVENT, name: "Adidas", walletAddress: ADIDAS });
    await h.stores.vendors.createItem({ vendorId: closedStall.id, name: "Bottle", priceXrp: "3" });
    await h.stores.vendors.updateVendor(closedStall.id, { active: false });

    const res = await h.app.inject({ method: "GET", url: `/api/events/${EVENT}/store` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ open: true, name: "Ledger Days" });
    expect(res.json().vendors).toEqual([
      {
        id: vendor.id,
        name: "Dominos",
        items: [{ id: expect.any(String), name: "Garlic bread", priceXrp: "1.5", remaining: 2, soldOut: false }],
      },
    ]);
    expect(res.body).not.toContain(DOMINOS);
  });

  it("hides a draft event's store, and shows a closed one as closed", async () => {
    const draft = await harness({ status: "draft" });
    expect((await draft.app.inject({ method: "GET", url: `/api/events/${EVENT}/store` })).statusCode).toBe(404);

    const closed = await harness({ status: "closed" });
    expect((await closed.app.inject({ method: "GET", url: `/api/events/${EVENT}/store` })).json().open).toBe(false);
  });

  it("places an order for an attendee and hands back the Payment to approve, holding the stock", async () => {
    const h = await harness();
    await attendee(h);
    const { vendor, bread } = await stall(h, { priceXrp: "1.5", stock: 5 });

    const res = await buy(h, { address: ATTENDEE, itemId: bread.id, quantity: 3 });

    expect(res.statusCode).toBe(201);
    expect(res.json().purchase).toMatchObject({
      vendorId: vendor.id,
      itemName: "Garlic bread",
      quantity: 3,
      unitPriceXrp: "1.5",
      amountXrp: "4.5",
      status: "reserved",
      buyerAddress: ATTENDEE,
    });
    expect(res.json().xaman.uuid).toBeTruthy();
    // The payload Xaman was asked for: the vendor's wallet, the whole amount, our tag.
    expect(h.purchaseRequests[0]).toMatchObject({
      buyerAddress: ATTENDEE,
      vendorAddress: DOMINOS,
      amountDrops: "4500000",
      sourceTag: TAG,
      quantity: 3,
    });
    expect(await h.stores.purchases.unitsTaken(EVENT)).toEqual({ [bread.id]: 3 });
    expect(res.body).not.toContain("xamanUuid");
  });

  it("turns away a wallet that is not at the event", async () => {
    const h = await harness();
    const { bread } = await stall(h);

    const res = await buy(h, { address: STRANGER, itemId: bread.id });

    expect(res.statusCode).toBe(403);
    expect(h.purchaseRequests).toHaveLength(0);
  });

  it("refuses what the wallet cannot cover, before anybody is sent to Xaman", async () => {
    const h = await harness();
    await attendee(h);
    const { bread } = await stall(h, { priceXrp: "5" });

    const res = await buy(h, { address: ATTENDEE, itemId: bread.id, quantity: 3 });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({ reason: "insufficient", amountXrp: "15", spendableXrp: "10.01" });
    expect(h.purchaseRequests).toHaveLength(0);
    expect(await h.stores.purchases.count()).toBe(0);
  });

  it("takes only a first payment the ledger will deliver to a vendor wallet that does not exist yet", async () => {
    const h = await harness();
    await attendee(h);
    const fresh = Wallet.generate().classicAddress;
    const popup = await h.stores.vendors.createVendor({ eventId: EVENT, name: "Pop-up", walletAddress: fresh });
    const tea = await h.stores.vendors.createItem({ vendorId: popup.id, name: "Tea", priceXrp: "0.5", stock: null });

    // Half an XRP to a wallet with no account: the ledger would refuse it
    // after the buyer signed, so it never reaches Xaman.
    const small = await buy(h, { address: ATTENDEE, itemId: tea.id, quantity: 1 });
    expect(small.statusCode).toBe(409);
    expect(small.json().error.details).toMatchObject({ reason: "vendor_not_activated", minimumXrp: "1", amountXrp: "0.5" });
    expect(small.json().error.message).toContain("Pop-up");
    expect(h.purchaseRequests).toHaveLength(0);
    expect(await h.stores.purchases.count()).toBe(0);

    // One XRP or more creates the account, so it goes through.
    expect((await buy(h, { address: ATTENDEE, itemId: tea.id, quantity: 2 })).statusCode).toBe(201);

    // Once the wallet exists, any amount does.
    h.accounts.set(fresh, { Balance: "1000000" });
    expect((await buy(h, { address: ATTENDEE, itemId: tea.id, quantity: 1 })).statusCode).toBe(201);
    expect(h.purchaseRequests.map((r) => r.amountDrops)).toEqual(["1000000", "500000"]);
  });

  it("refuses outside a live event, past the stock, and past the quantity limit", async () => {
    const open = await harness({ status: "open" });
    await attendee(open);
    const early = await stall(open);
    expect((await buy(open, { address: ATTENDEE, itemId: early.bread.id })).statusCode).toBe(409);

    const h = await harness();
    await attendee(h);
    const { bread } = await stall(h, { stock: 1, priceXrp: "0.5" });
    const soldOut = await buy(h, { address: ATTENDEE, itemId: bread.id, quantity: 2 });
    expect(soldOut.statusCode).toBe(409);
    expect(soldOut.json().error.details).toMatchObject({ reason: "sold_out", remaining: 1 });
    expect((await buy(h, { address: ATTENDEE, itemId: bread.id, quantity: 21 })).statusCode).toBe(400);
  });

  it("gives the stock straight back when Xaman cannot be reached", async () => {
    const h = await harness();
    await attendee(h);
    const { bread } = await stall(h, { stock: 1 });
    h.xaman.failNext = true;

    const res = await buy(h, { address: ATTENDEE, itemId: bread.id });

    expect(res.statusCode).toBe(502);
    expect(await h.stores.purchases.unitsTaken(EVENT)).toEqual({});
    expect((await h.stores.purchases.list())[0]?.status).toBe("expired");
  });

  it("marks an order paid only when the ledger shows exactly that payment", async () => {
    const h = await harness();
    await attendee(h);
    const { bread } = await stall(h, { priceXrp: "1.5" });
    const placed = (await buy(h, { address: ATTENDEE, itemId: bread.id, quantity: 3 })).json();
    const poll = () => h.app.inject({ method: "GET", url: `/api/purchases/${placed.purchase.id}` });

    // Xaman says signed, and names a transaction that pays the wrong amount.
    const short = paidOnLedger(h, placed.purchase, { drops: "4500000", delivered: "1500000" });
    h.payloads.set(placed.xaman.uuid, { resolved: true, signed: true, txHash: short });
    expect((await poll()).json().purchase.status).toBe("reserved");

    // Two seconds on, and the transaction it names is the right one.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3_000);
    const real = paidOnLedger(h, placed.purchase);
    h.payloads.set(placed.xaman.uuid, { resolved: true, signed: true, txHash: real });

    const paid = (await poll()).json().purchase;
    expect(paid).toMatchObject({ status: "paid", txHash: real });
  });

  it("gives the stock back the moment the buyer declines", async () => {
    const h = await harness();
    await attendee(h);
    const { bread } = await stall(h, { stock: 1 });
    const placed = (await buy(h, { address: ATTENDEE, itemId: bread.id })).json();
    h.payloads.set(placed.xaman.uuid, { resolved: true, signed: false, rejected: true });

    const res = await h.app.inject({ method: "GET", url: `/api/purchases/${placed.purchase.id}` });

    expect(res.json().purchase.status).toBe("expired");
    expect(await h.stores.purchases.unitsTaken(EVENT)).toEqual({});
  });

  it("confirms an order paid from another wallet app by its hash, and refuses a hash that does not pay it", async () => {
    const h = await harness();
    await attendee(h);
    const { bread } = await stall(h);
    const placed = (await buy(h, { address: ATTENDEE, itemId: bread.id })).json();
    const confirm = (txHash: string) =>
      h.app.inject({ method: "POST", url: `/api/purchases/${placed.purchase.id}/confirm`, payload: { txHash } });

    const wrongVendor = paidOnLedger(h, placed.purchase, { to: ADIDAS });
    const refused = await confirm(wrongVendor);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe("VERIFICATION_FAILED");

    const notYet = await confirm("F".repeat(64));
    expect(notYet.statusCode).toBe(422);
    expect(notYet.json().error.details.notYet).toBe(true);

    const good = paidOnLedger(h, placed.purchase);
    const ok = await confirm(good);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().purchase).toMatchObject({ status: "paid", txHash: good });
  });

  it("shows one wallet what it can spend, whether it may buy, and its orders", async () => {
    const h = await harness();
    await attendee(h);
    const { bread } = await stall(h);
    await buy(h, { address: ATTENDEE, itemId: bread.id });

    const mine = await h.app.inject({ method: "GET", url: `/api/events/${EVENT}/store/wallets/${ATTENDEE}` });
    expect(mine.json()).toMatchObject({
      address: ATTENDEE,
      account: { activated: true, balanceXrp: "11.21", spendableXrp: "10.01" },
      eligible: true,
    });
    expect(mine.json().purchases).toHaveLength(1);

    const theirs = await h.app.inject({ method: "GET", url: `/api/events/${EVENT}/store/wallets/${STRANGER}` });
    expect(theirs.json()).toMatchObject({ eligible: false, purchases: [] });
    expect(theirs.json().reason).toMatch(/badge/);
  });
});

// ---------------------------------------------------------------------------
// The vendor's screen
// ---------------------------------------------------------------------------

describe("vendor: signing in and serving orders", () => {
  async function signInAs(h: Harness, account: string): Promise<{ status: number; cookie: string }> {
    const uuid = randomUUID();
    h.signIns.set(uuid, { resolved: true, signed: true, account, rejected: false });
    const res = await h.app.inject({ method: "POST", url: "/api/vendor/session", payload: { signinUuid: uuid } });
    const header = res.headers["set-cookie"];
    const raw = Array.isArray(header) ? header[0] : header;
    return { status: res.statusCode, cookie: raw ? raw.split(";")[0] ?? "" : "" };
  }

  it("signs in a wallet that is a vendor, and nobody else", async () => {
    const h = await harness();
    await stall(h);

    const vendor = await signInAs(h, DOMINOS);
    expect(vendor.status).toBe(200);
    expect(vendor.cookie).toMatch(/^poap_vendor=/);

    const me = await h.app.inject({ method: "GET", url: "/api/vendor/me", headers: { cookie: vendor.cookie } });
    expect(me.json()).toMatchObject({
      address: DOMINOS,
      vendors: [{ name: "Dominos", eventId: EVENT, eventName: "Ledger Days", eventStatus: "live" }],
    });

    expect((await signInAs(h, STRANGER)).status).toBe(403);
    expect((await h.app.inject({ method: "GET", url: "/api/vendor/me" })).statusCode).toBe(401);
  });

  it("will not sign in on an unsigned payload, or the same one twice", async () => {
    const h = await harness();
    await stall(h);

    const unsigned = randomUUID();
    h.signIns.set(unsigned, { resolved: true, signed: false, rejected: true });
    expect(
      (await h.app.inject({ method: "POST", url: "/api/vendor/session", payload: { signinUuid: unsigned } })).statusCode,
    ).toBe(400);

    const once = randomUUID();
    h.signIns.set(once, { resolved: true, signed: true, account: DOMINOS, rejected: false });
    const first = await h.app.inject({ method: "POST", url: "/api/vendor/session", payload: { signinUuid: once } });
    const second = await h.app.inject({ method: "POST", url: "/api/vendor/session", payload: { signinUuid: once } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
  });

  it("shows a counter its paid orders once the ledger shows them, and only its own", async () => {
    const h = await harness();
    await attendee(h);
    const { vendor, bread } = await stall(h);
    const adidas = await h.stores.vendors.createVendor({ eventId: EVENT, name: "Adidas", walletAddress: ADIDAS });

    const placed = (await buy(h, { address: ATTENDEE, itemId: bread.id, quantity: 2 })).json();
    const { cookie } = await signInAs(h, DOMINOS);
    const orders = () =>
      h.app.inject({ method: "GET", url: `/api/vendor/orders?vendorId=${vendor.id}`, headers: { cookie } });

    // Not paid: not on the vendor's screen.
    expect((await orders()).json().orders).toEqual([]);

    // The buyer approved in Xaman and never came back to their page.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3_000);
    h.payloads.set(placed.xaman.uuid, { resolved: true, signed: true, txHash: paidOnLedger(h, placed.purchase) });

    const screen = (await orders()).json();
    expect(screen.orders).toHaveLength(1);
    expect(screen.orders[0]).toMatchObject({ itemName: "Garlic bread", quantity: 2, status: "paid", handedOverAt: null });
    expect(screen.counts).toEqual({ paid: 1, handedOver: 0, toHandOver: 1 });

    const other = await h.app.inject({ method: "GET", url: `/api/vendor/orders?vendorId=${adidas.id}`, headers: { cookie } });
    expect(other.statusCode).toBe(403);
  });

  it("records a hand-over only with the header, only for a paid order at its own counter, and undoes one", async () => {
    const h = await harness();
    await attendee(h);
    const { bread } = await stall(h);
    const placed = (await buy(h, { address: ATTENDEE, itemId: bread.id })).json();
    const { cookie } = await signInAs(h, DOMINOS);
    const handover = (handedOver: boolean, headers: Record<string, string> = { cookie, "x-poap-vendor": "1" }) =>
      h.app.inject({
        method: "POST",
        url: `/api/vendor/orders/${placed.purchase.id}/handover`,
        headers,
        payload: { handedOver },
      });

    expect((await handover(true, { cookie })).statusCode).toBe(403);
    // Unpaid: nothing to hand over.
    expect((await handover(true)).statusCode).toBe(409);

    await h.stores.purchases.markPaid(placed.purchase.id, paidOnLedger(h, placed.purchase));
    const done = await handover(true);
    expect(done.statusCode).toBe(200);
    expect(done.json().purchase.handedOverAt).toBeTruthy();
    expect((await handover(false)).json().purchase.handedOverAt).toBeNull();

    // Somebody else's counter cannot touch it, and cannot tell it exists.
    await h.stores.vendors.createVendor({ eventId: EVENT, name: "Adidas", walletAddress: ADIDAS });
    const intruder = await signInAs(h, ADIDAS);
    expect((await handover(true, { cookie: intruder.cookie, "x-poap-vendor": "1" })).statusCode).toBe(404);
  });

  it("signs out for real", async () => {
    const h = await harness();
    await stall(h);
    const { cookie } = await signInAs(h, DOMINOS);

    const out = await h.app.inject({ method: "POST", url: "/api/vendor/logout", headers: { cookie } });

    expect(out.statusCode).toBe(200);
    expect(String(out.headers["set-cookie"])).toMatch(/Max-Age=0/);
    expect((await h.app.inject({ method: "GET", url: "/api/vendor/me", headers: { cookie } })).statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The organiser's sales, and the webhook
// ---------------------------------------------------------------------------

describe("sales and the Xaman webhook", () => {
  it("settles an order from a webhook delivery, reading the ledger rather than the body", async () => {
    const h = await harness();
    await attendee(h);
    const { bread } = await stall(h);
    const placed = (await buy(h, { address: ATTENDEE, itemId: bread.id })).json();
    const real = paidOnLedger(h, placed.purchase);
    h.payloads.set(placed.xaman.uuid, { resolved: true, signed: true, txHash: real });

    const res = await h.app.inject({
      method: "POST",
      url: "/webhooks/xaman",
      payload: {
        meta: { payload_uuidv4: placed.xaman.uuid },
        // A forged body would say anything here. It is not what gets checked.
        payloadResponse: { payload_uuidv4: placed.xaman.uuid, signed: true, txid: "0".repeat(64), account: STRANGER },
        custom_meta: { blob: { kind: "poap-purchase", eventId: EVENT, purchaseId: placed.purchase.id } },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, recorded: true, status: "paid" });
    expect((await h.stores.purchases.find(placed.purchase.id))?.txHash).toBe(real);
  });

  it("adds up paid orders per vendor for the organiser, and lists every order", async () => {
    const h = await harness();
    await attendee(h);
    const { bread } = await stall(h, { priceXrp: "0.1" });
    const a = (await buy(h, { address: ATTENDEE, itemId: bread.id, quantity: 2 })).json();
    await buy(h, { address: ATTENDEE, itemId: bread.id });
    await h.stores.purchases.markPaid(a.purchase.id, paidOnLedger(h, a.purchase));

    const sales = await h.app.inject({ method: "GET", url: `/admin/api/sales?eventId=${EVENT}`, headers: asAdmin });
    expect(sales.json().totals).toEqual({ orders: 1, units: 2, totalXrp: "0.2", handedOver: 0 });

    const all = await h.app.inject({ method: "GET", url: `/admin/api/purchases?eventId=${EVENT}`, headers: asAdmin });
    expect(all.json()).toMatchObject({ total: 2 });
    const paid = await h.app.inject({ method: "GET", url: "/admin/api/purchases?status=paid", headers: asAdmin });
    expect(paid.json().purchases.map((p: { id: string }) => p.id)).toEqual([a.purchase.id]);
  });
});
