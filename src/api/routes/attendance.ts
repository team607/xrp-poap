/**
 * GET /events/:eventId/attendance — the local index (brief 6.5).
 *
 * "Never read attendance from the chain on a page load. Read from this table,
 * and expose a separate verify endpoint that re-derives from the chain on
 * demand." That separate endpoint is GET /verify; this one never touches the
 * ledger and never calls the gateway.
 *
 * The ledger stays the source of truth. This is the index.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { eventIdParamsSchema, type EventIdParams } from "../http-errors.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const attendanceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

type AttendanceParams = EventIdParams;
type AttendanceQuery = z.infer<typeof attendanceQuerySchema>;

export function registerAttendanceRoute(app: FastifyInstance, deps: ApiDeps): void {
  /**
   * GET /events/:eventId/attendance?limit=&offset=
   *
   * 200 with the page | 400 bad params
   */
  app.get<{ Params: AttendanceParams; Querystring: AttendanceQuery }>(
    "/events/:eventId/attendance",
    { schema: { params: eventIdParamsSchema, querystring: attendanceQuerySchema } },
    async (request, reply) => {
      const { eventId } = request.params;
      const { limit, offset } = request.query;

      const [records, total] = await Promise.all([
        deps.attendance.listByEvent(eventId, { limit, offset }),
        deps.attendance.countByEvent(eventId),
      ]);

      return reply.code(200).send({ eventId, total, limit, offset, records });
    },
  );
}
