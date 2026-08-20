/**
 * DEMO ONLY — a testnet harness for the flow in README.md, in two shapes:
 *
 *   /demo/walkthrough   one page, one attendee, the whole cycle explained
 *   /demo/attendee      what an attendee holds at a real event: their phone
 *   /demo/volunteer     what the person handing out badges is looking at
 *
 * ┌─ WHAT THIS IS AND IS NOT ────────────────────────────────────────────────┐
 * │ These routes exist so humans can watch the real claim cycle happen in a   │
 * │ browser. They supply only the parts a browser cannot: a throwaway         │
 * │ attendee wallet, and a signature from that wallet.                        │
 * │                                                                           │
 * │ THEY DO NOT WRAP THE REAL API. The pages drive                            │
 * │ POST /events/:eventId/claims, POST /.../confirm, GET /verify,             │
 * │ GET /roster and GET /attendance directly, and POST /demo/sponsor calls    │
 * │ the same sponsorWallet() the claim route does, with the same two-phase    │
 * │ reservation and the same daily cap. A demo that exercised a parallel code │
 * │ path would prove nothing about the code that ships, so everything here    │
 * │ OBSERVES the stores those routes wrote rather than keeping its own idea   │
 * │ of who has a badge. Nothing is fed back in from a page, so the demo       │
 * │ cannot drift from reality.                                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * THE TWO-ROLE FLOW, and which call is whose:
 *
 *   attendee  POST /demo/wallet                     -> address + handle token
 *   attendee  (renders the address as a QR code)
 *   volunteer GET  /demo/lookup?address=...         -> the whole scan verdict
 *   volunteer POST /demo/sponsor                    -> activate an empty wallet
 *   volunteer POST /events/:eventId/claims          -> THE REAL ROUTE. Mints.
 *   attendee  GET  /demo/wallet/:address/status     -> polls; sees `pending`
 *   attendee  POST /demo/wallet/:address/accept     -> signs, with its token
 *   attendee  POST /events/:id/claims/:offer/confirm-> THE REAL ROUTE. Indexes.
 *
 * SAFETY. This file generates wallets, takes faucet money and signs
 * transactions. Four guards, all of which have a test:
 *
 *   1. Registration needs BOTH `DEMO_ENABLED` (read by the composition root)
 *      and a non-mainnet network. Absent either, none of these routes exist and
 *      the server 404s them like any other unknown path.
 *   2. `DEMO_ENABLED` + mainnet THROWS at startup. Never a silent skip: an
 *      operator must not be able to believe the demo is off when they meant it
 *      on, or ship it believing it is on.
 *   3. Every request re-checks the network and 403s on mainnet, so a config
 *      object mutated after boot cannot open them.
 *   4. One loud warning line when the routes go live.
 *
 * And every attendee seed lives in a `#private` Map inside DemoState for the
 * life of the process. None is ever written to disk, returned, or logged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Wallet, isValidClassicAddress } from "xrpl";
import { z } from "zod";
import { SponsorshipDeniedError, XrplLayerError } from "../../errors.js";
import type { AttendanceRecord, ClaimRecord, EventId } from "../../types.js";
import {
  DEMO_PAGE_FILES,
  DEMO_PUBLIC_REPO_DIR,
  DemoState,
  assertDemoAllowed,
  reserveShortfallXrp,
  type DemoOptions,
  type DemoPageName,
} from "../demo-state.js";
import type { ApiDeps } from "../deps.js";
import {
  addressSchema,
  eventIdSchema,
  sendError,
  statusForXrplError,
} from "../http-errors.js";

/**
 * The walkthrough page, repo-relative. Kept exported and kept named: it is what
 * the 503 message says, and an absolute server path in a response body helps
 * nobody and leaks the layout.
 */
export const DEMO_HTML_REPO_PATH = `${DEMO_PUBLIC_REPO_DIR}/${DEMO_PAGE_FILES.walkthrough}`;

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

/** Where each page is served from, once overrides are applied. */
type PagePaths = Record<DemoPageName, string>;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Body of POST /demo/attendee and POST /demo/wallet. `nullish` because fastify
 * hands a bodyless POST a literal `null`, and "no body" has to mean the default
 * rather than a 400 — a page's first call is a bare button press.
 */
const fundedBodySchema = z
  .object({ funded: z.boolean().optional() })
  .nullish()
  .transform((body) => body ?? {});

type FundedBody = z.infer<typeof fundedBodySchema>;

const walletParamsSchema = z.object({ address: addressSchema });
type WalletParams = z.infer<typeof walletParamsSchema>;

/**
 * The accept body. `token` is OPTIONAL IN THE SCHEMA AND REQUIRED BY THE
 * HANDLER, on purpose: a missing handle is a refusal to sign (403), not a
 * malformed request (400). "You may not drive this wallet" and "your JSON is
 * wrong" are different answers and the page shows different things for them.
 */
const acceptBodySchema = z
  .object({ token: z.string().optional() })
  .nullish()
  .transform((body) => body ?? {});

type AcceptBody = z.infer<typeof acceptBodySchema>;

/**
 * The scan query. Deliberately `z.string()` and not `addressSchema`: whatever
 * came out of the camera is text, and "that QR was not an XRPL address" is an
 * answer the volunteer's screen has to render, not a 400 it has to explain.
 */
const lookupQuerySchema = z.object({ address: z.string() });
type LookupQuery = z.infer<typeof lookupQuerySchema>;

const sponsorBodySchema = z.object({ address: addressSchema, eventId: eventIdSchema });
type SponsorBody = z.infer<typeof sponsorBodySchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a page off disk. Every failure is the same answer — a 503 naming the
 * file — because the only interesting distinction to an operator is "that UI is
 * not there yet".
 */
function readHtml(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Live balance, and whether the address exists on the ledger at all. */
async function liveAccount(
  deps: ApiDeps,
  demo: DemoOptions,
  address: string,
): Promise<{ balanceXrp: string; activated: boolean }> {
  try {
    return { balanceXrp: await demo.ops.getAccountBalanceXrp(deps.gateway, address), activated: true };
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

/**
 * Refresh the demo's badge state from the stores the REAL routes wrote.
 *
 * This is the seam that keeps the demo honest. `POST /events/:eventId/claims`
 * attaches the nftokenId and offerId to the claim slot; `POST /.../confirm` and
 * the Xaman webhook insert the attendance row. Both are read back here, so the
 * page never has to tell the server what the server just did.
 */
async function syncFromStores(deps: ApiDeps, state: DemoState): Promise<AttendanceRecord | null> {
  const address = state.attendeeAddress;
  if (address === undefined) return null;

  const claim = await deps.claims.find(state.eventId, address);
  if (claim) state.observeBadge({ nftokenId: claim.nftokenId, offerId: claim.offerId });

  const record = await deps.attendance.findByEventAndAddress(state.eventId, address);
  if (record) {
    state.observeBadge({ nftokenId: record.nftokenId, offerId: record.offerId });
    // An indexed row means the chain confirmed the accept. Its hash is the
    // attendance record, and it is authoritative over anything we remembered.
    state.markAccepted(record.txHash);
  }

  return record;
}

/**
 * Everything both new sides need to know about one address on the current
 * event, read from the two stores the real routes wrote plus our own signing
 * receipt. ONE reader, so the attendee's phone and the volunteer's screen can
 * never render two different versions of the same moment.
 */
interface AddressFacts {
  eventId: EventId;
  claim: ClaimRecord | null;
  attendance: AttendanceRecord | null;
  /** True once the attendee has signed — indexed on chain, or signed by us. */
  accepted: boolean;
  /** The NFTokenAcceptOffer hash, once one exists. */
  txHash: string | undefined;
  /**
   * A destination-locked offer that is still waiting for a signature.
   *
   * Null once we have signed it, even though the claim row still says pending
   * until the real /confirm route runs: the offer is consumed on chain at that
   * point, and showing it as pending would invite a second accept that can only
   * fail with tecOBJECT_NOT_FOUND.
   */
  pending: { offerId: string; nftokenId: string | null } | null;
}

async function readAddressFacts(
  deps: ApiDeps,
  state: DemoState,
  address: string,
): Promise<AddressFacts> {
  const eventId = state.eventId;
  const [claim, attendance] = await Promise.all([
    deps.claims.find(eventId, address),
    deps.attendance.findByEventAndAddress(eventId, address),
  ]);

  const receipt = state.walletAccept(address, eventId);
  const accepted = attendance !== null || receipt !== undefined;
  const offerId = claim?.status === "pending" ? claim.offerId : null;

  return {
    eventId,
    claim,
    attendance,
    accepted,
    txHash: attendance?.txHash ?? receipt?.txHash,
    pending:
      offerId && !accepted ? { offerId, nftokenId: claim?.nftokenId ?? null } : null,
  };
}

/** 409 in the one shape the UI already handles. */
function conflict(
  reply: FastifyReply,
  message: string,
  details?: Record<string, unknown>,
): FastifyReply {
  return sendError(reply, 409, "NOT_FOUND", message, details);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Registers `/demo/*`. Call ONLY when `deps.demo.enabled` is true — and note
 * that this throws a ConfigError on mainnet rather than returning quietly.
 */
export function registerDemoRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const demo = deps.demo;
  if (!demo?.enabled) return;

  // GUARD 2. Synchronous, so buildServer() itself throws and a process that
  // meant to be a mainnet API never reaches listen().
  assertDemoAllowed(deps.config);

  const state = demo.state ?? new DemoState();
  const publicDir = demo.htmlDir ?? DEFAULT_PUBLIC_DIR;

  const pagePaths: PagePaths = {
    index: join(publicDir, DEMO_PAGE_FILES.index),
    // The only per-page override, and only because it predates the other three.
    walkthrough: demo.htmlPath ?? join(publicDir, DEMO_PAGE_FILES.walkthrough),
    attendee: join(publicDir, DEMO_PAGE_FILES.attendee),
    volunteer: join(publicDir, DEMO_PAGE_FILES.volunteer),
  };

  // Registration-time read (no @fastify/static, no plugin). Kept as a fallback
  // for the request path, which re-reads so that edits to a page show up on
  // refresh rather than needing a restart.
  const htmlAtBoot = new Map<DemoPageName, string>();
  for (const name of Object.keys(pagePaths) as DemoPageName[]) {
    const html = readHtml(pagePaths[name]);
    if (html !== undefined) htmlAtBoot.set(name, html);
  }

  // GUARD 4. One line, once, and it says what is now possible.
  app.log.warn(
    { network: deps.config.network, endpoint: deps.config.endpoint, eventId: state.eventId },
    "DEMO ROUTES ARE LIVE at /demo — this build can generate wallets, take faucet funds and " +
      "sign transactions as an attendee. Testnet only. Never run this configuration against mainnet.",
  );

  const missing = (Object.keys(pagePaths) as DemoPageName[]).filter((n) => !htmlAtBoot.has(n));
  if (missing.length > 0) {
    app.log.warn(
      { pages: missing.map((n) => `${DEMO_PUBLIC_REPO_DIR}/${DEMO_PAGE_FILES[n]}`) },
      "some demo UI files do not exist yet; their routes will answer 503 until they do",
    );
  }

  /**
   * Encapsulated so the mainnet hook below covers these routes and nothing
   * else. Deliberately OUTSIDE the rate-limited scope in server.ts, alongside
   * /health: two pages poll this harness, and a poll loop eating the 120/min
   * global bucket would 429 the actual claim halfway through a demo.
   */
  app.register(async (scope) => {
    /**
     * GUARD 3. Re-checked per request, not just at boot. `deps.config` is a
     * live object; if anything mutates `network` after startup these routes
     * must close rather than keep signing.
     */
    scope.addHook("onRequest", async (_request, reply) => {
      if (deps.config.network === "mainnet") {
        return sendError(
          reply,
          403,
          "NETWORK_GUARD",
          "The demo harness is disabled on mainnet. It generates wallets, takes faucet funds " +
            "and signs transactions on an attendee's behalf.",
          { network: deps.config.network },
        );
      }
      return undefined;
    });

    // -- pages --------------------------------------------------------------

    /**
     * Serve one page off disk, or say plainly that it has not been written yet.
     *
     * A missing page is an operator problem, not a crash. The server keeps
     * serving the API — including the rest of /demo/* — either way, which is
     * what lets the three pages be built independently of this file.
     */
    const servePage =
      (name: DemoPageName) => async (_request: FastifyRequest, reply: FastifyReply) => {
      const html = readHtml(pagePaths[name]) ?? htmlAtBoot.get(name);
      if (html === undefined) {
        const repoPath = `${DEMO_PUBLIC_REPO_DIR}/${DEMO_PAGE_FILES[name]}`;
        return sendError(
          reply,
          503,
          "NOT_FOUND",
          `The demo UI has not been built yet: ${repoPath} does not exist. ` +
            "Create that file (the API half of the demo is already running), then reload.",
          { path: repoPath },
        );
      }
      return reply.code(200).type("text/html; charset=utf-8").send(html);
    };

    /** GET /demo — the role chooser. 200 text/html | 503 not built yet */
    scope.get("/demo", servePage("index"));

    /**
     * GET /demo/walkthrough — the original single-page explainer.
     *
     * It used to live at /demo. It still drives /demo/state, /demo/attendee,
     * /demo/accept, /demo/burn and /demo/reset, all unchanged.
     */
    scope.get("/demo/walkthrough", servePage("walkthrough"));

    /**
     * GET /demo/attendee — the attendee's phone.
     *
     * Same path as POST /demo/attendee, which the walkthrough uses. Different
     * methods, so fastify routes them independently; there is a test that both
     * still resolve, because "the page took over the POST" would be a silent
     * and confusing break.
     */
    scope.get("/demo/attendee", servePage("attendee"));

    /** GET /demo/volunteer — the badge desk. */
    scope.get("/demo/volunteer", servePage("volunteer"));

    // -- shared -------------------------------------------------------------

    /**
     * GET /demo/state — everything the walkthrough renders, polled.
     *
     * Balances are read live off the ledger; the badge and the attendance row
     * are read out of the stores the real routes wrote. Nothing here is a
     * number the page told us.
     */
    scope.get("/demo/state", async (_request, reply) => {
      const record = await syncFromStores(deps, state);
      const view = state.view();

      const issuerAddress = deps.gateway.issuerAddress;
      const issuer = await liveAccount(deps, demo, issuerAddress);

      const attendeeAddress = view.attendee?.address;
      const attendee =
        attendeeAddress === undefined
          ? null
          : { address: attendeeAddress, ...(await liveAccount(deps, demo, attendeeAddress)) };

      // `recorded` is the index; `txHash` is the attendee's NFTokenAcceptOffer.
      // The hash is worth exposing before the row exists — it is what the page
      // posts to /confirm and passes to /verify.
      const txHash = record?.txHash ?? view.acceptTxHash ?? undefined;

      return reply.code(200).send({
        enabled: true,
        network: deps.config.network,
        endpoint: deps.config.endpoint,
        eventId: view.eventId,
        issuer: { address: issuerAddress, balanceXrp: issuer.balanceXrp },
        attendee,
        badge: view.badge,
        attendance: { recorded: record !== null, ...(txHash ? { txHash } : {}) },
      });
    });

    // -- the walkthrough ----------------------------------------------------

    /**
     * POST /demo/attendee { funded?: boolean } — a throwaway attendee wallet.
     *
     * The WALKTHROUGH's wallet: it fills the single attendee slot the one-page
     * explainer knows about, and `funded: true` is its default because that
     * page walks the happy path first and shows sponsorship as a variation.
     * The two-role demo uses POST /demo/wallet instead, which defaults the
     * other way.
     *
     * 201 { address, balanceXrp, activated }
     */
    scope.post<{ Body: FundedBody }>(
      "/demo/attendee",
      { schema: { body: fundedBodySchema } },
      async (request, reply) => {
        const funded = request.body?.funded ?? true;

        // The seed goes straight into DemoState's #private map and nowhere
        // else. Not returned below, not logged, not written to disk.
        const created = funded
          ? await demo.ops.fundWallet()
          : { wallet: Wallet.generate(), balanceXrp: "0" };

        state.setAttendee(created.wallet, { funded });

        return reply.code(201).send({
          address: created.wallet.classicAddress,
          balanceXrp: created.balanceXrp,
          // An address that has never been funded cannot exist on the ledger,
          // so this is true by construction rather than by query. /demo/state
          // reads the live truth from the node on every poll regardless.
          activated: funded,
        });
      },
    );

    /**
     * POST /demo/accept — sign the walkthrough attendee's claim offer.
     *
     * THIS IS THE STEP A REAL ATTENDEE DOES IN XAMAN, on their own phone, with
     * a key the server never sees (README "2 — Sign"). The demo holds a
     * throwaway attendee key purely so the cycle can run without a second
     * device. Nothing else in src/ ever signs as an attendee.
     *
     * 200 { txHash, ledgerIndex } | 409 no attendee, or no offer to accept
     */
    scope.post("/demo/accept", async (_request, reply) => {
      const wallet = state.signingWallet();
      if (!wallet) {
        return conflict(reply, "There is no demo attendee yet. POST /demo/attendee first.");
      }

      await syncFromStores(deps, state);
      const offerId = state.offerId;
      if (!offerId) {
        return conflict(
          reply,
          `No claim offer exists for ${wallet.classicAddress} on event ${state.eventId} yet. ` +
            `POST /events/${state.eventId}/claims first.`,
          { eventId: state.eventId, address: wallet.classicAddress },
        );
      }

      const accepted = await demo.ops.acceptOfferAs(deps.gateway, { offerId, wallet });
      state.markAccepted(accepted.txHash);

      return reply.code(200).send({ txHash: accepted.txHash, ledgerIndex: accepted.ledgerIndex });
    });

    /**
     * POST /demo/burn — destroy the badge from the attendee's own wallet.
     *
     * A HOLDER burn, which needs no `Owner` field and works whether or not
     * `tfBurnable` was set. It exists so the page can prove the architectural
     * claim: GET /verify still answers `attended: true` afterwards, because
     * attendance is the accept transaction, not the current ownership.
     *
     * 200 { txHash } | 409 nothing accepted yet
     */
    scope.post("/demo/burn", async (_request, reply) => {
      const wallet = state.signingWallet();
      if (!wallet) {
        return conflict(reply, "There is no demo attendee yet. POST /demo/attendee first.");
      }

      await syncFromStores(deps, state);
      if (!state.accepted) {
        return conflict(
          reply,
          "The badge has not been accepted yet, so there is nothing in the attendee's wallet to " +
            "burn. POST /demo/accept first.",
          { eventId: state.eventId, address: wallet.classicAddress },
        );
      }

      const nftokenId = state.nftokenId;
      if (!nftokenId) {
        return conflict(reply, "The badge was accepted but no NFTokenID has been observed for it yet.", {
          eventId: state.eventId,
          address: wallet.classicAddress,
        });
      }

      const burned = await demo.ops.burn(deps.gateway, { nftokenId, wallet });
      state.markBurned(burned.txHash);

      return reply.code(200).send({ txHash: burned.txHash });
    });

    /**
     * POST /demo/reset — a fresh event id, and forget the walkthrough attendee.
     *
     * Touches nothing on the ledger. The previous badge stays exactly where it
     * is and still verifies against its own event; that is the point of a new
     * taxon rather than a cleanup. Registered attendee wallets survive: those
     * are people standing in a room, and a new event id does not send them
     * home.
     *
     * 200 { eventId }
     */
    scope.post("/demo/reset", async (_request, reply) => {
      const eventId = state.reset();
      return reply.code(200).send({ eventId });
    });

    // -- the attendee's phone ------------------------------------------------

    /**
     * POST /demo/wallet { funded?: boolean } — the attendee's own wallet.
     *
     * DEFAULTS TO funded:false, the opposite of the walkthrough, because the
     * interesting event is the one where the wallet is brand new: an address
     * that has never been funded does not exist on the ledger, cannot receive
     * an NFT, and has to be topped up by the volunteer standing in front of
     * them. Faking that with a faucet-funded wallet would skip the only part of
     * this flow a real event actually has to solve.
     *
     * `token` is an opaque handle, not a key: the page keeps it in
     * sessionStorage and sends it back to prove it is the tab that made this
     * wallet. See DemoState.registerWallet.
     *
     * 201 { address, balanceXrp, activated, token }
     */
    scope.post<{ Body: FundedBody }>(
      "/demo/wallet",
      { schema: { body: fundedBodySchema } },
      async (request, reply) => {
        const funded = request.body?.funded ?? false;

        const created = funded
          ? await demo.ops.fundWallet()
          : { wallet: Wallet.generate(), balanceXrp: "0" };

        const token = state.registerWallet(created.wallet, { funded });

        // The seed is not in this body and cannot be: `created.wallet` went
        // into a #private map and every field below is named by hand.
        return reply.code(201).send({
          address: created.wallet.classicAddress,
          balanceXrp: created.balanceXrp,
          activated: funded,
          token,
        });
      },
    );

    /**
     * GET /demo/wallet/:address/status — what the attendee's phone polls.
     *
     * Activation and balance come off the ledger live. `pending`, `accepted`
     * and `attended` come from the claim slot and the attendance index, which
     * the REAL routes wrote — this endpoint keeps no idea of its own about who
     * has a badge, so it cannot be wrong in a way the chain would disagree
     * with.
     *
     * Works for any address, registered here or not: the volunteer's screen is
     * allowed to watch a wallet it does not hold the key for.
     *
     * 200 { address, eventId, activated, balanceXrp, reserveShortfallXrp,
     *       pending, accepted, attended, txHash? }
     */
    scope.get<{ Params: WalletParams }>(
      "/demo/wallet/:address/status",
      { schema: { params: walletParamsSchema } },
      async (request, reply) => {
        const { address } = request.params;
        const [{ balanceXrp, activated }, facts] = await Promise.all([
          liveAccount(deps, demo, address),
          readAddressFacts(deps, state, address),
        ]);

        return reply.code(200).send({
          address,
          eventId: facts.eventId,
          activated,
          balanceXrp,
          reserveShortfallXrp: reserveShortfallXrp(balanceXrp),
          pending: facts.pending,
          accepted: facts.accepted,
          attended: facts.attendance !== null,
          ...(facts.txHash ? { txHash: facts.txHash } : {}),
        });
      },
    );

    /**
     * POST /demo/wallet/:address/accept { token } — the attendee taps confirm.
     *
     * PRODUCTION DOES NOT HAVE THIS ROUTE. A real attendee signs the
     * NFTokenAcceptOffer in Xaman, on their own phone, with a key this server
     * never sees; the accept payload the claim route returns is exactly what
     * Xaman is handed. This exists only because there is no second phone in the
     * loop during a demo, and it is the one place in src/ that signs as an
     * attendee. The token is what stops a stranger's tab from doing it.
     *
     * 200 { txHash, ledgerIndex } | 403 wrong or missing handle
     * 409 nothing to accept
     */
    scope.post<{ Params: WalletParams; Body: AcceptBody }>(
      "/demo/wallet/:address/accept",
      { schema: { params: walletParamsSchema, body: acceptBodySchema } },
      async (request, reply) => {
        const { address } = request.params;

        // Before any store is read and long before anything is signed. An
        // unknown address fails here too: no token can authorise a wallet this
        // process does not hold a key for.
        if (!state.authorises(address, request.body?.token)) {
          // 403 carries the refusal; the code names what was wrong with the
          // request. src/errors.ts has no authorisation code and is not this
          // change's to edit, and NETWORK_GUARD is taken by the mainnet hook
          // above — a page must be able to tell those two 403s apart.
          return sendError(
            reply,
            403,
            "INVALID_INPUT",
            "That handle does not match this wallet. The token returned by POST /demo/wallet is " +
              "what proves a page drives it; this process will not sign as a wallet without it.",
            { address },
          );
        }

        const facts = await readAddressFacts(deps, state, address);

        if (facts.attendance !== null) {
          return conflict(
            reply,
            `${address} already has a recorded badge for event ${facts.eventId}; there is nothing ` +
              "left to sign.",
            { eventId: facts.eventId, address, txHash: facts.attendance.txHash },
          );
        }

        // A phone that double-taps, or reconnects and retries, must not get a
        // red error for a signature that already succeeded. Idempotent replay,
        // not a second submit: the offer is gone from the ledger by now.
        const receipt = state.walletAccept(address, facts.eventId);
        if (receipt?.ledgerIndex !== undefined) {
          return reply.code(200).send({
            txHash: receipt.txHash,
            ledgerIndex: receipt.ledgerIndex,
            alreadyAccepted: true,
          });
        }

        if (!facts.pending) {
          return conflict(
            reply,
            `No claim offer is waiting for ${address} on event ${facts.eventId}. The volunteer has ` +
              "not issued this badge yet.",
            { eventId: facts.eventId, address },
          );
        }

        const wallet = state.walletFor(address);
        if (!wallet) {
          // authorises() already proved the entry exists, so this is only
          // reachable if it was evicted between the two reads.
          return conflict(reply, `This process no longer holds a key for ${address}.`, { address });
        }

        const accepted = await demo.ops.acceptOfferAs(deps.gateway, {
          offerId: facts.pending.offerId,
          wallet,
        });
        state.markWalletAccepted(address, facts.eventId, accepted.txHash, accepted.ledgerIndex);

        return reply.code(200).send({ txHash: accepted.txHash, ledgerIndex: accepted.ledgerIndex });
      },
    );

    // -- the volunteer's screen ----------------------------------------------

    /**
     * GET /demo/lookup?address=... — the scan result panel, in one call.
     *
     * Everything the volunteer has to decide with: can this wallet receive an
     * NFT at all, how much it would take to make it able to, and whether this
     * person already has a badge for this event.
     *
     * `valid:false` COMES BACK 200. Whatever the camera read is text, and "that
     * QR was not an XRPL address" is a thing to render, not an error to explain.
     * A 400 would make a mis-scan look like a broken volunteer app.
     *
     * 200 always (for a query that has an `address` key at all)
     */
    scope.get<{ Querystring: LookupQuery }>(
      "/demo/lookup",
      { schema: { querystring: lookupQuerySchema } },
      async (request, reply) => {
        const scanned = request.query.address.trim();
        const sponsorAmountXrp = deps.config.sponsor.amountXrp;

        if (!isValidClassicAddress(scanned)) {
          return reply.code(200).send({
            address: scanned,
            valid: false,
            eventId: state.eventId,
            activated: false,
            balanceXrp: "0",
            needsSponsorship: false,
            reserveShortfallXrp: "0",
            sponsorAmountXrp,
            claim: null,
            attended: false,
            alreadyHasBadge: false,
          });
        }

        const [{ balanceXrp, activated }, facts] = await Promise.all([
          liveAccount(deps, demo, scanned),
          readAddressFacts(deps, state, scanned),
        ]);

        const attended = facts.attendance !== null;

        return reply.code(200).send({
          address: scanned,
          valid: true,
          eventId: facts.eventId,
          activated,
          balanceXrp,
          // An unactivated account cannot receive an NFT at all (brief 5.4), so
          // this is the whole question the volunteer is asking.
          needsSponsorship: !activated,
          reserveShortfallXrp: reserveShortfallXrp(balanceXrp),
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
          // A pending claim is NOT a badge: the offer is open and the attendee
          // has not signed. POST /claims hands that same offer back rather than
          // minting twice, so the volunteer may still press issue.
          alreadyHasBadge: attended || facts.claim?.status === "claimed",
        });
      },
    );

    /**
     * POST /demo/sponsor { address, eventId } — activate an empty wallet.
     *
     * THE REAL sponsorWallet(), with the real SponsorConfig and the real
     * SponsorLedger, so the two-phase reservation and the daily cap genuinely
     * apply here. That is the point: a volunteer who taps this often enough
     * must watch it start refusing, because that guard is the only thing
     * standing between an issuer wallet and an unbounded drain (brief 5.4).
     *
     * The claim route sponsors on its own when it meets an unactivated address.
     * This exists so the volunteer can do it as a deliberate, visible step
     * BEFORE issuing, which is what a person at a desk actually does.
     *
     * 200 { sponsored, alreadyActivated, amountXrp?, txHash? }
     * 403 refused | 429 the daily cap
     */
    scope.post<{ Body: SponsorBody }>(
      "/demo/sponsor",
      { schema: { body: sponsorBodySchema } },
      async (request, reply) => {
        const { address, eventId } = request.body;

        try {
          const result = await deps.chain.sponsorWallet(deps.gateway, {
            address,
            eventId,
            config: deps.config.sponsor,
            ledger: deps.sponsorLedger,
          });

          request.log.info(
            { address, eventId, sponsored: result.sponsored, amountXrp: result.amountXrp },
            "demo sponsorship",
          );

          return reply.code(200).send({
            sponsored: result.sponsored,
            alreadyActivated: result.alreadyActivated,
            ...(result.amountXrp ? { amountXrp: result.amountXrp } : {}),
            ...(result.txHash ? { txHash: result.txHash } : {}),
          });
        } catch (err) {
          // Mapped here rather than left to the error handler so the guard is
          // visible at the route that exists to demonstrate it: 403 for a
          // refusal that stays true, 429 for the daily cap, which is a throttle
          // and may pass tomorrow. `details.kind` tells the page which.
          if (err instanceof SponsorshipDeniedError) {
            return sendError(
              reply,
              statusForXrplError(err),
              err.code,
              err.message,
              err.details,
            );
          }
          throw err;
        }
      },
    );
  });
}
