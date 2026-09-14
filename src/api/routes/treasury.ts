/**
 * An event's money, from the organiser's side.
 *
 *   GET  /admin/api/events/:eventId/treasury          the wallet, its balance, the budget
 *   GET  /admin/api/events/:eventId/allowances        who was paid what
 *   POST /admin/api/events/:eventId/allowances/retry  pay badge holders who were missed
 *   POST /admin/api/events/:eventId/treasury/sweep    send what is left somewhere else
 *
 * All four sit under /admin/api, so the prefix hook requires a session before a
 * handler is reached, and each also runs adminGuard as a preHandler — the same
 * belt and braces as every other admin route. Two of them move XRP.
 *
 * NOTHING HERE RETURNS A SEED. The treasury's address is public — it is where
 * the organiser sends money — and that is all of the treasury any response
 * carries.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AllowanceDeniedError, TransactionFailedError, XrplLayerError } from "../../errors.js";
import { dropsToXrpString, maxDrops, xrpToDropsBigInt } from "../../money.js";
import type { AccountSnapshot } from "../../xrpl/account.js";
import { BASE_RESERVE_XRP } from "../../xrpl/reserve.js";
import { largestPaymentXrp, payAllowanceFor } from "../allowance.js";
import type { ApiDeps } from "../deps.js";
import {
  addressSchema,
  eventIdParamsSchema,
  sendError,
  type EventIdParams,
} from "../http-errors.js";
import { adminGuard } from "./events.js";

/**
 * Payments one retry request makes before it stops and says how many are left.
 * Treasury payments go out one at a time — they share the treasury's sequence
 * — and each waits for a validated ledger, so this keeps a request inside what
 * a proxy will wait for.
 */
const RETRY_BATCH = 10;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.infer<typeof listQuerySchema>;

const sweepBodySchema = z
  .object({
    destination: addressSchema,
    destinationTag: z.number().int().min(0).max(4_294_967_295).optional(),
  })
  .strict();
type SweepBody = z.infer<typeof sweepBodySchema>;

export function registerTreasuryRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const events = deps.events;
  if (!events) return;
  const guard = adminGuard(deps);

  /**
   * GET /admin/api/events/:eventId/treasury
   *
   * Makes the treasury first if the event has none and this server can, so an
   * organiser opening an older event is shown an address to fund rather than
   * a gap. `account` is null when the ledger could not be read — the budget
   * half still answers.
   *
   * 200 | 401 | 404
   */
  app.get<{ Params: EventIdParams }>(
    "/admin/api/events/:eventId/treasury",
    { schema: { params: eventIdParamsSchema }, preHandler: guard },
    async (request, reply) => {
      const { eventId } = request.params;
      const event = await events.find(eventId);
      if (!event) return sendError(reply, 404, "NOT_FOUND", `No event ${eventId}.`, { eventId });

      const record = deps.treasuries ? await deps.treasuries.ensure(eventId) : null;

      let account: AccountSnapshot | null = null;
      let ledgerError: string | undefined;
      if (record) {
        try {
          account = await deps.chain.readAccount(deps.gateway, record.address);
        } catch (err) {
          ledgerError = "The treasury's balance could not be read from the ledger just now.";
          request.log.warn({ err, eventId }, "treasury balance read failed");
        }
      }

      const summary = deps.allowances
        ? await deps.allowances.summary(eventId)
        : { committedXrp: "0", paidXrp: "0", paidCount: 0, inFlightCount: 0 };

      const allowanceXrp = event.allowanceXrp ?? "0";
      const budgetXrp = event.budgetXrp ?? "0";
      const remaining = maxDrops(0n, xrpToDropsBigInt(budgetXrp) - xrpToDropsBigInt(summary.committedXrp));

      // How much more the treasury needs to cover the rest of its budget. An
      // account that does not exist yet also needs the base reserve to exist.
      let fundingNeeded = remaining;
      if (account) {
        fundingNeeded = maxDrops(0n, remaining - xrpToDropsBigInt(account.spendableXrp));
        if (!account.activated && remaining > 0n) fundingNeeded += xrpToDropsBigInt(BASE_RESERVE_XRP);
      }

      return reply.code(200).send({
        eventId,
        configured: Boolean(deps.treasuries?.configured),
        address: record?.address ?? null,
        account: account
          ? {
              activated: account.activated,
              balanceXrp: account.balanceXrp,
              reserveXrp: account.reserveXrp,
              spendableXrp: account.spendableXrp,
            }
          : null,
        ...(ledgerError ? { ledgerError } : {}),
        allowanceXrp,
        budgetXrp,
        committedXrp: summary.committedXrp,
        paidXrp: summary.paidXrp,
        paidCount: summary.paidCount,
        inFlightCount: summary.inFlightCount,
        remainingBudgetXrp: dropsToXrpString(remaining),
        fundingNeededXrp: record ? dropsToXrpString(fundingNeeded) : null,
        largestPaymentXrp: largestPaymentXrp(deps, allowanceXrp),
        maxPerAttendeeXrp: deps.config.reward.maxPerAttendeeXrp,
        feeBufferXrp: deps.config.reward.feeBufferXrp,
      });
    },
  );

  /**
   * GET /admin/api/events/:eventId/allowances?limit=&offset=
   *
   * Newest first. `status` is "paid" once the ledger confirmed the payment and
   * "in_flight" before that.
   *
   * 200 | 401 | 404 | 503 no ledger wired
   */
  app.get<{ Params: EventIdParams; Querystring: ListQuery }>(
    "/admin/api/events/:eventId/allowances",
    { schema: { params: eventIdParamsSchema, querystring: listQuerySchema }, preHandler: guard },
    async (request, reply) => {
      const { eventId } = request.params;
      const { limit, offset } = request.query;
      if (!(await events.find(eventId))) {
        return sendError(reply, 404, "NOT_FOUND", `No event ${eventId}.`, { eventId });
      }
      const ledger = deps.allowances;
      if (!ledger) {
        return sendError(reply, 503, "CONFIG_INVALID", "No allowance ledger is wired on this server.", {
          eventId,
        });
      }

      const [rows, summary] = await Promise.all([
        ledger.listByEvent(eventId, { limit, offset }),
        ledger.summary(eventId),
      ]);

      return reply.code(200).send({
        eventId,
        limit,
        offset,
        total: summary.paidCount + summary.inFlightCount,
        allowances: rows.map((row) => ({
          id: row.id,
          address: row.address,
          allowanceXrp: row.allowanceXrp,
          topupXrp: row.topupXrp,
          amountXrp: row.amountXrp,
          status: row.status === "confirmed" ? "paid" : "in_flight",
          txHash: row.txHash,
          reservedAt: row.reservedAt.toISOString(),
          confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
        })),
      });
    },
  );

  /**
   * POST /admin/api/events/:eventId/allowances/retry
   *
   * Every badge holder at this event whose allowance has not been paid, paid
   * now — up to RETRY_BATCH per request. For after the treasury was topped up,
   * or the budget raised, when some attendees were issued their badge without
   * their allowance.
   *
   * Stops early on a refusal that would refuse the next attendee too — the
   * budget, the ceiling, no treasury, a treasury with no money — and says why.
   *
   * 200 { paid, alreadyPaid, nothingOwed, failed, more, stoppedBecause?, failures }
   * 401 | 404 | 409 a draft event
   */
  app.post<{ Params: EventIdParams }>(
    "/admin/api/events/:eventId/allowances/retry",
    { schema: { params: eventIdParamsSchema }, preHandler: guard },
    async (request, reply) => {
      const { eventId } = request.params;
      const event = await events.find(eventId);
      if (!event) return sendError(reply, 404, "NOT_FOUND", `No event ${eventId}.`, { eventId });
      if (event.status === "draft") {
        return sendError(reply, 409, "CONFLICT", "A draft event has no attendees to pay.", { eventId });
      }

      const report = {
        paid: 0,
        alreadyPaid: 0,
        nothingOwed: 0,
        failed: 0,
        more: false,
        stoppedBecause: undefined as string | undefined,
        failures: [] as Array<{ address: string; code: string; message: string }>,
      };

      let attempts = 0;
      const PAGE = 200;
      scan: for (let offset = 0; ; offset += PAGE) {
        const holders = await deps.attendance.listByEvent(eventId, { limit: PAGE, offset });
        for (const holder of holders) {
          const existing = deps.allowances ? await deps.allowances.find(eventId, holder.address) : null;
          if (existing?.status === "confirmed") {
            report.alreadyPaid += 1;
            continue;
          }
          if (attempts >= RETRY_BATCH) {
            report.more = true;
            break scan;
          }
          attempts += 1;

          try {
            const result = await payAllowanceFor(deps, { eventId, address: holder.address });
            if (result.outcome === "paid") report.paid += 1;
            else if (result.outcome === "already_paid") report.alreadyPaid += 1;
            else report.nothingOwed += 1;
          } catch (err) {
            report.failed += 1;
            report.failures.push({
              address: holder.address,
              code: err instanceof XrplLayerError ? err.code : "INTERNAL",
              message: err instanceof XrplLayerError ? err.message : "The payment failed.",
            });

            if (err instanceof AllowanceDeniedError && err.kind !== "in_flight") {
              report.stoppedBecause = err.kind;
              break scan;
            }
            if (err instanceof TransactionFailedError && err.engineResult === "tecUNFUNDED_PAYMENT") {
              report.stoppedBecause = "unfunded";
              break scan;
            }
          }
        }
        if (holders.length < PAGE) break;
      }

      request.log.info(
        { eventId, ...report, failures: report.failures.length, admin: request.admin?.email },
        "allowance retry",
      );

      return reply.code(200).send({
        eventId,
        paid: report.paid,
        alreadyPaid: report.alreadyPaid,
        nothingOwed: report.nothingOwed,
        failed: report.failed,
        more: report.more,
        ...(report.stoppedBecause ? { stoppedBecause: report.stoppedBecause } : {}),
        failures: report.failures,
      });
    },
  );

  /**
   * POST /admin/api/events/:eventId/treasury/sweep { destination, destinationTag? }
   *
   * Everything above the treasury's reserve, to an address the organiser typed.
   * Refused while the event is live, and while any allowance is still on its
   * way: a sweep then would empty the wallet a payment is about to come out of.
   *
   * 200 { amountXrp, destination, txHash, ... }
   * 400 bad address, or a destination that needs a tag | 401 | 404
   * 409 live, payments in flight, nothing to sweep | 503 no treasury key
   */
  app.post<{ Params: EventIdParams; Body: SweepBody }>(
    "/admin/api/events/:eventId/treasury/sweep",
    { schema: { params: eventIdParamsSchema, body: sweepBodySchema }, preHandler: guard },
    async (request, reply) => {
      const { eventId } = request.params;
      const { destination, destinationTag } = request.body;

      const event = await events.find(eventId);
      if (!event) return sendError(reply, 404, "NOT_FOUND", `No event ${eventId}.`, { eventId });
      if (event.status === "live") {
        return sendError(
          reply,
          409,
          "CONFLICT",
          "This event is live, so its treasury is still paying attendees. Close the event before " +
            "sweeping what is left.",
          { eventId, status: event.status },
        );
      }

      if (deps.allowances) {
        const { inFlightCount } = await deps.allowances.summary(eventId);
        if (inFlightCount > 0) {
          return sendError(
            reply,
            409,
            "CONFLICT",
            `${inFlightCount} allowance payment${inFlightCount === 1 ? " is" : "s are"} still on the way ` +
              "out of this treasury. Try again in a few minutes.",
            { eventId, inFlightCount },
          );
        }
      }

      const handle = deps.treasuries ? await deps.treasuries.handle(eventId) : null;
      if (!handle) {
        return sendError(
          reply,
          503,
          "SERVICE_UNAVAILABLE",
          "This server cannot open the event's treasury: TREASURY_MASTER_KEY is unset, or the event " +
            "has no treasury.",
          { eventId },
        );
      }

      const result = await deps.chain.sweepTreasury(deps.gateway, {
        eventId,
        treasury: handle,
        destination,
        ...(destinationTag === undefined ? {} : { destinationTag }),
      });

      request.log.info(
        {
          eventId,
          destination,
          destinationTag,
          amountXrp: result.amountXrp,
          txHash: result.txHash,
          admin: request.admin?.email,
        },
        "treasury swept",
      );

      return reply.code(200).send({ eventId, ...result });
    },
  );
}
