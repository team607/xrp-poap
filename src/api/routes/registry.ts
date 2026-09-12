/**
 * The organiser's two cross-event lists.
 *
 * Everything else in this API is scoped to one event, and rightly so: an
 * attendee's questions are all about the event they came to. An ORGANISER's
 * are not. "Who signed up this month", "which wallets hold a badge", "who
 * registered and never turned up" are questions about the deployment, and
 * answering them by merging N paginated per-event reads in a browser cannot
 * page honestly — the second page of a merge is not the second page of
 * anything.
 *
 * So the window and the ordering live here, and `eventId` narrows rather than
 * selects. One endpoint serves both the whole list and one event's slice,
 * which is what lets the pages have a single code path and a filter that is
 * just another query parameter.
 *
 * BOTH ARE BEHIND requireAdmin AND BOTH RETURN FULL RECORDS, emails included.
 * That is the difference between these and anything under /api: this is the
 * organiser's own data. Nothing here may ever be reachable without a session.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { sendError } from "../http-errors.js";
import { adminGuard } from "./events.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * `eventId` is optional and, when absent, means EVERY event — not "event 0".
 * `z.coerce.number()` on an absent value yields NaN rather than undefined,
 * which is why the coercion is spelled out rather than borrowed from the
 * event-scoped schema next door.
 */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
  eventId: z.coerce.number().int().min(0).optional(),
});

const registrationsQuerySchema = listQuerySchema.extend({
  // A querystring value is a string, and z.coerce.boolean() reads "false" as
  // true — which is the wrong half of the list to show by accident.
  checkedIn: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

type ListQuery = z.infer<typeof listQuerySchema>;
type RegistrationsQuery = z.infer<typeof registrationsQuerySchema>;

export function registerRegistryRoutes(app: FastifyInstance, deps: ApiDeps): void {
  /* The same belt-and-braces guard the event routes use, exported from there
     for exactly this. The `/admin/api` prefix hook already covers both routes
     below; this is what makes them safe on an instance built without it, and
     it is the seam that lets a test inject three lines instead of a session
     store. */
  const guard = adminGuard(deps);

  /**
   * GET /admin/api/registrations?limit=&offset=&eventId=&checkedIn=
   *
   * Every registration on the deployment, newest first.
   *
   * `total` and `checkedIn` describe the SELECTED EVENT (or all of them), not
   * the filtered page: the filter tabs need to show what they would find
   * before you press them, and a count that moved when you pressed one would
   * be useless for that.
   *
   * 200 | 400 bad query | 401 no session | 503 no registration store
   */
  app.get<{ Querystring: RegistrationsQuery }>(
    "/admin/api/registrations",
    { schema: { querystring: registrationsQuerySchema }, preHandler: guard },
    async (request, reply) => {
      const registrations = deps.registrations;
      if (!registrations) {
        return sendError(
          reply,
          503,
          "CONFIG_INVALID",
          "No registration store is wired on this server.",
        );
      }

      const { limit, offset, eventId, checkedIn } = request.query;
      const scope = eventId === undefined ? {} : { eventId };

      const [rows, counts] = await Promise.all([
        registrations.listAll({
          limit,
          offset,
          ...scope,
          ...(checkedIn === undefined ? {} : { checkedIn }),
        }),
        registrations.countAll(scope),
      ]);

      return reply.code(200).send({
        limit,
        offset,
        eventId: eventId ?? null,
        total: counts.total,
        checkedIn: counts.checkedIn,
        registrations: rows,
      });
    },
  );

  /**
   * GET /admin/api/badges?limit=&offset=&eventId=
   *
   * Every badge the attendance index holds, in claim order.
   *
   * THIS IS THE INDEX, NOT THE LEDGER. Each row is one accept transaction that
   * passed all five checks when it was recorded, which is why it is cheap
   * enough to page through. The expensive question — what the chain says right
   * now — is GET /events/:eventId/roster, and the two are deliberately not
   * merged here: one is a record of something that happened and the other is a
   * statement about the present.
   *
   * 200 | 400 bad query | 401 no session
   */
  app.get<{ Querystring: ListQuery }>(
    "/admin/api/badges",
    { schema: { querystring: listQuerySchema }, preHandler: guard },
    async (request, reply) => {
      const { limit, offset, eventId } = request.query;
      const scope = eventId === undefined ? {} : { eventId };

      const [rows, total] = await Promise.all([
        deps.attendance.listAll({ limit, offset, ...scope }),
        deps.attendance.countAll(scope),
      ]);

      return reply.code(200).send({
        limit,
        offset,
        eventId: eventId ?? null,
        total,
        badges: rows.map((row) => ({
          eventId: row.eventId,
          address: row.address,
          nftokenId: row.nftokenId,
          txHash: row.txHash,
          claimedAt: row.claimedAt ? row.claimedAt.toISOString() : null,
        })),
      });
    },
  );
}
