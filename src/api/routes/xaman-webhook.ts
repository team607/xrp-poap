/**
 * POST /webhooks/xaman — Xaman tells us a payload resolved.
 *
 * THE BODY IS UNTRUSTED INPUT. This endpoint is public and unauthenticated;
 * Xaman does not sign its callbacks, so anyone who finds the URL can post
 * anything they like to it. Nothing in the body is treated as evidence: the
 * uuid, the account and the custom_meta blob are hints that tell us *what to go
 * and check*, and the ledger is the only authority on whether the claim
 * actually happened (brief 6.4). A forged delivery costs an attacker one
 * pointless verifyClaim call and nothing else.
 *
 * Always answers 2xx once the body is recognisably a Xaman delivery. A webhook
 * that returns 4xx/5xx gets retried, and "this claim did not verify" is not
 * something a retry will fix.
 */
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../deps.js";
import { addressSchema, txHashSchema } from "../http-errors.js";
import { parseXamanClaimMeta, parseXamanWebhook } from "../../xaman/payloads.js";
import { verifyThenRecord } from "./claims.js";

export function registerXamanWebhookRoute(app: FastifyInstance, deps: ApiDeps): void {
  /**
   * POST /webhooks/xaman
   *
   * 200 acknowledged (recorded or not — the body says which)
   * 400 not a Xaman webhook body | 502 ledger trouble
   *
   * Idempotent: a replayed delivery re-verifies, finds the existing row and
   * returns 200 without inserting a second one.
   */
  app.post("/webhooks/xaman", async (request, reply) => {
    // Throws ValidationError -> 400 when this is not a Xaman delivery at all.
    const event = parseXamanWebhook(request.body);
    const hints = parseXamanClaimMeta(request.body);

    if (!event.signed || event.rejected) {
      request.log.info({ payloadUuid: event.payloadUuid }, "Xaman payload rejected or unsigned");
      return reply.code(200).send({ ok: true, recorded: false, reason: "not_signed" });
    }

    const address = addressSchema.safeParse(event.account ?? hints.attendeeAddress);
    const txHash = txHashSchema.safeParse(event.txHash);
    const eventId = hints.eventId;

    if (!address.success || !txHash.success || eventId === undefined) {
      // Signed, but we cannot say what it was for. Acknowledge and move on; the
      // attendee can still complete the claim through the confirm route.
      request.log.warn(
        {
          payloadUuid: event.payloadUuid,
          hasAddress: address.success,
          hasTxHash: txHash.success,
          hasEventId: eventId !== undefined,
        },
        "signed Xaman payload could not be tied to a claim",
      );
      return reply.code(200).send({ ok: true, recorded: false, reason: "incomplete_payload" });
    }

    // `hints.offerId` came out of the body, so it goes in as a hint and never
    // as a value to store: a forged delivery naming `0BAD…` used to have that
    // string written straight into the attendance row. verifyThenRecord()
    // persists the offer the accept transaction actually consumed instead.
    const outcome = await verifyThenRecord(
      deps,
      {
        eventId,
        address: address.data,
        txHash: txHash.data,
        ...(hints.offerId ? { claimedOfferId: hints.offerId } : {}),
      },
      request.log,
    );

    if (!outcome.verification.attended) {
      request.log.warn(
        {
          payloadUuid: event.payloadUuid,
          eventId,
          failedCheck: outcome.verification.failedCheck,
        },
        "Xaman reported a signature the ledger does not confirm",
      );
      return reply.code(200).send({
        ok: true,
        recorded: false,
        reason: "verification_failed",
        verification: outcome.verification,
      });
    }

    return reply.code(200).send({
      ok: true,
      recorded: !outcome.alreadyRecorded,
      alreadyRecorded: outcome.alreadyRecorded,
      record: outcome.record,
    });
  });
}
