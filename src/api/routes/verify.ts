/**
 * GET /verify — re-derive attendance from the chain, on demand (brief 6.4).
 *
 * The counterpart to GET /events/:eventId/attendance: that one reads the index,
 * this one reads the ledger. Anything that needs to be *sure* asks here.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { addressSchema, eventIdSchema, txHashSchema } from "../http-errors.js";

const verifyQuerySchema = z.object({
  address: addressSchema,
  eventId: eventIdSchema,
  /** The attendee's NFTokenAcceptOffer hash. This hash *is* the attendance record. */
  txHash: txHashSchema,
});

type VerifyQuery = z.infer<typeof verifyQuerySchema>;

export function registerVerifyRoute(app: FastifyInstance, deps: ApiDeps): void {
  /**
   * GET /verify?address=&eventId=&txHash=
   *
   * 200 always when the query is well formed — including `attended: false`.
   * A failed verification is an answer, not an error.
   * 400 bad query | 502 ledger trouble
   */
  app.get<{ Querystring: VerifyQuery }>(
    "/verify",
    { schema: { querystring: verifyQuerySchema } },
    async (request, reply) => {
      const { address, eventId, txHash } = request.query;

      // Attendance is an event, not a state. verifyClaim() answers "did this
      // wallet ever accept a badge we issued with this taxon", never "does it
      // hold one now", so a burned badge still returns attended: true with
      // status "attended_badge_burned".
      const result = await deps.chain.verifyClaim(deps.gateway, { address, eventId, txHash });

      // The whole result goes out, per-check breakdown included — plus
      // `degraded` (issuer and taxon decoded from the NFTokenID because the
      // endpoint has no Clio, so burn status is unknown rather than false) and
      // `nftokenIdSource`. A caller auditing a verdict needs to know how it was
      // reached, so nothing here is summarised away.
      return reply.code(200).send({ address, eventId, txHash, ...result });
    },
  );
}
