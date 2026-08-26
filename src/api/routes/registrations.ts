/**
 * Registration: an attendee proves a wallet before the event, so the desk
 * already knows them when they walk in.
 *
 * THE ADDRESS IS NEVER TAKEN FROM THE REQUEST. Not from the body, not from a
 * query parameter, not from a header. It is read off a Xaman SignIn payload
 * that this server created and then resolved against Xaman itself, and the
 * route hands the resolved value straight to the repository without ever
 * consulting what the caller sent. A typed address is a claim; a signed SignIn
 * is proof, and the difference is not cosmetic:
 *
 *   - it stops someone registering a wallet that is not theirs;
 *   - it stops a typo. Badges are soulbound (CLAUDE.md) — minted with
 *     `tfTransferable` unset, they can never be moved — so a badge minted to a
 *     mistyped address is gone. There is no transfer, only a burn.
 *
 * Everything else in this file is bookkeeping around that one rule.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { XrplLayerError } from "../../errors.js";
import type { EventRecord, EventStatus, RegistrationRecord } from "../../types.js";
import {
  MemoryConsumedSignIns,
  NullSignInService,
  type ConsumedSignIns,
  type SignInService,
} from "../../xaman/signin.js";
import type { ApiDeps } from "../deps.js";
import { eventIdParamsSchema, sendError, type EventIdParams } from "../http-errors.js";
import { toPublicEvent, type PublicEvent } from "./events.js";

/**
 * Statuses that accept a new registration.
 *
 * `live` is in the list because a walk-up who was never on the roster is the
 * exact person this flow is for — the desk still needs a proven address for
 * them. `draft` and `closed` are not: a draft is not public at all, and a
 * closed event has nothing left to register for.
 */
const REGISTRABLE_STATUSES: readonly EventStatus[] = ["open", "live"];

/**
 * Creating a sign-in payload calls Xaman, on a public, unauthenticated route.
 * Ten a minute per IP is generous for a person filling in a form and cheap
 * insurance for our side of somebody else's rate limit.
 */
const SIGNIN_CREATE_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;

/**
 * The registration page polls this while the attendee finds their phone. Wide
 * enough for a poll every two seconds for the whole of a payload's life,
 * narrow enough that it is not a free proxy onto the Xaman API.
 */
const SIGNIN_POLL_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

/** Also resolves a payload against Xaman, and also writes a row. */
const REGISTER_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;

/** Long enough for "Ada Lovelace (Analytical Engines Ltd)", short enough for a badge list. */
const MAX_DISPLAY_NAME = 120;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const returnUrlSchema = z.object({
  app: z.string().url().optional(),
  web: z.string().url().optional(),
});

/** `.nullish()`: a POST with nothing to say is the normal case here. */
const signInBodySchema = z.object({ returnUrl: returnUrlSchema.optional() }).nullish();

const signInUuidParamsSchema = z.object({ uuid: z.uuid() });

/**
 * Note what is NOT here: `address`.
 *
 * Unknown keys are stripped rather than rejected, so a caller that sends one
 * gets a successful registration of the address they actually proved — not a
 * 400 that invites them to try again with better-formed lying. The route's
 * preValidation hook logs that it saw one and ignored it.
 */
const registerBodySchema = z.object({
  /** The payload THIS server created. Its resolution is the only source of the address. */
  signinUuid: z.uuid(),
  /**
   * Both required.
   *
   * Neither is needed to MINT anything — the wallet is the whole of what a
   * badge depends on, and nothing in the claim or verify path reads either of
   * these. They are required because the EVENT needs them: a door cannot be
   * run off a list of wallet addresses, and an organiser who cannot reach an
   * attendee cannot tell them their badge is waiting.
   */
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME),
  email: z.email().max(254),
});

const registrationIdParamsSchema = z.object({ id: z.string().min(1).max(64) });

type SignInBody = z.infer<typeof signInBodySchema>;
type SignInUuidParams = z.infer<typeof signInUuidParamsSchema>;
type RegisterBody = z.infer<typeof registerBodySchema>;
type RegistrationIdParams = z.infer<typeof registrationIdParamsSchema>;

// ---------------------------------------------------------------------------
// What an attendee is shown
// ---------------------------------------------------------------------------

/**
 * The attendee-facing view of a registration.
 *
 * No email — they typed it, we do not need to read it back to them, and this
 * view is reachable by anyone holding the id. No `signinPayloadUuid`: it is a
 * one-shot credential, and echoing it would put a spent-but-replayable value in
 * a page and a browser history. No `addressProof`, no timestamps beyond the two
 * that mean something to a person.
 */
export interface RegistrationView {
  id: string;
  event: PublicEvent | null;
  address: string;
  displayName: string | null;
  registeredAt: Date | null;
  checkedInAt: Date | null;
}

export function toRegistrationView(
  registration: RegistrationRecord,
  event: EventRecord | null,
): RegistrationView {
  return {
    id: registration.id,
    event: event ? toPublicEvent(event) : null,
    address: registration.address,
    displayName: registration.displayName ?? null,
    registeredAt: registration.registeredAt ?? null,
    checkedInAt: registration.checkedInAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerRegistrationRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const events = deps.events;
  const registrations = deps.registrations;
  // Same rule as the event routes: no store, no routes. A 404 that says the
  // feature is not wired beats a 500 on every call.
  if (!events || !registrations) return;

  /**
   * Absent keys are a supported mode for the server as a whole — it must boot
   * and serve claims, verification and the roster without Xaman — so the
   * fallback is the Null service, which fails loudly on use and only on use.
   */
  const signIn: SignInService = deps.signIn ?? new NullSignInService();

  /**
   * One ticket book per server instance. See ConsumedSignIns: a signed payload
   * answers `signed: true` forever, so the uuid has to be spent exactly once.
   */
  const consumed: ConsumedSignIns = new MemoryConsumedSignIns();

  const limits = deps.rateLimit;
  const rateLimitsOff = limits?.enabled === false;
  const signinCreateLimit = rateLimitsOff ? false : (limits?.signin ?? SIGNIN_CREATE_RATE_LIMIT);
  const signinPollLimit = rateLimitsOff ? false : (limits?.signinPoll ?? SIGNIN_POLL_RATE_LIMIT);
  const registerLimit = rateLimitsOff ? false : (limits?.registration ?? REGISTER_RATE_LIMIT);

  /** The event, if it is one a stranger may register for. */
  const findRegistrableEvent = async (eventId: number): Promise<EventRecord | null> => {
    const event = await events.find(eventId);
    if (!event || !REGISTRABLE_STATUSES.includes(event.status)) return null;
    return event;
  };

  /**
   * POST /api/events/:eventId/registrations/signin — start the proof.
   *
   * Creates a Xaman SignIn payload and hands back the QR code, the deeplink and
   * the websocket. Costs the attendee nothing: a SignIn is not a transaction.
   *
   * 201 payload created | 400 bad input | 404 no such open event
   * 429 rate limited | 500 Xaman is not configured | 502 Xaman is unreachable
   */
  app.post<{ Params: EventIdParams; Body: SignInBody }>(
    "/api/events/:eventId/registrations/signin",
    {
      schema: { params: eventIdParamsSchema, body: signInBodySchema },
      config: { rateLimit: signinCreateLimit },
    },
    async (request, reply) => {
      const { eventId } = request.params;

      const event = await findRegistrableEvent(eventId);
      if (!event) {
        return sendError(
          reply,
          404,
          "NOT_FOUND",
          `No event ${eventId} is open for registration.`,
          { eventId },
        );
      }

      const returnUrl = request.body?.returnUrl;
      const handles = await signIn.create({
        eventId,
        ...(returnUrl && (returnUrl.app || returnUrl.web) ? { returnUrl } : {}),
      });

      request.log.info({ eventId, uuid: handles.uuid }, "sign-in payload created for registration");

      return reply.code(201).send(handles);
    },
  );

  /**
   * GET /api/registrations/signin/:uuid — has it been signed yet?
   *
   * The page polls this until `signed` or `rejected`. `address` appears only on
   * a signed payload, and only after the service has validated it — see
   * XummSignInService.resolve(). The uuid is a 128-bit value known only to the
   * browser that asked for it, and it is the whole authorisation for this read.
   *
   * 200 status | 400 not a uuid | 404 no such payload | 429 | 500 not configured
   */
  app.get<{ Params: SignInUuidParams }>(
    "/api/registrations/signin/:uuid",
    { schema: { params: signInUuidParamsSchema }, config: { rateLimit: signinPollLimit } },
    async (request, reply) => {
      const { uuid } = request.params;
      const resolution = await signIn.resolve(uuid);

      return reply.code(200).send({
        uuid,
        resolved: resolution.resolved,
        signed: resolution.signed,
        rejected: resolution.rejected,
        // Present only when signed. There is no branch of resolve() that
        // returns an address without a signature behind it.
        ...(resolution.account ? { address: resolution.account } : {}),
      });
    },
  );

  /**
   * POST /api/events/:eventId/registrations — finish the proof, store the row.
   *
   * 201 registered | 400 unsigned, rejected or malformed | 404 no such open event
   * 409 the sign-in was already used, or this address is already registered
   * 429 | 500 Xaman is not configured | 502 Xaman is unreachable
   */
  app.post<{ Params: EventIdParams; Body: RegisterBody }>(
    "/api/events/:eventId/registrations",
    {
      schema: { params: eventIdParamsSchema, body: registerBodySchema },
      config: { rateLimit: registerLimit },
      // Runs BEFORE validation, so it sees the body as it was sent. Nothing it
      // finds changes the outcome; it exists so that an integration quietly
      // sending an address leaves a trace instead of appearing to work.
      preValidation: async (request) => {
        const raw = request.body;
        if (raw && typeof raw === "object" && "address" in raw) {
          request.log.warn(
            { url: request.url },
            "ignoring an address in the registration body: the address comes from the resolved " +
              "Xaman sign-in and nowhere else",
          );
        }
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const { signinUuid, displayName, email } = request.body;

      const event = await findRegistrableEvent(eventId);
      if (!event) {
        return sendError(
          reply,
          404,
          "NOT_FOUND",
          `No event ${eventId} is open for registration.`,
          { eventId },
        );
      }

      // 1. THE ONLY SOURCE OF THE ADDRESS. Resolved server-side against Xaman;
      //    the request body cannot influence what comes back beyond naming
      //    which payload to look up.
      const resolution = await signIn.resolve(signinUuid);

      if (!resolution.signed || !resolution.account) {
        return sendError(
          reply,
          400,
          "INVALID_INPUT",
          resolution.rejected
            ? "That Xaman sign-in was declined or expired. Start a new one and approve it in Xaman."
            : "That Xaman sign-in has not been signed yet. Approve it in Xaman, then submit again.",
          { signinUuid, resolved: resolution.resolved, rejected: resolution.rejected },
        );
      }

      const address = resolution.account;

      // 2. REPLAY. A signed payload stays signed, so Xaman will keep answering
      //    `signed: true` for this uuid forever. One registration per proof.
      if (!(await consumed.claim(signinUuid))) {
        return sendError(
          reply,
          409,
          "DUPLICATE_CLAIM",
          "That Xaman sign-in has already been used to register. Start a new sign-in.",
          { eventId, signinUuid },
        );
      }

      try {
        const existing = await registrations.findByAddress(eventId, address);
        if (existing) {
          // The durable half of the replay guard: the same uuid coming back
          // after a restart, when the in-process ticket book has forgotten it.
          if (existing.signinPayloadUuid === signinUuid) {
            return sendError(
              reply,
              409,
              "DUPLICATE_CLAIM",
              "That Xaman sign-in has already been used to register. Start a new sign-in.",
              { eventId, signinUuid },
            );
          }

          // Not an error worth a 500 and not a lie worth a 200: re-registering
          // is a normal thing a person does when they lose the confirmation
          // link. Hand back the row they already have.
          return reply.code(409).send({
            error: {
              code: "DUPLICATE_CLAIM",
              message: `${address} is already registered for event ${eventId}.`,
            },
            registration: toRegistrationView(existing, event),
          });
        }

        const created = await registrations.create({
          eventId,
          address,
          // The whole point of the flow. Never "self_declared" on this route —
          // there is no path through it that has not been through Xaman.
          addressProof: "xaman_signin",
          signinPayloadUuid: signinUuid,
          ...(displayName === undefined ? {} : { displayName }),
          ...(email === undefined ? {} : { email }),
        });

        request.log.info(
          { eventId, address, registrationId: created.id },
          "registration created from a verified Xaman sign-in",
        );

        return reply.code(201).send({ registration: toRegistrationView(created, event) });
      } catch (err) {
        // Lost a race against a concurrent registration for the same address:
        // the unique index did the job this route was trying to do.
        if (err instanceof XrplLayerError && err.code === "DUPLICATE_CLAIM") {
          const existing = await registrations.findByAddress(eventId, address);
          if (existing) {
            return reply.code(409).send({
              error: {
                code: "DUPLICATE_CLAIM",
                message: `${address} is already registered for event ${eventId}.`,
              },
              registration: toRegistrationView(existing, event),
            });
          }
        }

        // Nothing was written, so the proof was not spent. Hand the uuid back
        // rather than making someone sign again for our failure.
        await consumed.release(signinUuid);
        throw err;
      }
    },
  );

  /**
   * GET /api/registrations/:id — the attendee's own confirmation view.
   *
   * 200 | 404
   */
  app.get<{ Params: RegistrationIdParams }>(
    "/api/registrations/:id",
    { schema: { params: registrationIdParamsSchema } },
    async (request, reply) => {
      const { id } = request.params;

      const registration = await registrations.findById(id);
      if (!registration) {
        return sendError(reply, 404, "NOT_FOUND", "No such registration.", { id });
      }

      const event = await events.find(registration.eventId);
      return reply.code(200).send({ registration: toRegistrationView(registration, event) });
    },
  );
}
