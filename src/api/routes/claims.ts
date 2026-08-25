/**
 * Claim initiation and confirmation (brief 5.2, 5.3, 5.4, 8 step 5).
 *
 * This is the only route file that spends the issuer's XRP, and the only one
 * that can lock its owner reserve. Two rules follow from that and everything
 * else here is detail:
 *
 *   1. THE SLOT IS TAKEN BEFORE ANYTHING IS MINTED. The attendance table is
 *      written after the attendee signs, so it cannot dedupe the mint — six
 *      unconfirmed POSTs for one address used to produce six badges, six open
 *      NFTokenOffers and zero rows. At 0.2 XRP locked per open offer (brief 7)
 *      that is 1 XRP a minute at this route's own limit, against a 10 XRP
 *      float. `ClaimRepository.open()` is the gate; it is atomic, so the
 *      concurrent version of the same attack loses too.
 *   2. THE OFFER ID IS PERSISTED AT CLAIM TIME. An offer nobody can name is an
 *      offer nobody can cancel, and 0.2 XRP stays locked forever. See
 *      scripts/reap-offers.ts.
 */
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ValidationError, XrplLayerError } from "../../errors.js";
import {
  MAX_URI_BYTES,
  type AttendanceRecord,
  type ClaimRecord,
  type EventId,
  type VerifyClaimResult,
} from "../../types.js";
import type { ApiDeps } from "../deps.js";
import {
  addressSchema,
  eventIdParamsSchema,
  eventIdSchema,
  offerIdSchema,
  sendError,
  txHashSchema,
  type EventIdParams,
} from "../http-errors.js";
import { CLAIM_PAYLOAD_EXPIRE_MINUTES, buildAcceptOfferTxjson } from "../../xaman/payloads.js";

/**
 * Tighter than the global limit on purpose. Every accepted request here burns a
 * mint fee, locks 0.2 XRP in an NFTokenOffer until the attendee accepts it, and
 * may hand out SPONSOR_AMOUNT_XRP to an address the caller chose (brief 5.4:
 * "anyone who can hit it with an arbitrary address can drain the issuer wallet
 * 1.5 XRP at a time"). Reads are cheap and can stay on the global bucket; this
 * one is the wallet, and it is also on the mainnet cutover checklist (brief 9).
 */
const CLAIM_RATE_LIMIT = { max: 5, timeWindow: "1 minute" } as const;

/** How long a claim slot is held before scripts/reap-offers.ts may reclaim it. */
const CLAIM_SLOT_TTL_MS = CLAIM_PAYLOAD_EXPIRE_MINUTES * 60_000;

/**
 * How long `deps.badgeUris.resolve()` may take before the claim gives up on it.
 *
 * Ten seconds because it is the shortest bound that does not fail a pin that
 * was merely going to be slow: a Pinata `pinJSONToIPFS` for a few KB of badge
 * art is normally well under a second, and its own rate-limited retries are the
 * only thing that pushes it into seconds. Anything longer is not patience, it
 * is a volunteer holding a phone at a desk while a socket that is never going
 * to answer stays open. Overridable via `ApiDeps.badgeUriTimeoutMs`.
 */
const BADGE_URI_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const claimBodySchema = z.object({
  address: addressSchema,
  /**
   * Where the badge metadata already lives. Byte length is enforced properly by
   * mint(); this is the cheap HTTP-edge check.
   */
  metadataUri: z.string().min(1).max(MAX_URI_BYTES).optional(),
  badgeName: z.string().min(1).max(120).optional(),
  returnUrl: z.object({ app: z.string().url().optional(), web: z.string().url().optional() }).optional(),
});

const confirmParamsSchema = z.object({ eventId: eventIdSchema, offerId: offerIdSchema });
const confirmBodySchema = z.object({ address: addressSchema, txHash: txHashSchema });

type ClaimParams = EventIdParams;
type ClaimBody = z.infer<typeof claimBodySchema>;
type ConfirmParams = z.infer<typeof confirmParamsSchema>;
type ConfirmBody = z.infer<typeof confirmBodySchema>;

// ---------------------------------------------------------------------------
// The one way into the attendance index
// ---------------------------------------------------------------------------

export interface RecordClaimInput {
  eventId: EventId;
  address: string;
  txHash: string;
  /**
   * The offer id the CALLER says this claim was for — a path parameter, or a
   * field in an unauthenticated webhook body.
   *
   * A HINT, NEVER A VALUE TO STORE. It is used to log a mismatch and nothing
   * else; what gets persisted is `VerifyClaimResult.sellOfferId`, read off the
   * accept transaction on the chain.
   */
  claimedOfferId?: string;
}

export interface RecordClaimOutcome {
  verification: VerifyClaimResult;
  record?: AttendanceRecord;
  alreadyRecorded: boolean;
}

/**
 * Mark the claim slot spent. Best effort on purpose: the attendance row is the
 * durable fact and it is already written by the time this runs. A slot left
 * pending is picked up by the reaper, which finds the offer already accepted
 * and closes the row out — noisy, not wrong.
 */
async function markClaimSpent(
  deps: ApiDeps,
  claim: ClaimRecord | null,
  log?: FastifyBaseLogger,
): Promise<void> {
  if (!claim || claim.status === "claimed") return;
  try {
    await deps.claims.markClaimed(claim.id);
  } catch (err) {
    log?.warn(
      { err, claimId: claim.id, eventId: claim.eventId },
      "attendance was recorded but the claim slot could not be marked claimed",
    );
  }
}

/**
 * Verify against the chain, then — and only then — index it.
 *
 * A client saying "I claimed it" is not evidence that they did, and neither is
 * a webhook body. The five assertions in brief 6.4 are the evidence. Shared by
 * POST .../confirm and the Xaman webhook so there is exactly one write path.
 */
export async function verifyThenRecord(
  deps: ApiDeps,
  input: RecordClaimInput,
  log?: FastifyBaseLogger,
): Promise<RecordClaimOutcome> {
  const { eventId, address, txHash } = input;

  const verification = await deps.chain.verifyClaim(deps.gateway, { address, eventId, txHash });
  if (!verification.attended) return { verification, alreadyRecorded: false };

  const claim = await deps.claims.find(eventId, address);

  // The offer id we store comes off the chain, never off the caller. A forged
  // webhook that names someone else's offer gets logged and dropped; the
  // fallback is the id we recorded ourselves when we created the offer.
  if (
    input.claimedOfferId &&
    verification.sellOfferId &&
    input.claimedOfferId.toUpperCase() !== verification.sellOfferId.toUpperCase()
  ) {
    log?.warn(
      { eventId, address, txHash, chainOfferId: verification.sellOfferId },
      "the caller named a different offer than the accept transaction consumed; using the chain",
    );
  }
  const offerId = verification.sellOfferId ?? claim?.offerId ?? null;

  const existing = await deps.attendance.findByEventAndAddress(eventId, address);
  if (existing) {
    await markClaimSpent(deps, claim, log);
    return { verification, record: existing, alreadyRecorded: true };
  }

  const nftokenId = verification.nftokenId;
  if (!nftokenId) {
    throw new XrplLayerError(
      "LEDGER_QUERY_FAILED",
      "Verification passed but the ledger returned no NFTokenID for the accept transaction.",
      { txHash, eventId },
    );
  }

  // Same treatment as the missing NFTokenID above, and for the same reason.
  // `ledger_index` is NOT NULL in 001_attendance.sql; defaulting it to 0 wrote a
  // row that looks indexed, reads back as attendance, and points at a ledger
  // that has never existed. A hollow row is worse than a 502.
  const { ledgerIndex } = verification;
  if (typeof ledgerIndex !== "number" || !Number.isInteger(ledgerIndex) || ledgerIndex <= 0) {
    throw new XrplLayerError(
      "LEDGER_QUERY_FAILED",
      "Verification passed but the ledger returned no ledger index for the accept transaction. " +
        "Refusing to index attendance without one.",
      { txHash, eventId, ledgerIndex },
    );
  }

  try {
    const record = await deps.attendance.insert({
      eventId,
      address,
      nftokenId,
      offerId,
      txHash,
      ledgerIndex,
    });
    await markClaimSpent(deps, claim, log);
    return { verification, record, alreadyRecorded: false };
  } catch (err) {
    // A confirm call and a webhook can land at the same instant. The unique
    // index on (event_id, address) is what actually enforces one-per-attendee;
    // losing that race is success, not an error.
    if (err instanceof XrplLayerError && err.code === "DUPLICATE_CLAIM") {
      const record = await deps.attendance.findByEventAndAddress(eventId, address);
      await markClaimSpent(deps, claim, log);
      return { verification, ...(record ? { record } : {}), alreadyRecorded: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Claim-time helpers
// ---------------------------------------------------------------------------

/** The rate-limit bucket for one attendee address, independent of source IP. */
function addressRateLimitKey(request: FastifyRequest): string {
  const body = request.body as { address?: unknown } | undefined;
  return `claim-address:${typeof body?.address === "string" ? body.address : "unknown"}`;
}

/**
 * Xaman is a convenience on top of the accept payload, never a requirement. The
 * badge is minted and offered by the time this runs, so a Xaman outage must not
 * fail the claim.
 */
async function xamanHandles(
  deps: ApiDeps,
  log: FastifyBaseLogger,
  params: { offerId: string; address: string; eventId: EventId; badgeName?: string; returnUrl?: ClaimBody["returnUrl"] },
): Promise<Record<string, unknown> | undefined> {
  if (!deps.xaman) return undefined;
  try {
    const created = await deps.xaman.createClaimRequest({
      offerId: params.offerId,
      attendeeAddress: params.address,
      eventId: params.eventId,
      ...(params.badgeName ? { badgeName: params.badgeName } : {}),
      ...(params.returnUrl ? { returnUrl: params.returnUrl } : {}),
    });
    return { ...created };
  } catch (err) {
    log.warn({ err, eventId: params.eventId }, "Xaman sign request failed; returning the accept payload only");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Which artwork this badge points at
// ---------------------------------------------------------------------------

/** What one claim decided to mint, and how it got there. */
interface ResolvedBadgeUri {
  /** Goes straight into NFTokenMint.URI. Points at metadata JSON, not an image. */
  uri: string;
  /**
   * Present only when the per-attendee resolver produced the URI. `true` means
   * the artwork was pinned during this request rather than before the event —
   * the slow path, and the one a volunteer console should be able to show.
   */
  pinnedOnDemand?: boolean;
}

/**
 * Bound a promise that has no bound of its own.
 *
 * `BadgeUriResolver.resolve()` takes no timeout and an HTTP call to a third
 * party has no natural one, so a Pinata socket that never answers would
 * otherwise hold this claim open until something further out gives up. A
 * non-positive `ms` disables the wrapper.
 */
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return work;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });

  // Promise.race subscribes to `work` immediately, so a rejection that arrives
  // after the timeout is already handled and never surfaces as an unhandled
  // rejection. The pending call itself is simply abandoned — there is nothing
  // to cancel behind the interface.
  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * `metadataUriForEvent`, with a throw treated as "no fallback" rather than as
 * the error the caller sees.
 *
 * Only used on the recovery path. The failure worth reporting there is the
 * resolver's; losing it behind a second failure in the safety net would report
 * the wrong one.
 */
async function eventWideUri(
  deps: ApiDeps,
  log: FastifyBaseLogger,
  eventId: EventId,
): Promise<string | undefined> {
  try {
    return (await deps.metadataUriForEvent?.(eventId)) ?? undefined;
  } catch (err) {
    log.warn({ err, eventId }, "the event-wide metadata URI could not be read either");
    return undefined;
  }
}

/**
 * The URI this badge is minted with, in precedence order:
 *
 *   1. `metadataUri` in the request body. The caller pinned it themselves and
 *      named it; there is nothing to resolve and nothing to fail.
 *   2. `deps.badgeUris.resolve({ eventId, address })` — per-attendee artwork,
 *      looked up from the roster pinned before the event, or pinned on demand
 *      for a walk-up who was never on it.
 *   3. `deps.metadataUriForEvent(eventId)` — one image for the whole event.
 *   4. None of the above: a 400, because a mint needs a URI.
 *
 * 2 IS THE ONLY STEP THAT CAN FAIL SLOWLY, and it sits between an attendee and
 * their badge. Two rules cover that, in this order:
 *
 *   - it is bounded (see withTimeout), so a hung Pinata costs one attendee
 *     `badgeUriTimeoutMs` rather than the life of the socket;
 *   - a failure — thrown or timed out — falls through to 3 with a warning when
 *     3 is configured. A generic badge beats no badge at a live desk. With no
 *     fallback there is nothing to mint, and the caller gets a 502 that names
 *     Pinata rather than a shrug.
 *
 * Every throw out of here happens inside the route's one try, whose catch
 * releases the claim slot: a Pinata outage must not cost the attendee their
 * slot on top of their artwork.
 */
async function resolveBadgeUri(
  deps: ApiDeps,
  log: FastifyBaseLogger,
  input: { eventId: EventId; address: string; requestedUri?: string },
): Promise<ResolvedBadgeUri> {
  const { eventId, address, requestedUri } = input;

  // 1. The request said where the metadata lives. Unchanged behaviour.
  if (requestedUri) return { uri: requestedUri };

  // 2. Per-attendee artwork.
  if (deps.badgeUris) {
    const timeoutMs = deps.badgeUriTimeoutMs ?? BADGE_URI_TIMEOUT_MS;
    try {
      const badge = await withTimeout(
        deps.badgeUris.resolve({ eventId, address }),
        timeoutMs,
        () =>
          new XrplLayerError(
            "PIN_FAILED",
            `Resolving badge artwork took longer than ${timeoutMs}ms.`,
            { eventId, address, timeoutMs },
          ),
      );
      return { uri: badge.metadataUri, pinnedOnDemand: badge.pinnedOnDemand };
    } catch (err) {
      const fallback = await eventWideUri(deps, log, eventId);

      if (fallback) {
        log.warn(
          { err, eventId, address, fallbackUri: fallback },
          "per-attendee badge artwork could not be resolved (Pinata); minting the event-wide " +
            "badge instead so the claim still completes",
        );
        return { uri: fallback };
      }

      // Nothing generic to fall back to. 502 rather than 500: this is an
      // upstream failing, the caller can retry, and an operator reading it
      // needs to know it was Pinata and not the ledger. The upstream detail
      // rides on `cause` — the log serializer follows and scrubs it, the
      // response body never serialises it, and a third-party message is not
      // something to echo to an attendee.
      const failure = new XrplLayerError(
        "PIN_FAILED",
        `Could not resolve badge artwork for ${address} on event ${eventId}: the IPFS pin ` +
          "(Pinata) did not complete, and no event-wide badge is configured to fall back to. " +
          "Nothing was minted and the claim slot has been released — retry, or send an explicit " +
          "`metadataUri`.",
        { eventId, address },
      );
      failure.cause = err;
      throw failure;
    }
  }

  // 3. One image for the whole event.
  const shared = await deps.metadataUriForEvent?.(eventId);
  if (shared) return { uri: shared };

  // 4. Nothing to mint.
  throw new ValidationError(
    "INVALID_INPUT",
    "No badge metadata URI for this claim: send `metadataUri`, or configure a per-event " +
      "default. Routes do not pin metadata themselves.",
    { eventId },
  );
}

/**
 * Hand the slot back after a failed claim.
 *
 * Without this a transient mint failure locks the attendee out until the slot
 * expires — they take the blame for our 502. It must run on every throw, which
 * is why the whole spend sits inside one try and this is its catch.
 */
async function releaseClaimSlot(
  deps: ApiDeps,
  log: FastifyBaseLogger,
  claim: ClaimRecord,
  context: { orphanedNftokenId?: string },
): Promise<void> {
  if (context.orphanedNftokenId) {
    // The badge exists and nothing is offering it. Nobody is locked out and no
    // offer reserve is held, but the issuer is now holding a stray token, so an
    // operator needs the id to reconcile or burn it.
    log.error(
      {
        claimId: claim.id,
        eventId: claim.eventId,
        address: claim.address,
        nftokenId: context.orphanedNftokenId,
      },
      "minted a badge but failed to offer it; the badge is orphaned with the issuer",
    );
  }

  try {
    await deps.claims.delete(claim.id);
  } catch (err) {
    log.error(
      { err, claimId: claim.id, eventId: claim.eventId, address: claim.address },
      "could not release the claim slot after a failed claim; this address cannot retry until it expires",
    );
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerClaimRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const rateLimit =
    deps.rateLimit?.enabled === false ? false : (deps.rateLimit?.claim ?? CLAIM_RATE_LIMIT);

  /**
   * A SECOND bucket, keyed on the attendee address rather than the source IP.
   *
   * The IP bucket alone is the wrong shape in both directions: behind an
   * ingress every attendee shares one, and an attacker with a thousand source
   * addresses has a thousand. Address keying is the half that does not move —
   * whoever is hammering `rXYZ`, they are hammering `rXYZ`.
   *
   * `createRateLimit` rather than the route hook because the plugin marks a
   * request as rate-limited once and skips the second hook. Absent when the
   * plugin is not registered at all (tests, `rateLimit.enabled === false`).
   */
  const addressLimiter =
    rateLimit === false || typeof app.createRateLimit !== "function"
      ? undefined
      : app.createRateLimit({ ...rateLimit, keyGenerator: addressRateLimitKey });

  const enforceAddressLimit = addressLimiter
    ? async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
        const outcome = await addressLimiter(request);
        if (outcome.isAllowed || !outcome.isExceeded) return undefined;
        reply.header("retry-after", String(outcome.ttlInSeconds));
        return sendError(
          reply,
          429,
          "RATE_LIMITED",
          `Too many claim attempts for this address. Retry in ${outcome.ttlInSeconds}s.`,
        );
      }
    : undefined;

  /**
   * POST /events/:eventId/claims — mint a badge and offer it to one attendee.
   *
   * 201 minted and offered | 200 a claim was already open, same offer returned
   * 400 bad input | 403/429 sponsorship refused or rate limited
   * 409 already attended, claim in flight, or wallet not activated
   * 502 ledger trouble
   */
  app.post<{ Params: ClaimParams; Body: ClaimBody }>(
    "/events/:eventId/claims",
    {
      schema: { params: eventIdParamsSchema, body: claimBodySchema },
      config: { rateLimit },
      ...(enforceAddressLimit ? { preHandler: enforceAddressLimit } : {}),
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const { address, metadataUri, badgeName, returnUrl } = request.body;

      // 1. Already attended? Attendance is one badge per address per event.
      //    Kept alongside the claim slot below: this is the check that catches
      //    an attendee who finished the flow, possibly on a previous run of
      //    this process, and whose claim slot is long gone.
      const existing = await deps.attendance.findByEventAndAddress(eventId, address);
      if (existing) {
        // The existing record rides alongside the error rather than inside
        // `details`: it is a domain object the caller can use as-is, not
        // diagnostics about a failure.
        return reply.code(409).send({
          error: {
            code: "DUPLICATE_CLAIM",
            message: `${address} already has a badge for event ${eventId}.`,
          },
          record: existing,
        });
      }

      // 2. TAKE THE SLOT. Atomic, and before a single drop is spent. Everything
      //    below this line is guarded by it.
      const expiresAt = new Date(Date.now() + CLAIM_SLOT_TTL_MS);
      const claim = await deps.claims.open({ eventId, address, expiresAt });

      if (!claim) {
        const held = await deps.claims.find(eventId, address);

        // The common case: the attendee lost the QR code, refreshed, or their
        // client retried. Hand back the offer that already exists. Minting a
        // second badge here is precisely the bug.
        if (held?.status === "pending" && held.offerId) {
          const accept = buildAcceptOfferTxjson({
            offerId: held.offerId,
            attendeeAddress: address,
            ...(deps.config.sourceTag === undefined ? {} : { sourceTag: deps.config.sourceTag }),
          });
          const xaman = await xamanHandles(deps, request.log, {
            offerId: held.offerId,
            address,
            eventId,
            ...(badgeName ? { badgeName } : {}),
            ...(returnUrl ? { returnUrl } : {}),
          });

          request.log.info(
            { eventId, address, offerId: held.offerId },
            "claim retried; returning the offer that is already open",
          );

          return reply.code(200).send({
            eventId,
            address,
            offerId: held.offerId,
            ...(held.nftokenId ? { nftokenId: held.nftokenId } : {}),
            accept,
            reusedExistingOffer: true,
            ...(xaman ? { xaman } : {}),
          });
        }

        if (held?.status === "pending") {
          // A concurrent request holds the slot and has not produced an offer
          // yet. There is nothing to hand back and nothing worth minting.
          return sendError(
            reply,
            409,
            "DUPLICATE_CLAIM",
            `A claim for ${address} on event ${eventId} is already in progress. Retry in a moment.`,
            { eventId, address },
          );
        }

        if (held?.status === "claimed") {
          return sendError(
            reply,
            409,
            "DUPLICATE_CLAIM",
            `${address} already has a badge for event ${eventId}.`,
            { eventId, address },
          );
        }

        // Abandoned (the reaper cancelled the offer), or the row disappeared
        // between open() and find(). Either way this process must not mint.
        return sendError(
          reply,
          409,
          "DUPLICATE_CLAIM",
          `The claim for ${address} on event ${eventId} was closed out and cannot be reopened here. ` +
            "An organiser can clear it.",
          { eventId, address, status: held?.status ?? "unknown" },
        );
      }

      let offerId: string;
      let nftokenId: string;
      let mintedNftokenId: string | undefined;
      let pinnedOnDemand: boolean | undefined;

      try {
        // 3. An unactivated address cannot receive an NFT (brief 5.4).
        const activated = await deps.chain.accountExists(deps.gateway, address);
        if (!activated) {
          if (!deps.config.sponsor.enabled) {
            throw new XrplLayerError(
              "ACCOUNT_NOT_FOUND",
              `${address} does not exist on the ledger yet. XRPL accounts are activated by an ` +
                "initial payment of at least the base reserve (1 XRP), so send at least that much " +
                "to the address from an exchange or another wallet, then claim again.",
              { address, baseReserveXrp: "1", sponsorshipEnabled: false },
            );
          }
          // sponsorWallet() owns the guards: one sponsorship per address per
          // event plus the daily cap. It throws SponsorshipDeniedError (403, or
          // 429 for the cap) rather than quietly spending.
          const sponsorship = await deps.chain.sponsorWallet(deps.gateway, {
            address,
            eventId,
            config: deps.config.sponsor,
            ledger: deps.sponsorLedger,
          });
          request.log.info(
            { address, eventId, sponsored: sponsorship.sponsored, amountXrp: sponsorship.amountXrp },
            "sponsorship checked",
          );
        }

        // 4. Decide what artwork this badge points at, then mint, then create
        //    the offer. resolveBadgeUri() owns the precedence and the Pinata
        //    failure modes; it is INSIDE this try because the resolver can pin
        //    on demand, and a pin that fails must cost the attendee neither
        //    their badge nor their claim slot.
        const badge = await resolveBadgeUri(deps, request.log, {
          eventId,
          address,
          ...(metadataUri ? { requestedUri: metadataUri } : {}),
        });
        const uri = badge.uri;
        pinnedOnDemand = badge.pinnedOnDemand;

        const minted = await deps.chain.mint(deps.gateway, { eventId, uri });
        mintedNftokenId = minted.nftokenId;
        await deps.claims.attach(claim.id, { nftokenId: minted.nftokenId });

        // Lazily, one offer per attendee at claim time. Brief 7: an NFTokenOffer
        // locks 0.2 XRP in the issuer's account for as long as it is open, so
        // pre-creating N offers locks 0.2 * N XRP simultaneously — 20 XRP for 100
        // attendees, against a recommended 10 XRP float. That is the trap this
        // design avoids: with serial claims the peak lock is a handful of offers.
        const offer = await deps.chain.createClaimOffer(deps.gateway, {
          nftokenId: minted.nftokenId,
          destination: address, // never optional: without it anyone can take the badge
        });

        // Durable BEFORE the response goes out. An offer whose id only ever
        // existed in a reply body is 0.2 XRP that nothing can ever release.
        await deps.claims.attach(claim.id, { offerId: offer.offerId });

        offerId = offer.offerId;
        nftokenId = minted.nftokenId;
      } catch (err) {
        await releaseClaimSlot(deps, request.log, claim, {
          ...(mintedNftokenId ? { orphanedNftokenId: mintedNftokenId } : {}),
        });
        throw err;
      }

      // 5. What the attendee signs. Exactly three fields, nothing they did not
      //    agree to. Outside the try: the spend is done and the slot must
      //    survive whatever happens from here.
      const accept = buildAcceptOfferTxjson({
        offerId,
        attendeeAddress: address,
        ...(deps.config.sourceTag === undefined ? {} : { sourceTag: deps.config.sourceTag }),
      });

      const xaman = await xamanHandles(deps, request.log, {
        offerId,
        address,
        eventId,
        ...(badgeName ? { badgeName } : {}),
        ...(returnUrl ? { returnUrl } : {}),
      });

      return reply.code(201).send({
        eventId,
        address,
        offerId,
        nftokenId,
        accept,
        // Only meaningful when the per-attendee resolver produced the URI, so
        // absent otherwise rather than a misleading `false`. `true` says this
        // attendee was a walk-up whose artwork was pinned during the claim —
        // the slow path, and worth surfacing on a volunteer console.
        ...(pinnedOnDemand === undefined ? {} : { pinnedOnDemand }),
        ...(xaman ? { xaman } : {}),
      });
    },
  );

  /**
   * POST /events/:eventId/claims/:offerId/confirm — the attendee says they
   * signed it; the ledger says whether they did.
   *
   * The `:offerId` in the path is a correlation hint. What gets indexed is the
   * offer the accept transaction actually consumed, read from the chain.
   *
   * 200 verified and indexed | 400 bad input | 422 verification failed
   * 502 ledger trouble
   */
  app.post<{ Params: ConfirmParams; Body: ConfirmBody }>(
    "/events/:eventId/claims/:offerId/confirm",
    { schema: { params: confirmParamsSchema, body: confirmBodySchema } },
    async (request, reply) => {
      const { eventId, offerId } = request.params;
      const { address, txHash } = request.body;

      const outcome = await verifyThenRecord(
        deps,
        { eventId, address, txHash, claimedOfferId: offerId },
        request.log,
      );

      if (!outcome.verification.attended) {
        const { status, failedCheck, reason, checks } = outcome.verification;
        return sendError(
          reply,
          422,
          "VERIFICATION_FAILED",
          reason ?? `The ledger does not show ${address} accepting a badge for event ${eventId}.`,
          { status, failedCheck, checks, txHash },
        );
      }

      return reply.code(200).send({
        attended: true,
        alreadyRecorded: outcome.alreadyRecorded,
        record: outcome.record,
        verification: outcome.verification,
      });
    },
  );
}
