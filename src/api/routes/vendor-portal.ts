/**
 * The vendor's order screen.
 *
 *   POST /api/vendor/signin                 start a Xaman SignIn
 *   GET  /api/vendor/signin/:uuid           has it been signed?
 *   POST /api/vendor/session                finish it: the wallet is now signed in
 *   GET  /api/vendor/me                     who is signed in, and for which counters
 *   POST /api/vendor/logout
 *   GET  /api/vendor/orders?vendorId=       this counter's orders
 *   POST /api/vendor/orders/:id/handover    it left the counter (or it did not)
 *
 * THE WALLET IS THE LOGIN. A vendor proves the wallet they are paid into, and
 * may see the orders of every vendor row that wallet is — the same proof the
 * registration page uses, for the same reason: an address somebody typed is a
 * claim, and a SignIn is proof.
 *
 * AN ORDER APPEARS ONLY ONCE THE LEDGER SAYS IT IS PAID. The screen lists paid
 * orders by default, and settles any unpaid ones against the ledger each time
 * it asks, so a payment shows up here whether or not the buyer's phone ever
 * came back from Xaman. Nothing a buyer's page reports can make an order paid.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { VendorRecord } from "../../types.js";
import {
  MemoryConsumedSignIns,
  NullSignInService,
  type ConsumedSignIns,
  type SignInService,
} from "../../xaman/signin.js";
import type { ApiDeps } from "../deps.js";
import { sendError } from "../http-errors.js";
import { settlerFor, toPurchaseView } from "../purchases.js";
import {
  VENDOR_HEADER,
  VENDOR_SESSION_TTL_MS,
  clearVendorCookie,
  hasVendorHeader,
  readVendorSession,
  setVendorCookie,
} from "../vendor-auth.js";

const SIGNIN_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;
const POLL_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

/** Unpaid orders one screen refresh settles against the ledger. */
const SETTLE_PER_READ = 10;

const ROW_ID = /^[1-9]\d{0,17}$/;

const signInBodySchema = z
  .object({ returnUrl: z.object({ app: z.string().url().optional(), web: z.string().url().optional() }).optional() })
  .nullish();
const uuidParamsSchema = z.object({ uuid: z.uuid() });
const sessionBodySchema = z.object({ signinUuid: z.uuid() }).strict();
const ordersQuerySchema = z.object({
  vendorId: z.string().regex(ROW_ID),
  status: z.enum(["paid", "all"]).default("paid"),
});
const handoverParamsSchema = z.object({ purchaseId: z.uuid() });
const handoverBodySchema = z.object({ handedOver: z.boolean() }).strict();

type SignInBody = z.infer<typeof signInBodySchema>;
type UuidParams = z.infer<typeof uuidParamsSchema>;
type SessionBody = z.infer<typeof sessionBodySchema>;
type OrdersQuery = z.infer<typeof ordersQuerySchema>;
type HandoverParams = z.infer<typeof handoverParamsSchema>;
type HandoverBody = z.infer<typeof handoverBodySchema>;

export function registerVendorPortalRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { events, vendors, purchases, vendorSessions } = deps;
  if (!events || !vendors || !purchases || !vendorSessions) return;

  const signIn: SignInService = deps.signIn ?? new NullSignInService();
  const consumed: ConsumedSignIns = new MemoryConsumedSignIns();
  const settler = settlerFor(deps);

  const limitsOff = deps.rateLimit?.enabled === false;
  const signinLimit = limitsOff ? false : SIGNIN_RATE_LIMIT;
  const pollLimit = limitsOff ? false : POLL_RATE_LIMIT;

  /** Each vendor row with its event's name, for a screen that may cover several events. */
  const counters = async (rows: VendorRecord[]) => {
    const eventIds = [...new Set(rows.map((v) => v.eventId))];
    const found = await Promise.all(eventIds.map((id) => events.find(id)));
    const byId = new Map(found.filter((e) => e !== null).map((e) => [e.eventId, e]));
    return rows.map((vendor) => {
      const event = byId.get(vendor.eventId);
      return {
        id: vendor.id,
        name: vendor.name,
        active: vendor.active,
        eventId: vendor.eventId,
        eventName: event?.name ?? `Event ${vendor.eventId}`,
        eventStatus: event?.status ?? null,
      };
    });
  };

  const notSignedIn = "Not signed in. Sign in with the wallet you are paid into.";

  app.post<{ Body: SignInBody }>(
    "/api/vendor/signin",
    { schema: { body: signInBodySchema }, config: { rateLimit: signinLimit } },
    async (request, reply) => {
      const returnUrl = request.body?.returnUrl;
      const handles = await signIn.create({
        purpose: "vendor",
        ...(returnUrl && (returnUrl.app || returnUrl.web) ? { returnUrl } : {}),
      });
      return reply.code(201).send(handles);
    },
  );

  app.get<{ Params: UuidParams }>(
    "/api/vendor/signin/:uuid",
    { schema: { params: uuidParamsSchema }, config: { rateLimit: pollLimit } },
    async (request, reply) => {
      const resolution = await signIn.resolve(request.params.uuid);
      return reply.code(200).send({
        uuid: request.params.uuid,
        resolved: resolution.resolved,
        signed: resolution.signed,
        rejected: resolution.rejected,
        ...(resolution.account ? { address: resolution.account } : {}),
      });
    },
  );

  /**
   * POST /api/vendor/session { signinUuid }
   *
   * 200 signed in, cookie set | 400 not signed | 403 not a vendor anywhere
   * 409 that sign-in was already used
   */
  app.post<{ Body: SessionBody }>(
    "/api/vendor/session",
    { schema: { body: sessionBodySchema }, config: { rateLimit: signinLimit } },
    async (request, reply) => {
      const { signinUuid } = request.body;
      const resolution = await signIn.resolve(signinUuid);
      if (!resolution.signed || !resolution.account) {
        return sendError(
          reply,
          400,
          "INVALID_INPUT",
          resolution.rejected
            ? "That sign-in was declined or expired. Start again and approve it in Xaman."
            : "That sign-in has not been approved yet.",
        );
      }

      // A signed payload stays signed. One session per proof.
      if (!(await consumed.claim(signinUuid))) {
        return sendError(reply, 409, "DUPLICATE_CLAIM", "That sign-in was already used. Start a new one.");
      }

      try {
        const rows = await vendors.listVendorsByWallet(resolution.account);
        if (rows.length === 0) {
          return sendError(
            reply,
            403,
            "FORBIDDEN",
            "This wallet is not a vendor at any event here. Ask the organiser to add it, then sign in again.",
            { address: resolution.account },
          );
        }

        const session = await vendorSessions.create(resolution.account, VENDOR_SESSION_TTL_MS);
        setVendorCookie(reply, deps.config, session.id, VENDOR_SESSION_TTL_MS);
        request.log.info({ vendors: rows.map((v) => v.id) }, "vendor signed in");
        return reply.code(200).send({ address: resolution.account, vendors: await counters(rows) });
      } catch (err) {
        await consumed.release(signinUuid);
        throw err;
      }
    },
  );

  app.get("/api/vendor/me", { config: { rateLimit: pollLimit } }, async (request, reply) => {
    const signedIn = await readVendorSession(deps, request);
    if (!signedIn) return sendError(reply, 401, "UNAUTHORIZED", notSignedIn);
    return reply
      .code(200)
      .send({ address: signedIn.session.walletAddress, vendors: await counters(signedIn.vendors) });
  });

  app.post("/api/vendor/logout", async (request, reply) => {
    const signedIn = await readVendorSession(deps, request);
    if (signedIn) await vendorSessions.revoke(signedIn.session.id);
    clearVendorCookie(reply, deps.config);
    return reply.code(200).send({ ok: true });
  });

  /**
   * GET /api/vendor/orders?vendorId=&status=paid|all
   *
   * One counter's orders, newest first. Unpaid orders are settled against the
   * ledger before the answer, so a payment appears the moment it validates.
   */
  app.get<{ Querystring: OrdersQuery }>(
    "/api/vendor/orders",
    { schema: { querystring: ordersQuerySchema }, config: { rateLimit: pollLimit } },
    async (request, reply) => {
      const signedIn = await readVendorSession(deps, request);
      if (!signedIn) return sendError(reply, 401, "UNAUTHORIZED", notSignedIn);

      const vendor = signedIn.vendors.find((v) => v.id === request.query.vendorId);
      if (!vendor) {
        return sendError(reply, 403, "FORBIDDEN", "This wallet does not sell at that counter.");
      }

      // Waiting orders first, so the ones that just got paid are settled now.
      const waiting = await purchases.list({ vendorId: vendor.id, status: "reserved", limit: SETTLE_PER_READ });
      await Promise.all(waiting.map((row) => settler.settle(row, request.log)));

      const [rows, paid, handedOver] = await Promise.all([
        purchases.list({
          vendorId: vendor.id,
          ...(request.query.status === "paid" ? { status: "paid" as const } : {}),
          limit: 200,
        }),
        purchases.count({ vendorId: vendor.id, status: "paid" }),
        purchases.list({ vendorId: vendor.id, status: "paid", limit: 500 }),
      ]);

      return reply.code(200).send({
        vendor: (await counters([vendor]))[0],
        orders: rows.map(toPurchaseView),
        counts: {
          paid,
          handedOver: handedOver.filter((p) => p.handedOverAt !== null).length,
          toHandOver: handedOver.filter((p) => p.handedOverAt === null).length,
        },
      });
    },
  );

  /**
   * POST /api/vendor/orders/:purchaseId/handover { handedOver }
   *
   * Needs the `x-poap-vendor: 1` header. Only a paid order, and only one of
   * this wallet's counters; an order at somebody else's counter is a 404, not
   * a 403, so this cannot be used to learn which orders exist.
   */
  app.post<{ Params: HandoverParams; Body: HandoverBody }>(
    "/api/vendor/orders/:purchaseId/handover",
    { schema: { params: handoverParamsSchema, body: handoverBodySchema } },
    async (request, reply) => {
      const signedIn = await readVendorSession(deps, request);
      if (!signedIn) return sendError(reply, 401, "UNAUTHORIZED", notSignedIn);
      if (!hasVendorHeader(request)) {
        return sendError(reply, 403, "FORBIDDEN", `This request needs the ${VENDOR_HEADER} header.`);
      }

      const order = await purchases.find(request.params.purchaseId);
      if (!order || !signedIn.vendors.some((v) => v.id === order.vendorId)) {
        return sendError(reply, 404, "NOT_FOUND", "No such order at your counter.");
      }

      const updated = await purchases.setHandedOver(order.id, request.body.handedOver);
      request.log.info(
        { purchaseId: order.id, vendorId: order.vendorId, handedOver: request.body.handedOver },
        "order hand-over recorded",
      );
      return reply.code(200).send({ purchase: toPurchaseView(updated) });
    },
  );
}
