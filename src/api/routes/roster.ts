/**
 * GET /events/:eventId/roster — the chain read (brief 6.1).
 *
 * `nfts_by_issuer` with the event's taxon is the single most useful query in
 * the system and also the most expensive: it is a Clio call that walks every
 * badge ever minted for the event, against a public server with no SLA.
 *
 * This is the deliberately expensive path. It is for organiser tooling,
 * reconciliation and "is the index lying to me?" — not for page loads. The
 * cheap read is GET /events/:eventId/attendance (brief 6.5).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { eventIdParamsSchema, type EventIdParams } from "../http-errors.js";

const rosterQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(400).optional(),
});

type RosterParams = EventIdParams;
type RosterQuery = z.infer<typeof rosterQuerySchema>;

export function registerRosterRoute(app: FastifyInstance, deps: ApiDeps): void {
  /**
   * GET /events/:eventId/roster?limit=
   *
   * 200 with every badge for the event, minted/claimed/burned counts and the
   * ledger's marker when the response was paginated.
   * 400 bad params | 502 ledger trouble
   */
  app.get<{ Params: RosterParams; Querystring: RosterQuery }>(
    "/events/:eventId/roster",
    { schema: { params: eventIdParamsSchema, querystring: rosterQuerySchema } },
    async (request, reply) => {
      const { eventId } = request.params;
      const { limit } = request.query;

      const roster = await deps.chain.getRoster(
        deps.gateway,
        eventId,
        limit === undefined ? undefined : { limit },
      );

      return reply.code(200).send(roster);
    },
  );
}
