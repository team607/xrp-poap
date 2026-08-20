/**
 * REAP OFFERS — cancel the claim offers nobody ever accepted.
 *
 * Brief section 7: an open `NFTokenOffer` locks 0.2 XRP of the ISSUER's owner
 * reserve for as long as it exists. Accepting it releases the reserve.
 * Cancelling it releases the reserve. Doing neither locks the money forever,
 * and the recommended issuer float is 10 XRP — fifty abandoned claims and the
 * event stops minting.
 *
 * Every claim that is offered and never signed leaves one of those behind: a
 * flat battery, a queue that moved on, a QR code that expired. This is the only
 * thing in the system that gets that 0.2 XRP back.
 *
 * It finds them from `ClaimRepository.listExpired()` rather than by walking
 * `account_objects`, because the offer id is written to the claim slot at claim
 * time. That is why it can name the attendee and the event for every offer it
 * cancels, instead of reporting anonymous ledger objects.
 *
 * SAFE BY DEFAULT — a bare run only reports. Nothing is submitted without
 * `--apply`.
 *
 * RUN:
 *   npx tsx scripts/reap-offers.ts                    # dry run, the default
 *   npx tsx scripts/reap-offers.ts --apply
 *   npx tsx scripts/reap-offers.ts --apply --limit=50
 *   npx tsx scripts/reap-offers.ts --apply --i-understand-this-spends-real-xrp
 *
 * FLAGS:
 *   --apply       actually cancel. Without it nothing is submitted.
 *   --dry-run     the default, and it beats --apply if you pass both
 *   --limit=N     how many expired claims to consider (default 200)
 *   --i-understand-this-spends-real-xrp   required on mainnet, where each
 *                 cancellation burns a real (tiny) fee
 *
 * Run it on a timer. Every claim offer this misses is 0.2 XRP the issuer cannot
 * spend.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { closePool, createPool } from "../src/db/pool.js";
import { PgClaimRepository } from "../src/db/claim-repo.js";
import { isRippledError, withGateway } from "../src/xrpl/client.js";
import { cancelClaimOffer } from "../src/xrpl/offers.js";
import type { ClaimRecord, ClaimRepository, NetworkName, XrplGateway } from "../src/types.js";
import {
  createReport,
  explorerTxUrls,
  formatXrp,
  registerSecret,
} from "./lib/report.js";

const CONSENT_FLAG = "--i-understand-this-spends-real-xrp";

/** Brief section 7: one ledger object, one owner reserve. */
const OWNER_RESERVE_DROPS = 200_000n;

const DEFAULT_LIMIT = 200;

/**
 * rippled's several ways of saying "that offer is not there".
 *
 * An offer can vanish between listExpired() and the cancel: the attendee
 * finally signed, or a previous run of this script already got it. That is a
 * SKIP, not a failure — the reserve is released either way, which is the whole
 * point.
 */
const OFFER_GONE_CODES = [
  "entryNotFound",
  "objectNotFound",
  "tecOBJECT_NOT_FOUND",
  "tecNO_ENTRY",
  "temMALFORMED",
];

const r = createReport("reap-offers — release the reserve abandoned claims are holding");

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  apply: boolean;
  limit: number;
  consent: boolean;
}

function flagValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length).trim();
}

export function parseArgs(argv: string[]): Args {
  const limitRaw = flagValue(argv, "limit");
  const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number.parseInt(limitRaw, 10);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer, got "${limitRaw}"`);
  }

  return {
    // --dry-run is what you get by saying nothing, and it wins outright when
    // both are given: "--dry-run --apply" is a mistake, and the safe reading of
    // a mistake is the one that submits nothing.
    apply: argv.includes("--apply") && !argv.includes("--dry-run"),
    limit,
    consent: argv.includes(CONSENT_FLAG),
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Is the offer object still on the ledger?
 *
 * An NFTokenOffer's ledger index IS its offer id, so this is a direct lookup
 * rather than a walk. Asking first turns "the attendee signed thirty seconds
 * ago" from a failed transaction into a clean skip.
 *
 * Returns undefined when the node could not answer — then we try the cancel
 * anyway rather than assuming.
 */
async function offerStillOpen(gateway: XrplGateway, offerId: string): Promise<boolean | undefined> {
  try {
    await gateway.request({ command: "ledger_entry", index: offerId, ledger_index: "validated" });
    return true;
  } catch (err) {
    if (OFFER_GONE_CODES.some((code) => isRippledError(err, code))) return false;
    return undefined;
  }
}

function isOfferGoneError(err: unknown): boolean {
  return OFFER_GONE_CODES.some((code) => isRippledError(err, code));
}

function describeClaim(claim: ClaimRecord): string {
  const expired = claim.expiresAt ? new Date(claim.expiresAt).toISOString() : "no expiry";
  return `event ${claim.eventId} · ${claim.address} · expired ${expired}`;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface Tally {
  scanned: number;
  cancelled: number;
  alreadyGone: number;
  noOfferId: number;
  failed: number;
  wouldCancel: number;
}

/** Exported so the loop can be driven with a fake gateway and a fake repository. */
export async function reap(
  gateway: XrplGateway,
  claims: ClaimRepository,
  args: Args,
  network: NetworkName,
): Promise<Tally> {
  const tally: Tally = {
    scanned: 0,
    cancelled: 0,
    alreadyGone: 0,
    noOfferId: 0,
    failed: 0,
    wouldCancel: 0,
  };

  const expired = await claims.listExpired(new Date(), args.limit);
  tally.scanned = expired.length;

  r.info("expired claims found", expired.length);
  if (expired.length === 0) {
    r.ok("Nothing to reap. No pending claim is past its expiry.");
    return tally;
  }
  if (expired.length === args.limit) {
    r.warn(`Hit the --limit of ${args.limit}. There may be more; run again after this one.`);
  }
  r.blank();

  for (const claim of expired) {
    const label = describeClaim(claim);

    if (!claim.offerId) {
      // A slot that never got as far as an offer. No reserve is held, so there
      // is nothing here to reclaim — but say so rather than silently passing.
      tally.noOfferId += 1;
      r.skip(`claim ${claim.id}`, `${label} — no offer id recorded, nothing locked`);
      continue;
    }

    const open = await offerStillOpen(gateway, claim.offerId);

    if (open === false) {
      tally.alreadyGone += 1;
      r.skip(
        `offer ${claim.offerId}`,
        `${label} — already gone from the ledger (accepted, or cancelled earlier)`,
      );
      if (args.apply) {
        await claims.markAbandoned(claim.id);
        r.note("  claim slot closed out");
      }
      continue;
    }

    if (open === undefined) {
      r.warn(`could not confirm offer ${claim.offerId} exists; attempting the cancel anyway`);
    }

    if (!args.apply) {
      tally.wouldCancel += 1;
      r.note(`WOULD CANCEL  ${claim.offerId}  ${label}`);
      continue;
    }

    try {
      const cancelled = await cancelClaimOffer(gateway, claim.offerId);
      await claims.markAbandoned(claim.id);
      tally.cancelled += 1;
      r.ok(`cancelled ${claim.offerId} — ${label}`);
      r.link("  cancel tx", explorerTxUrls(network, cancelled.txHash)[0] ?? cancelled.txHash);
    } catch (err) {
      if (isOfferGoneError(err)) {
        // It went away between the check and the submit. Still a win.
        tally.alreadyGone += 1;
        await claims.markAbandoned(claim.id);
        r.skip(`offer ${claim.offerId}`, `${label} — vanished mid-flight; slot closed out`);
        continue;
      }
      tally.failed += 1;
      r.caught(err, `cancelling ${claim.offerId}`);
      r.note(`  ${label} — left pending, the next run will try again`);
    }
  }

  return tally;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // A dry run only reports; it signs nothing, so it must not demand a signing
  // key. Requiring one would mean you cannot inspect the leak without putting
  // the issuer seed on the box you inspect it from.
  const cfg = loadConfig({ requireIssuer: args.apply });
  registerSecret(cfg.issuerSeed);

  if (args.apply && cfg.issuerSeed === "") {
    r.fail("--apply needs ISSUER_SEED: cancelling an offer is a signed transaction.");
    r.finish();
    return;
  }

  r.header(
    `${args.apply ? "APPLY — offers will be cancelled" : "DRY RUN — nothing will be submitted"} · ` +
      `${cfg.network} · ${cfg.endpoint}`,
  );

  if (!args.apply) {
    r.note("Dry run is the default. Re-run with --apply to actually cancel.");
  }

  // -- 1: guard rails --------------------------------------------------------
  r.step(1, "Guard rails");

  r.info("network", cfg.network);
  r.info("issuer", cfg.issuerAddress);
  r.info("limit", args.limit);

  if (cfg.network === "mainnet" && !args.consent) {
    r.check("mainnet consent given", false, `pass ${CONSENT_FLAG}`);
    r.blank();
    r.note("This is the real issuer. Every cancellation is a real transaction and burns a real fee.");
    r.note("It is a safe operation — it only releases reserve back to the issuer — but it is not free,");
    r.note("and a script that touches mainnet without being told to is how a bad morning starts.");
    r.note("REFUSING TO RUN.");
    return;
  }
  r.check(
    "network consent",
    true,
    cfg.network === "mainnet" ? `mainnet, ${CONSENT_FLAG} given` : cfg.network,
  );

  if (!cfg.databaseUrl) {
    r.check("DATABASE_URL is set", false, "unset");
    r.blank();
    r.note("Without a database the claim slots live in the API process's memory, so there is no");
    r.note("durable record of which offers exist. Nothing can be reaped from here.");
    r.note("Set DATABASE_URL to the same database the API uses, or cancel the offers by hand:");
    r.note("  npx tsx scripts/check-cutover.ts   # reports the issuer's pending offer count");
    r.note("REFUSING TO RUN.");
    return;
  }
  r.check("DATABASE_URL is set", true, "claim slots are durable");

  // -- 2: reap ---------------------------------------------------------------
  r.step(2, args.apply ? "Cancel every expired claim offer" : "Report every expired claim offer");

  const pool = createPool(cfg.databaseUrl);
  const claims = new PgClaimRepository(pool);
  let tally: Tally;

  try {
    tally = await withGateway(cfg, (gateway) => reap(gateway, claims, args, cfg.network), {
      connectTimeoutMs: 20_000,
    });
  } finally {
    await closePool(pool);
  }

  // -- 3: the number that matters -------------------------------------------
  r.step(3, "Reserve");

  const releasedCount = args.apply ? tally.cancelled : tally.wouldCancel;
  const releasedDrops = OWNER_RESERVE_DROPS * BigInt(releasedCount);

  r.info("claims scanned", tally.scanned);
  r.info(args.apply ? "offers cancelled" : "offers that would be cancelled", releasedCount);
  r.info("already gone from the ledger", tally.alreadyGone);
  r.info("slots with no offer id", tally.noOfferId);
  r.info("failures", tally.failed);
  r.info("reserve per offer (XRP)", formatXrp(OWNER_RESERVE_DROPS));
  r.info(
    args.apply ? "XRP RECLAIMED" : "XRP RECLAIMABLE",
    `${formatXrp(releasedDrops)} XRP`,
  );

  if (tally.failed > 0) {
    r.check("every cancellation succeeded", false, `${tally.failed} failed — see above`);
  } else if (releasedCount > 0 || tally.alreadyGone > 0 || tally.scanned === 0) {
    r.check("every expired claim was dealt with", true, `${tally.scanned} scanned`);
  }

  if (!args.apply && tally.wouldCancel > 0) {
    r.blank();
    r.note(`Re-run with --apply to release ${formatXrp(releasedDrops)} XRP.`);
  }
}

/**
 * Guarded because `reap()` and `parseArgs()` are exported: importing this
 * module to drive the loop against a fake gateway must not start connecting to
 * a real one.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  run()
    .catch((err: unknown) => {
      r.caught(err, "run aborted");
    })
    .then(() => r.finish());
}
