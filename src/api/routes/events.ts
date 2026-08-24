/**
 * Events: public reads, admin writes.
 *
 * `eventId` IS the NFTokenTaxon (src/types.ts). There is no surrogate key, so
 * two rules run through this whole file:
 *
 *   1. A DRAFT EVENT IS NOT PUBLIC. It is the organiser's scratch space —
 *      wrong date, placeholder name, artwork not pinned yet. The public routes
 *      404 it with the same message they use for an id that never existed, so
 *      the two are indistinguishable from outside.
 *   2. AN EVENT'S IDENTITY NEVER CHANGES. `eventId` is refused by PATCH, and
 *      `metadataUri` is refused once badges exist: NFTokenMint.URI is written
 *      into the token and is immutable, so editing the event row afterwards
 *      does not repoint a single minted badge — it just splits one event across
 *      two artworks, silently.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { MAX_TAXON, type EventRecord, type EventStatus } from "../../types.js";
import { requireAdmin } from "../auth.js";
import type { ApiDeps } from "../deps.js";
import { eventIdParamsSchema, sendError, type EventIdParams } from "../http-errors.js";

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

const EVENT_STATUSES = ["draft", "open", "live", "closed"] as const satisfies readonly EventStatus[];
const eventStatusSchema = z.enum(EVENT_STATUSES);

/** What the public landing page lists: events you can register for, or are at. */
const LISTABLE_STATUSES: readonly EventStatus[] = ["open", "live"];

/**
 * What a public detail read may resolve.
 *
 * Wider than the list on purpose: a closed event is not advertised, but an
 * attendee holding a registration or a badge from last week must still be able
 * to load the page it belongs to. Only `draft` is hidden.
 */
function isPubliclyVisible(event: EventRecord): boolean {
  return event.status !== "draft";
}

/**
 * The public projection.
 *
 * Explicit rather than a spread of the row: `createdAt` / `updatedAt` are
 * bookkeeping about the record, not facts about the event, and a field added to
 * EventRecord later must be published deliberately rather than by accident.
 */
export interface PublicEvent {
  eventId: number;
  name: string;
  description?: string | null;
  eventDate?: string | null;
  venue?: string | null;
  metadataUri?: string | null;
  status: EventStatus;
}

export function toPublicEvent(event: EventRecord): PublicEvent {
  return {
    eventId: event.eventId,
    name: event.name,
    description: event.description ?? null,
    eventDate: event.eventDate ?? null,
    venue: event.venue ?? null,
    metadataUri: event.metadataUri ?? null,
    status: event.status,
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const pagingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

const adminListQuerySchema = pagingQuerySchema.extend({
  status: eventStatusSchema.optional(),
});

const registrationsQuerySchema = pagingQuerySchema.extend({
  // A querystring value is a string. `z.coerce.boolean()` would read "false" as
  // true, which is the wrong half of the desk list to show by accident.
  checkedIn: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

/**
 * `eventId` in a body is NOT the coerced `eventIdSchema` the path parameters
 * use. A path segment is always a string and has to be coerced; a JSON body can
 * carry a real number, and coercion there would quietly accept `"4242 "`,
 * `true` or `[4242]` for the field that becomes the NFTokenTaxon of every badge
 * for this event.
 */
const bodyEventIdSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_TAXON, `eventId doubles as the NFTokenTaxon; values above ${MAX_TAXON} are reserved`);

const nameSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().max(2_000);
/** ISO date of the event itself. Kept as a string; the ledger never sees it. */
const eventDateSchema = z.string().min(1).max(40);
const venueSchema = z.string().max(200);
const metadataUriSchema = z.string().min(1).max(256);

const createEventBodySchema = z
  .object({
    eventId: bodyEventIdSchema,
    name: nameSchema,
    description: descriptionSchema.optional(),
    eventDate: eventDateSchema.optional(),
    venue: venueSchema.optional(),
    metadataUri: metadataUriSchema.optional(),
    /** Defaults to draft: a new event is not public until someone opens it. */
    status: eventStatusSchema.default("draft"),
  })
  .strict();

/**
 * `eventId` is declared here only so the handler can refuse it by name. Left
 * out, `.strict()` would reject it as an unrecognised key and the caller would
 * get "unrecognised" for the one field whose immutability is a design decision
 * worth explaining.
 */
const updateEventBodySchema = z
  .object({
    eventId: z.unknown().optional(),
    name: nameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    eventDate: eventDateSchema.nullable().optional(),
    venue: venueSchema.nullable().optional(),
    metadataUri: metadataUriSchema.nullable().optional(),
    status: eventStatusSchema.optional(),
  })
  .strict();

const UPDATABLE_FIELDS = ["name", "description", "eventDate", "venue", "metadataUri", "status"] as const;

type CreateEventBody = z.infer<typeof createEventBodySchema>;
type UpdateEventBody = z.infer<typeof updateEventBodySchema>;
type PagingQuery = z.infer<typeof pagingQuerySchema>;
type AdminListQuery = z.infer<typeof adminListQuerySchema>;
type RegistrationsQuery = z.infer<typeof registrationsQuerySchema>;

// ---------------------------------------------------------------------------
// Admin guard
// ---------------------------------------------------------------------------

/**
 * The admin check, as a plain function of (request, reply).
 *
 * Narrower than fastify's `preHandlerHookHandler` — no `done`, no `this` — so a
 * test can inject three lines and src/api/auth.ts can export a function rather
 * than a hook. It must send its own reply when it refuses.
 */
export type AdminGuard = (request: FastifyRequest, reply: FastifyReply) => unknown;

/**
 * The guard these routes actually run, and it is BELT AND BRACES.
 *
 * src/api/auth.ts already installs an `onRequest` hook on the root instance
 * keyed on the `/admin/api` prefix, so every route below is behind a session
 * before its handler is reached whether or not this preHandler exists. It
 * exists anyway for two reasons: an instance built without `registerAdminAuth`
 * — a focused test, a future refactor — must not serve these routes open, and
 * `requireAdmin` reads `request.admin`, so a request that somehow arrived
 * without going through the prefix hook is refused rather than trusted.
 *
 * `deps.requireAdmin` overrides it. That is the seam tests use, so what they
 * assert about these routes does not depend on session cookies, scrypt or CSRF.
 */
export function adminGuard(deps: ApiDeps): preHandlerHookHandler {
  const guard = deps.requireAdmin ?? requireAdmin;

  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> =>
    // A guard that refuses has already sent its own reply, which is how fastify
    // knows to stop; one that throws lands in the shared error handler.
    guard(request, reply);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerEventRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const events = deps.events;
  // No repository, no routes — the same shape as the demo harness. A route that
  // 500s on every call is worse than a 404 that says the feature is not wired.
  if (!events) return;

  const requireAdmin = adminGuard(deps);

  /**
   * GET /api/events?limit=&offset= — the public registration landing.
   *
   * Open and live only. Drafts are never listed, and the filter is applied by
   * the repository query rather than after the fact, so there is no code path
   * here that has a draft in hand and has to remember to drop it.
   *
   * 200 with the page
   */
  app.get<{ Querystring: PagingQuery }>(
    "/api/events",
    { schema: { querystring: pagingQuerySchema } },
    async (request, reply) => {
      const { limit, offset } = request.query;

      // One query per public status, because EventRepository.list() filters on
      // a single status. Each is asked for `offset + limit` so the merged,
      // sorted page is the same page a single query would have produced.
      const pages = await Promise.all(
        LISTABLE_STATUSES.map((status) => events.list({ status, limit: offset + limit, offset: 0 })),
      );

      const merged = pages
        .flat()
        .sort((a, b) => (a.eventDate ?? "").localeCompare(b.eventDate ?? "") || a.eventId - b.eventId)
        .slice(offset, offset + limit);

      return reply.code(200).send({
        limit,
        offset,
        events: merged.map(toPublicEvent),
      });
    },
  );

  /**
   * GET /api/events/:eventId — one event, for the registration page.
   *
   * 200 | 404 missing, or a draft (deliberately the same answer)
   */
  app.get<{ Params: EventIdParams }>(
    "/api/events/:eventId",
    { schema: { params: eventIdParamsSchema } },
    async (request, reply) => {
      const { eventId } = request.params;
      const event = await events.find(eventId);

      if (!event || !isPubliclyVisible(event)) {
        return sendError(reply, 404, "NOT_FOUND", `No event ${eventId}.`, { eventId });
      }

      return reply.code(200).send({ event: toPublicEvent(event) });
    },
  );

  /**
   * GET /admin/api/events?status=&limit=&offset= — everything, drafts included.
   *
   * Without this an organiser cannot see the draft they just created, since the
   * public list hides it by design.
   *
   * 200 | 401
   */
  app.get<{ Querystring: AdminListQuery }>(
    "/admin/api/events",
    { schema: { querystring: adminListQuerySchema }, preHandler: requireAdmin },
    async (request, reply) => {
      const { limit, offset, status } = request.query;
      const rows = await events.list({ ...(status ? { status } : {}), limit, offset });
      return reply.code(200).send({ limit, offset, events: rows });
    },
  );

  /**
   * POST /admin/api/events — create.
   *
   * 201 | 400 bad input | 401 | 409 that taxon is already an event
   */
  app.post<{ Body: CreateEventBody }>(
    "/admin/api/events",
    { schema: { body: createEventBodySchema }, preHandler: requireAdmin },
    async (request, reply) => {
      const body = request.body;

      const clash = await events.find(body.eventId);
      if (clash) {
        return sendError(
          reply,
          409,
          "DUPLICATE_CLAIM",
          `Event ${body.eventId} already exists (${clash.name}). The event id is the NFTokenTaxon, ` +
            "so reusing it would mix two events' badges into one collection.",
          { eventId: body.eventId },
        );
      }

      // Badges under a taxon with no event row: a previous deployment, or an
      // in-memory index that did not survive a restart. Re-creating the event is
      // the fix in the second case and a mistake in the first, and only an
      // operator can tell which — so it is a loud line, not a refusal.
      if (await events.hasBadges(body.eventId)) {
        request.log.warn(
          { eventId: body.eventId },
          "creating an event whose taxon already has badges on the ledger; those badges will be " +
            "counted as this event's",
        );
      }

      const created = await events.create({
        eventId: body.eventId,
        name: body.name,
        status: body.status,
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.eventDate === undefined ? {} : { eventDate: body.eventDate }),
        ...(body.venue === undefined ? {} : { venue: body.venue }),
        ...(body.metadataUri === undefined ? {} : { metadataUri: body.metadataUri }),
      });

      return reply.code(201).send({ event: created });
    },
  );

  /**
   * PATCH /admin/api/events/:eventId — update the editable fields.
   *
   * 200 | 400 bad input, empty patch, or an attempt to change eventId
   * 401 | 404 | 409 metadataUri change after badges exist
   */
  app.patch<{ Params: EventIdParams; Body: UpdateEventBody }>(
    "/admin/api/events/:eventId",
    { schema: { params: eventIdParamsSchema, body: updateEventBodySchema }, preHandler: requireAdmin },
    async (request, reply) => {
      const { eventId } = request.params;
      const body = request.body;

      // The taxon is the event's identity on the ledger and every badge already
      // minted carries it. There is no rename, only a new event.
      if ("eventId" in body) {
        return sendError(
          reply,
          400,
          "INVALID_INPUT",
          "eventId cannot be changed: it is the NFTokenTaxon carried by every badge minted for " +
            "this event. Create a new event instead.",
          { eventId },
        );
      }

      const existing = await events.find(eventId);
      if (!existing) {
        return sendError(reply, 404, "NOT_FOUND", `No event ${eventId}.`, { eventId });
      }

      // Field by field, and keyed on presence rather than on truthiness: an
      // explicit `null` clears a venue, and `""` is a name the schema already
      // refused. A spread of `body` would carry the rejected `eventId` through.
      const patch: Partial<Omit<EventRecord, "eventId" | "createdAt" | "updatedAt">> = {};
      if ("name" in body) patch.name = body.name;
      if ("description" in body) patch.description = body.description;
      if ("eventDate" in body) patch.eventDate = body.eventDate;
      if ("venue" in body) patch.venue = body.venue;
      if ("metadataUri" in body) patch.metadataUri = body.metadataUri;
      if ("status" in body) patch.status = body.status;

      if (Object.keys(patch).length === 0) {
        return sendError(
          reply,
          400,
          "INVALID_INPUT",
          `Nothing to update. Send at least one of: ${UPDATABLE_FIELDS.join(", ")}.`,
          { eventId },
        );
      }

      // THE ONE EDIT THAT CANNOT BE UNDONE ELSEWHERE. NFTokenMint writes the URI
      // into the token and nothing can rewrite it, so once badges exist this row
      // no longer describes them — changing it would leave the badges already
      // minted pointing at the old artwork and every later badge at the new one,
      // with nothing in the response to say so.
      if ("metadataUri" in patch && (patch.metadataUri ?? null) !== (existing.metadataUri ?? null)) {
        if (await events.hasBadges(eventId)) {
          return sendError(
            reply,
            409,
            "INVALID_INPUT",
            `Cannot change metadataUri for event ${eventId}: badges have already been minted and ` +
              "NFTokenMint.URI is written into the token and immutable. Those badges would keep " +
              "pointing at the old metadata while later ones used the new URI, splitting one event " +
              "across two artworks. Create a new event, or leave the URI alone.",
            {
              eventId,
              currentMetadataUri: existing.metadataUri ?? null,
              requestedMetadataUri: patch.metadataUri ?? null,
              reason: "badges_already_minted",
            },
          );
        }
      }

      const updated = await events.update(eventId, patch);
      return reply.code(200).send({ event: updated });
    },
  );

  /**
   * GET /admin/api/events/:eventId/registrations?limit=&offset=&checkedIn=
   *
   * The desk list. Full records, email included: this is the organiser's own
   * data and it is behind requireAdmin. The attendee-facing view
   * (GET /api/registrations/:id) is the one that must not echo an email.
   *
   * 200 with the page, `total` and `checkedIn` | 400 | 401 | 404
   */
  app.get<{ Params: EventIdParams; Querystring: RegistrationsQuery }>(
    "/admin/api/events/:eventId/registrations",
    {
      schema: { params: eventIdParamsSchema, querystring: registrationsQuerySchema },
      preHandler: requireAdmin,
    },
    async (request, reply) => {
      const registrations = deps.registrations;
      if (!registrations) {
        return sendError(
          reply,
          503,
          "CONFIG_INVALID",
          "No registration store is wired on this server.",
          { eventId: request.params.eventId },
        );
      }

      const { eventId } = request.params;
      const { limit, offset, checkedIn } = request.query;

      const event = await events.find(eventId);
      if (!event) {
        return sendError(reply, 404, "NOT_FOUND", `No event ${eventId}.`, { eventId });
      }

      const [rows, counts] = await Promise.all([
        registrations.listByEvent(eventId, {
          limit,
          offset,
          ...(checkedIn === undefined ? {} : { checkedIn }),
        }),
        registrations.countByEvent(eventId),
      ]);

      return reply.code(200).send({
        eventId,
        total: counts.total,
        checkedIn: counts.checkedIn,
        limit,
        offset,
        registrations: rows,
      });
    },
  );
}
