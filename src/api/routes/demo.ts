/**
 * DEMO ONLY — a testnet click-through harness for the flow in README.md.
 *
 * ┌─ WHAT THIS IS AND IS NOT ────────────────────────────────────────────────┐
 * │ These routes exist so a human can watch the real claim cycle happen in a  │
 * │ browser. They supply only the parts a browser cannot: a faucet-funded     │
 * │ attendee wallet, and a signature from that wallet.                        │
 * │                                                                           │
 * │ THEY DO NOT WRAP THE REAL API. The page drives                            │
 * │ POST /events/:eventId/claims, POST /.../confirm, GET /verify,             │
 * │ GET /roster and GET /attendance directly. A demo that exercised a         │
 * │ parallel code path would prove nothing about the code that ships, so      │
 * │ /demo/state OBSERVES those routes rather than replacing them: it reads    │
 * │ the claim slot and the attendance index they wrote. Nothing is fed back   │
 * │ in from the page, so the demo cannot drift from reality.                  │
 * └───────────────────────────────────────────────────────────────────────────┘
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
 * And the attendee seed lives in a `#private` field of DemoState for the life
 * of the process. It is never written to disk, never returned, never logged.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Wallet } from "xrpl";
import { z } from "zod";
import { XrplLayerError } from "../../errors.js";
import type { AttendanceRecord } from "../../types.js";
import { assertDemoAllowed, DemoState, type DemoOptions } from "../demo-state.js";
import type { ApiDeps } from "../deps.js";
import { sendError } from "../http-errors.js";

/**
 * The UI file. Owned by the page, not by this module: it is read off disk and
 * served as-is. Repo-relative form is what goes in the 503 message — an
 * absolute server path in a response body helps nobody and leaks the layout.
 */
export const DEMO_HTML_REPO_PATH = "src/api/public/demo.html";

const DEFAULT_DEMO_HTML_PATH = fileURLToPath(new URL("../public/demo.html", import.meta.url));

/**
 * Body of POST /demo/attendee. `nullish` because fastify hands a bodyless POST
 * a literal `null`, and "no body" has to mean the default rather than a 400 —
 * the page's first call is a bare button press.
 */
const attendeeBodySchema = z
  .object({ funded: z.boolean().optional() })
  .nullish()
  .transform((body) => body ?? {});

type AttendeeBody = z.infer<typeof attendeeBodySchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the page off disk. Every failure is the same answer — a 503 naming the
 * file — because the only interesting distinction to an operator is "the UI is
 * not there yet".
 */
function readDemoHtml(path: string): string | undefined {
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
async function syncFromStores(
  deps: ApiDeps,
  state: DemoState,
): Promise<AttendanceRecord | null> {
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

/** 409 in the one shape the UI already handles. */
function conflict(reply: FastifyReply, message: string, details?: Record<string, unknown>): FastifyReply {
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
  const htmlPath = demo.htmlPath ?? DEFAULT_DEMO_HTML_PATH;

  // Registration-time read (no @fastify/static, no plugin). Kept as a fallback
  // for the request path, which re-reads so that edits to the page show up on
  // refresh rather than needing a restart.
  const htmlAtBoot = readDemoHtml(htmlPath);

  // GUARD 4. One line, once, and it says what is now possible.
  app.log.warn(
    { network: deps.config.network, endpoint: deps.config.endpoint, eventId: state.eventId },
    "DEMO ROUTES ARE LIVE at /demo — this build can generate wallets, take faucet funds and " +
      "sign transactions as an attendee. Testnet only. Never run this configuration against mainnet.",
  );

  if (htmlAtBoot === undefined) {
    app.log.warn(
      { path: DEMO_HTML_REPO_PATH },
      "the demo UI file does not exist yet; GET /demo will answer 503 until it does",
    );
  }

  /**
   * Encapsulated so the mainnet hook below covers these routes and nothing
   * else. Deliberately OUTSIDE the rate-limited scope in server.ts, alongside
   * /health: the page polls /demo/state, and a poll loop eating the 120/min
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

    /**
     * GET /demo — the page itself.
     *
     * 200 text/html | 503 the UI file has not been built yet
     */
    scope.get("/demo", async (_request, reply) => {
      const html = readDemoHtml(htmlPath) ?? htmlAtBoot;
      if (html === undefined) {
        // A missing page is an operator problem, not a crash. The server keeps
        // serving the API — including the rest of /demo/* — either way.
        return sendError(
          reply,
          503,
          "NOT_FOUND",
          `The demo UI has not been built yet: ${DEMO_HTML_REPO_PATH} does not exist. ` +
            "Create that file (the API half of the demo is already running), then reload.",
          { path: DEMO_HTML_REPO_PATH },
        );
      }
      return reply.code(200).type("text/html; charset=utf-8").send(html);
    });

    /**
     * GET /demo/state — everything the page renders, polled.
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

    /**
     * POST /demo/attendee { funded?: boolean } — a throwaway attendee wallet.
     *
     * `funded: true` (the default) takes faucet money, which activates the
     * account. `funded: false` generates a keypair and stops there, so the
     * address genuinely does not exist on the ledger — that is what makes the
     * sponsorship branch of POST /claims real rather than staged.
     *
     * 201 { address, balanceXrp, activated }
     */
    scope.post<{ Body: AttendeeBody }>(
      "/demo/attendee",
      { schema: { body: attendeeBodySchema } },
      async (request, reply) => {
        const funded = request.body?.funded ?? true;

        // The seed goes straight into DemoState's #private field and nowhere
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
     * POST /demo/accept — sign the claim offer as the attendee.
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
        return conflict(
          reply,
          "The badge was accepted but no NFTokenID has been observed for it yet.",
          { eventId: state.eventId, address: wallet.classicAddress },
        );
      }

      const burned = await demo.ops.burn(deps.gateway, { nftokenId, wallet });
      state.markBurned(burned.txHash);

      return reply.code(200).send({ txHash: burned.txHash });
    });

    /**
     * POST /demo/reset — a fresh event id, and forget the attendee.
     *
     * Touches nothing on the ledger. The previous badge stays exactly where it
     * is and still verifies against its own event; that is the point of a new
     * taxon rather than a cleanup.
     *
     * 200 { eventId }
     */
    scope.post("/demo/reset", async (_request, reply) => {
      const eventId = state.reset();
      return reply.code(200).send({ eventId });
    });
  });
}
