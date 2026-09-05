/**
 * THE EVENT DESK — the volunteer's screen, in production.
 *
 * ┌─ WHY THIS FILE EXISTS ────────────────────────────────────────────────────┐
 * │ The desk used to run on `/demo/lookup` and `/demo/sponsor`. Those routes   │
 * │ are registered only when `DEMO_ENABLED` is set, and they REFUSE TO RUN ON  │
 * │ MAINNET by design — they sit in a harness that generates wallets, takes    │
 * │ faucet money and signs as an attendee. A desk built on them is a desk that │
 * │ cannot work at a real event.                                              │
 * │                                                                            │
 * │ These two routes are the same two answers with none of that behind them:   │
 * │ no wallet registry, no demo event id, no `DemoState` of any kind. They     │
 * │ read the stores the REAL routes wrote and the ledger, and nothing else.    │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 *   GET  /admin/api/desk/state
 *   GET  /admin/api/desk/attendees/:address?eventId=<taxon>
 *   POST /admin/api/desk/sponsor  { address, eventId }
 *
 * WHY UNDER `/admin/api`, and it is not decoration. `registerAdminAuth()` guards
 * that whole prefix with an `onRequest` hook, so a route added there cannot
 * forget to require a session. Both of these need one:
 *
 *   - `sponsor` SPENDS THE ISSUER'S XRP — 1.5 XRP per unactivated attendee, real
 *     money on mainnet. Unauthenticated on a public host it is an open tap on
 *     the issuer's wallet, throttled only by the daily cap.
 *   - `attendees` returns a registered attendee's display name, which is
 *     personal data about somebody who is standing in a room.
 *
 * The guard is BELT AND BRACES, exactly as in routes/events.ts: the prefix hook
 * covers these routes already, and `adminGuard(deps)` runs as a preHandler
 * anyway so an instance built without `registerAdminAuth` — a focused test, a
 * future refactor — cannot serve them open.
 *
 * ONE READER, TWO CALLERS. Everything above the routes is shared with
 * `routes/demo.ts`, which imports it from here rather than keeping a copy. Two
 * implementations of "can this attendee receive a badge" would drift, and the
 * copy that drifts is the one nobody is testing.
 */
import type { FastifyInstance } from "fastify";
import { isValidClassicAddress } from "xrpl";
import { z } from "zod";
import { SponsorshipDeniedError, XrplLayerError } from "../../errors.js";
import { badgeManifestPath, loadBadgeManifest } from "../../metadata/badge-uri-resolver.js";
import type { AttendanceRecord, ClaimRecord, EventId } from "../../types.js";
import { assertValidTaxon } from "../../xrpl/encoding.js";
import { isClaimOfferOpen } from "../../xrpl/offers.js";
import { getAccountBalanceXrp } from "../../xrpl/sponsor.js";
import { findAcceptTxHash } from "../../xrpl/verify.js";
import { reserveShortfallXrp } from "../demo-state.js";
import type { ApiDeps } from "../deps.js";
import {
  addressSchema,
  eventIdSchema,
  sendError,
  statusForXrplError,
} from "../http-errors.js";
import { badgeImageUrl } from "./badge.js";
import { markArrival, verifyThenRecord } from "./claims.js";
import { adminGuard } from "./events.js";

// ---------------------------------------------------------------------------
// Shared readers
//
// `routes/demo.ts` calls every one of these. They take an `ApiDeps` and an
// explicit `eventId` and know nothing about the demo harness, which is what
// makes them usable from both places.
// ---------------------------------------------------------------------------

/**
 * What both stores say about one address on ONE event.
 *
 * The event id is a parameter and never a default. Claims and attendance are
 * per-taxon, so answering from the wrong event reports a pending offer as
 * absent and a badge holder as a walk-up — guessing the event is the bug this
 * whole file exists to stop repeating.
 */
export interface AddressFacts {
  eventId: EventId;
  claim: ClaimRecord | null;
  attendance: AttendanceRecord | null;
}

export async function readAddressFacts(
  deps: ApiDeps,
  eventId: EventId,
  address: string,
): Promise<AddressFacts> {
  const [claim, attendance] = await Promise.all([
    deps.claims.find(eventId, address),
    deps.attendance.findByEventAndAddress(eventId, address),
  ]);
  return { eventId, claim, attendance };
}

/** The registration fields a desk is allowed to see. Never the email. */
export interface DeskRegistration {
  displayName: string | null;
  addressProof: string;
  registeredAt: string | null;
  checkedInAt: string | null;
}

/**
 * Who is this, if we know them?
 *
 * A registered attendee gave us a name before the event and proved the wallet
 * with a Xaman sign-in. At the desk that is the difference between "issue a
 * badge to r9xK…" and "issue a badge to Inderdeep Khanna" — the volunteer can
 * actually check they are handing the right badge to the right person.
 *
 * Optional in every sense: registrations may not be configured, the attendee
 * may be a walk-up, and neither case is an error.
 */
export async function readRegistration(
  deps: ApiDeps,
  eventId: EventId,
  address: string,
): Promise<DeskRegistration | null> {
  if (!deps.registrations) return null;
  try {
    const r = await deps.registrations.findByAddress(eventId, address);
    if (!r) return null;
    return {
      displayName: r.displayName ?? null,
      addressProof: r.addressProof,
      registeredAt: r.registeredAt ? new Date(r.registeredAt).toISOString() : null,
      checkedInAt: r.checkedInAt ? new Date(r.checkedInAt).toISOString() : null,
    };
  } catch {
    // A desk must keep working when the registrations table does not.
    return null;
  }
}

/**
 * Live balance, and whether the address exists on the ledger at all.
 *
 * Takes the reader as a function rather than reaching for one, so the demo
 * harness can pass its own injected op and this file can pass the real
 * `getAccountBalanceXrp` — one implementation of the ACCOUNT_NOT_FOUND rule
 * below, two sources of the number.
 */
export async function liveAccount(
  address: string,
  readBalanceXrp: (address: string) => Promise<string>,
): Promise<{ balanceXrp: string; activated: boolean }> {
  try {
    return { balanceXrp: await readBalanceXrp(address), activated: true };
  } catch (err) {
    // Unactivated is a state, not a failure: it is exactly what the sponsorship
    // path in the UI is there to show. Anything else is a real ledger problem
    // and belongs in the error handler.
    if (err instanceof XrplLayerError && err.code === "ACCOUNT_NOT_FOUND") {
      return { balanceXrp: "0", activated: false };
    }
    throw err;
  }
}

/** What a page needs to show a badge and to check the pin behind it. */
export interface BadgeArtLinks {
  /** Renders now, from the address alone. No wallet, no claim, no badge. */
  previewUrl: string;
  /** ipfs:// artwork. Absent until this attendee has been pinned for this event. */
  imageUri?: string;
  /** ipfs:// metadata JSON — what NFTokenMint carries. Absent likewise. */
  metadataUri?: string;
  /** `imageUri` through the configured gateway. Absent whenever `imageUri` is. */
  gatewayUrl?: string;
}

/**
 * `ipfs://CID/path` -> `<gateway>/ipfs/CID/path`.
 *
 * Anything that is not an `ipfs://` URI yields undefined rather than a guess: a
 * link that 404s is worse than no link, because the page would be inviting
 * somebody to verify a pin and handing them a dead end.
 */
export function ipfsGatewayUrl(uri: string | undefined, gateway: string): string | undefined {
  if (uri === undefined || !uri.startsWith("ipfs://")) return undefined;
  const path = uri.slice("ipfs://".length);
  if (path === "") return undefined;
  return `${gateway.replace(/\/+$/, "")}/ipfs/${path}`;
}

/**
 * Where the badge manifest for one event lives.
 *
 * Asks the resolver first when it can answer: PinningBadgeUriResolver may be
 * pinned to an explicit path, and reading the default file instead would report
 * "not pinned" for an attendee who is. Falls back to `badgeManifestPath`, which
 * is what the pre-pin script writes.
 */
function manifestPathFor(deps: ApiDeps, eventId: EventId): string {
  const resolver = deps.badgeUris as { manifestPathFor?: unknown } | undefined;
  if (typeof resolver?.manifestPathFor === "function") {
    try {
      const path = (resolver.manifestPathFor as (id: EventId) => unknown)(eventId);
      if (typeof path === "string" && path !== "") return path;
    } catch {
      // A resolver that cannot say where its cache is does not get to fail a
      // poll. The default location is a fine answer.
    }
  }
  return badgeManifestPath(eventId);
}

/**
 * The art block that hangs off a scan. NEVER THROWS.
 *
 * `previewUrl` is passed in — the demo harness serves its preview from
 * `/demo/art` and the desk from `/badge/...` — and is therefore always there.
 * The two ipfs:// URIs are read out of the pre-pin manifest, and missing,
 * corrupt and unreadable all mean the same thing to a page: this attendee has
 * not been pinned, which at a desk is the ordinary case and not an error. A
 * scan that 500'd because a cache file was half-written would be absurd.
 */
export async function readBadgeArtLinks(
  deps: ApiDeps,
  eventId: EventId,
  address: string,
  previewUrl: string,
): Promise<BadgeArtLinks> {
  try {
    const manifest = await loadBadgeManifest(manifestPathFor(deps, eventId), {
      eventId,
      // loadBadgeManifest already survives everything; silencing its default
      // console.warn only keeps it out of stdout, where pino's stream lives.
      onWarn: () => undefined,
    });

    const entry = manifest.entries[address];
    if (entry === undefined) return { previewUrl };

    const gatewayUrl = ipfsGatewayUrl(entry.imageUri, deps.config.pinata.gateway);
    return {
      previewUrl,
      ...(entry.imageUri ? { imageUri: entry.imageUri } : {}),
      ...(entry.metadataUri ? { metadataUri: entry.metadataUri } : {}),
      ...(gatewayUrl ? { gatewayUrl } : {}),
    };
  } catch {
    // loadBadgeManifest is documented never to throw. This is the belt to that
    // brace: the preview does not depend on the manifest, so nothing here is
    // worth an error response.
    return { previewUrl };
  }
}

/**
 * The badge preview a PRODUCTION page renders, and the one URL this file
 * spells for it.
 *
 * `/badge/:eventId/:address.png` is registered by `registerBadgeRoutes` on
 * every deployment, mainnet included. `/demo/art` is not — it exists only when
 * `DEMO_ENABLED` is set on a non-mainnet network, so a desk pointed at it shows
 * a broken image at a real event. That is the same class of bug as the routes
 * in this file exist to fix, so the path is built by calling badge.ts's own
 * `badgeImageUrl` with an empty origin rather than being written out again
 * here: if that route ever moves, this moves with it.
 *
 * Relative on purpose. The desk page is served from this origin, and an
 * absolute URL built from `BADGE_BASE_URL` would point somewhere else the
 * moment a deployment sits behind a tunnel.
 */
export function badgePreviewUrl(eventId: EventId, address: string): string {
  return badgeImageUrl("", eventId, address);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Whatever came out of the camera is TEXT. Deliberately not `addressSchema`:
 * "that QR was not an XRPL address" is an answer the volunteer's screen has to
 * render, not a 400 it has to explain, and a 400 makes a mis-scan look like a
 * broken app.
 */
const attendeeParamsSchema = z.object({ address: z.string().min(1).max(200) });
type AttendeeParams = z.infer<typeof attendeeParamsSchema>;

/**
 * `eventId` is OPTIONAL HERE AND REQUIRED BY THE HANDLER, on purpose.
 *
 * Declared optional so the refusal can say what is missing and why, in the
 * message a volunteer's screen will show, rather than "Expected number,
 * received nan" out of a coercion. It is never defaulted: guessing the event is
 * what made the demo lookup answer confidently about the wrong one.
 */
const attendeeQuerySchema = z.object({ eventId: z.string().optional() });
type AttendeeQuery = z.infer<typeof attendeeQuerySchema>;

const sponsorBodySchema = z.object({ address: addressSchema, eventId: eventIdSchema });
type SponsorBody = z.infer<typeof sponsorBodySchema>;

const reconcileBodySchema = z.object({ address: addressSchema, eventId: eventIdSchema });
type ReconcileBody = z.infer<typeof reconcileBodySchema>;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Everything under here. One string, so the prefix cannot drift per route. */
export const DESK_PREFIX = "/admin/api/desk";

export function registerDeskRoutes(app: FastifyInstance, deps: ApiDeps): void {
  // Belt and braces over the `/admin/api` prefix hook — see the header.
  const requireAdmin = adminGuard(deps);

  /** The real ledger read. One line, so the desk cannot drift from sponsor.ts. */
  const readBalanceXrp = (address: string): Promise<string> =>
    getAccountBalanceXrp(deps.gateway, address);

  /**
   * GET /admin/api/desk/state — what the desk is plugged into.
   *
   * The standing facts a desk needs that are not about any one attendee: which
   * ledger it will write to, which node it is talking to, and how much XRP the
   * issuer has left. That last one is the only number here an operator acts on
   * — minting and sponsoring both spend from that account, so a desk that
   * cannot see it discovers the fund is empty by failing to serve somebody.
   *
   * NO EVENT ID. The demo's `/demo/state` carried one because the harness owned
   * a single generated event; a real desk is told which event it is working, by
   * a person, from the list. Answering with a default here is how a volunteer
   * ends up issuing badges for last month's event.
   *
   * Guarded: the issuer address is public on the ledger, but its balance and
   * the node we dial are operational facts, not visitor-facing ones.
   *
   * 200 | 401 no session
   */
  app.get(`${DESK_PREFIX}/state`, { preHandler: requireAdmin }, async (_request, reply) => {
    const issuerAddress = deps.gateway.issuerAddress;
    // An unfunded or unactivated issuer reads as "0" rather than throwing: the
    // desk should still open and say so, not refuse to load.
    const { balanceXrp, activated } = await liveAccount(issuerAddress, readBalanceXrp);

    return reply.code(200).send({
      network: deps.config.network,
      endpoint: deps.gateway.endpoint ?? deps.config.endpoint,
      issuer: { address: issuerAddress, balanceXrp, activated },
      sponsor: { amountXrp: deps.config.sponsor.amountXrp },
    });
  });

  /**
   * GET /admin/api/desk/attendees/:address?eventId=900001 — the scan verdict.
   *
   * Everything the volunteer has to decide with, in one call: can this wallet
   * receive an NFT at all, how much it would take to make it able to, who this
   * person said they were when they registered, and whether they already have a
   * badge FOR THIS EVENT.
   *
   * `valid:false` COMES BACK 200 — a mis-scan is a thing to render.
   *
   * 200 | 400 missing or malformed eventId | 401 no session
   */
  app.get<{ Params: AttendeeParams; Querystring: AttendeeQuery }>(
    `${DESK_PREFIX}/attendees/:address`,
    {
      schema: { params: attendeeParamsSchema, querystring: attendeeQuerySchema },
      preHandler: requireAdmin,
    },
    async (request, reply) => {
      const raw = request.query.eventId?.trim();
      if (raw === undefined || raw === "") {
        // NEVER a default. A desk works one event; answering about a different
        // one reports a badge holder as a walk-up and a pending offer as absent.
        return sendError(
          reply,
          400,
          "INVALID_INPUT",
          "eventId is required. Claims, attendance and registrations are all per-event, so this " +
            "route will not guess which event the desk is working.",
          { address: request.params.address },
        );
      }

      // A number, NaN included, so one function decides what a legal event id
      // is: `eventId=tomorrow` and `eventId=99999999999` then fail identically
      // with INVALID_TAXON instead of one being a zod message about coercion.
      const eventId = Number(raw);
      assertValidTaxon(eventId);

      const scanned = request.params.address.trim();
      const sponsorAmountXrp = deps.config.sponsor.amountXrp;

      if (!isValidClassicAddress(scanned)) {
        return reply.code(200).send({
          address: scanned,
          valid: false,
          eventId,
          activated: false,
          balanceXrp: "0",
          needsSponsorship: false,
          reserveShortfallXrp: "0",
          sponsorAmountXrp,
          claim: null,
          attended: false,
          alreadyHasBadge: false,
          // NULL, not an object, and this is the only response that says so.
          // Badge art is a function of an address, and there is no address here
          // — a `previewUrl` built from a mis-scan would point at a 400 and the
          // page would render it as a broken image.
          registration: null,
          art: null,
        });
      }

      const [{ balanceXrp, activated }, facts, art, registration] = await Promise.all([
        liveAccount(scanned, readBalanceXrp),
        readAddressFacts(deps, eventId, scanned),
        readBadgeArtLinks(deps, eventId, scanned, badgePreviewUrl(eventId, scanned)),
        readRegistration(deps, eventId, scanned),
      ]);

      const attended = facts.attendance !== null;

      // WHETHER THE BADGE CAN LAND, not whether the account exists.
      //
      // This used to be `!activated`, and the difference cost an attendee their
      // badge in front of a volunteer who had been told everything was fine.
      // Accepting an NFT creates an NFTokenPage, and that object locks owner
      // reserve — so a wallet that EXISTS but holds less than base + one owner
      // reserve cannot receive anything either. Xaman refuses the accept with
      // "not enough balance", by which point the badge is already minted and
      // 0.2 XRP of the issuer's reserve is locked in an offer nobody can take.
      //
      // A wallet with a dust balance is more common than an empty one: people
      // who have touched XRP before, and are the least likely to expect this.
      const shortfallXrp = reserveShortfallXrp(balanceXrp);

      return reply.code(200).send({
        address: scanned,
        valid: true,
        eventId: facts.eventId,
        activated,
        balanceXrp,
        needsSponsorship: !activated || shortfallXrp !== "0",
        reserveShortfallXrp: shortfallXrp,
        sponsorAmountXrp,
        claim: facts.claim
          ? {
              status: facts.claim.status,
              nftokenId: facts.claim.nftokenId ?? null,
              offerId: facts.claim.offerId ?? null,
            }
          : null,
        attended,
        ...(facts.attendance ? { attendedTxHash: facts.attendance.txHash } : {}),
        // A pending claim is NOT a badge: the offer is open and the attendee has
        // not signed. POST /claims hands that same offer back rather than
        // minting twice, so the volunteer may still press issue.
        alreadyHasBadge: attended || facts.claim?.status === "claimed",
        // Null for a walk-up who never registered — a normal case at a door,
        // not an error.
        registration,
        art,
      });
    },
  );

  /**
   * POST /admin/api/desk/reconcile { address, eventId } — did they accept?
   *
   * THE DESK'S SECOND WAY TO FIND OUT, and the one that does not depend on the
   * browser. The first way is to ask Xaman about the payload the desk created,
   * which works only while the tab that created it is still open: reload the
   * page, hand the desk to the next volunteer, or scan a card issued ten
   * minutes ago, and the payload id is gone. The badge is on the ledger, the
   * claim row still says `pending`, and the card waits forever. Measured, not
   * imagined — two attendees on testnet, both holding their badge.
   *
   * CHEAP FIRST. While the NFTokenOffer object is still on the ledger nobody
   * has signed, and that is one `ledger_entry`. Only once it is gone does this
   * spend an `account_tx` looking for the accept, and only once, because the
   * next call finds the attendance row instead.
   *
   * TRUSTS NOTHING IT FINDS. The hash discovered here goes through the same
   * `verifyThenRecord` as a confirm the attendee posted themselves — all five
   * checks, every time. This route cannot record an attendance the ledger does
   * not support; the worst it can do is fail verification out loud.
   *
   * 200 always, with `reconciled` and a `reason` — "not yet" is the normal
   * answer at a desk and is not an error. 400 bad input | 401 no session
   */
  app.post<{ Body: ReconcileBody }>(
    `${DESK_PREFIX}/reconcile`,
    { schema: { body: reconcileBodySchema }, preHandler: requireAdmin },
    async (request, reply) => {
      const { address, eventId } = request.body;
      const facts = await readAddressFacts(deps, eventId, address);

      // Already an attendance row: whoever got there first — the attendee's own
      // pass, the Xaman webhook, an earlier poll — did the work.
      if (facts.attendance) {
        return reply.code(200).send({
          reconciled: false,
          reason: "already-recorded",
          attended: true,
          txHash: facts.attendance.txHash,
        });
      }

      const offerId = facts.claim?.status === "pending" ? facts.claim.offerId : null;
      if (!offerId) {
        // No badge has been issued to them, or the claim was abandoned. Either
        // way there is no accept to go looking for.
        return reply.code(200).send({ reconciled: false, reason: "no-open-claim" });
      }

      if (await isClaimOfferOpen(deps.gateway, offerId)) {
        return reply.code(200).send({ reconciled: false, reason: "offer-open", offerId });
      }

      const txHash = await findAcceptTxHash(deps.gateway, { address, offerId });
      if (!txHash) {
        // The offer is gone but no successful accept by this address consumed
        // it. Cancelled, expired, or accepted so recently that this node has
        // not caught up — all three look the same from here and all three are
        // answered by asking again.
        return reply.code(200).send({ reconciled: false, reason: "accept-not-found", offerId });
      }

      const outcome = await verifyThenRecord(
        deps,
        { eventId, address, txHash, claimedOfferId: offerId },
        request.log,
      );

      if (!outcome.verification.attended) {
        const { status, failedCheck, reason, checks, notYet } = outcome.verification;
        // A node that has the accept in its history but has not validated the
        // ledger holding it yet is behind, not disagreeing. Saying
        // "verification-failed" here would put a red card in front of a
        // volunteer for a badge that lands four seconds later.
        return reply.code(200).send({
          reconciled: false,
          reason: notYet ? "not-visible-yet" : "verification-failed",
          txHash,
          verification: { status, failedCheck, reason, checks },
        });
      }

      await markArrival(deps, eventId, address, request.log);

      return reply.code(200).send({
        reconciled: true,
        attended: true,
        alreadyRecorded: outcome.alreadyRecorded,
        txHash,
        record: outcome.record,
      });
    },
  );

  /**
   * POST /admin/api/desk/sponsor { address, eventId } — activate an empty wallet.
   *
   * THE REAL sponsorWallet(), with the real SponsorConfig and the real
   * SponsorLedger, so the two-phase reservation and the daily cap genuinely
   * apply. That is not a detail: this is the only route a person can press that
   * moves the issuer's XRP on purpose, and those two guards are the whole thing
   * standing between an issuer wallet and an unbounded drain.
   *
   * The claim route sponsors on its own when it meets an unactivated address.
   * This exists so the volunteer can do it as a deliberate, visible step BEFORE
   * issuing, which is what a person at a desk actually does.
   *
   * 200 { sponsored, alreadyActivated, amountXrp?, txHash? }
   * 400 bad address or event id | 401 no session | 403 refused | 429 daily cap
   */
  app.post<{ Body: SponsorBody }>(
    `${DESK_PREFIX}/sponsor`,
    { schema: { body: sponsorBodySchema }, preHandler: requireAdmin },
    async (request, reply) => {
      const { address, eventId } = request.body;

      try {
        const result = await deps.chain.sponsorWallet(deps.gateway, {
          address,
          eventId,
          config: deps.config.sponsor,
          ledger: deps.sponsorLedger,
        });

        // Money moved (or did not) at the operator's request. One line, with
        // who and how much, because the daily cap is only auditable if the
        // spends that fill it are.
        request.log.info(
          {
            address,
            eventId,
            sponsored: result.sponsored,
            amountXrp: result.amountXrp,
            admin: request.admin?.email,
          },
          "desk sponsorship",
        );

        return reply.code(200).send({
          sponsored: result.sponsored,
          alreadyActivated: result.alreadyActivated,
          ...(result.amountXrp ? { amountXrp: result.amountXrp } : {}),
          ...(result.txHash ? { txHash: result.txHash } : {}),
        });
      } catch (err) {
        // Mapped here rather than left to the error handler so the guard is
        // visible at the route that spends the money: 403 for a refusal that
        // stays true, 429 for the daily cap, which is a throttle and may pass
        // tomorrow. `details.kind` tells the page which.
        if (err instanceof SponsorshipDeniedError) {
          return sendError(reply, statusForXrplError(err), err.code, err.message, err.details);
        }
        throw err;
      }
    },
  );
}
