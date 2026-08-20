/**
 * 03 — MAINNET REHEARSAL. Brief section 8, step 6:
 *
 *     "Switch endpoint, fund the real issuer, run one full claim with your own
 *      second account. Confirm on an explorer."
 *
 * THIS SCRIPT SPENDS REAL XRP. Every state-changing step stops and asks first,
 * and it will not start at all without all four of:
 *
 *     XRPL_NETWORK=mainnet
 *     ISSUER_SEED / ISSUER_ADDRESS in the environment, funded with 10+ XRP
 *     --i-understand-this-spends-real-xrp
 *     --attendee=r...   (your own second real account — never a default)
 *
 * It mints one badge, creates the destination-locked offer, prints the accept
 * payload, and then STOPS. The attendee signs from their own wallet — that is
 * the whole point of the rehearsal, and we never hold their key. It then polls
 * until the badge lands, and runs verifyClaim() against the real accept hash.
 *
 * RUN:
 *   npm run e2e:mainnet -- --i-understand-this-spends-real-xrp --attendee=rYOUR_SECOND_ACCOUNT
 *   npx tsx scripts/03-mainnet-rehearsal.ts \
 *       --i-understand-this-spends-real-xrp \
 *       --attendee=rYOUR_SECOND_ACCOUNT \
 *       --uri=ipfs://<CID>/metadata.json \
 *       --event=20250101 \
 *       --wait-minutes=10
 *
 * FLAGS:
 *   --yes                  skip the confirmation prompts (do not use casually)
 *   --cancel-on-timeout    cancel the offer if nobody accepts, releasing 0.2 XRP
 */
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { isValidClassicAddress, xrpToDrops } from "xrpl";
import { describeConfig, loadConfig, type AppConfig } from "../src/config.js";
import { withGateway } from "../src/xrpl/client.js";
import { mint } from "../src/xrpl/mint.js";
import {
  buildAcceptOfferPayload,
  cancelClaimOffer,
  countPendingIssuerOffers,
  createClaimOffer,
} from "../src/xrpl/offers.js";
import { accountExists, getAccountBalanceXrp } from "../src/xrpl/sponsor.js";
import { verifyClaim } from "../src/xrpl/verify.js";
import type { XrplGateway } from "../src/types.js";
import {
  createReport,
  explorerAccountUrls,
  explorerTxUrls,
  formatXrp,
  registerSecret,
} from "./lib/report.js";

const CONSENT_FLAG = "--i-understand-this-spends-real-xrp";

/** Brief section 7. Overridden by the live values from server_info when present. */
const FALLBACK_BASE_RESERVE_XRP = "1";
const FALLBACK_OWNER_RESERVE_XRP = "0.2";

/** Recommended issuer float, brief section 1 and 7. */
const MIN_FLOAT_XRP = "10";

const DEFAULT_EVENT_ID = 20_250_101;
const DEFAULT_URI = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/metadata.json";
const DEFAULT_WAIT_MINUTES = 10;
const POLL_SECONDS = 10;

const r = createReport("03 · MAINNET REHEARSAL — this spends real XRP");

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  consent: boolean;
  attendee: string | undefined;
  eventId: number;
  uri: string;
  uriIsDefault: boolean;
  waitMinutes: number;
  autoYes: boolean;
  cancelOnTimeout: boolean;
}

function flagValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length).trim();
}

function parseArgs(argv: string[]): Args {
  const eventRaw = flagValue(argv, "event");
  const uriRaw = flagValue(argv, "uri");
  const waitRaw = flagValue(argv, "wait-minutes");

  const eventId = eventRaw === undefined ? DEFAULT_EVENT_ID : Number.parseInt(eventRaw, 10);
  if (!Number.isInteger(eventId) || eventId < 0) {
    throw new Error(`--event must be a non-negative integer, got "${eventRaw}"`);
  }

  const waitMinutes = waitRaw === undefined ? DEFAULT_WAIT_MINUTES : Number.parseInt(waitRaw, 10);
  if (!Number.isInteger(waitMinutes) || waitMinutes < 0) {
    throw new Error(`--wait-minutes must be a non-negative integer, got "${waitRaw}"`);
  }

  return {
    consent: argv.includes(CONSENT_FLAG),
    attendee: flagValue(argv, "attendee"),
    eventId,
    uri: uriRaw === undefined || uriRaw === "" ? DEFAULT_URI : uriRaw,
    uriIsDefault: uriRaw === undefined || uriRaw === "",
    waitMinutes,
    autoYes: argv.includes("--yes"),
    cancelOnTimeout: argv.includes("--cancel-on-timeout"),
  };
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

/**
 * Every irreversible step goes through here. Real money makes a typo expensive,
 * so the answer must be the literal word "yes" — not "y", not a bare Enter.
 */
async function confirm(question: string, autoYes: boolean): Promise<boolean> {
  if (autoYes) {
    r.note(`--yes: proceeding without asking — ${question}`);
    return true;
  }
  if (process.stdin.isTTY !== true) {
    r.fail("stdin is not a terminal, so this script cannot ask for confirmation.");
    r.note("Run it interactively, or pass --yes if you genuinely mean to skip every prompt.");
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`\n  ${question}\n  Type "yes" to continue: `);
    const ok = answer.trim().toLowerCase() === "yes";
    if (!ok) r.warn(`Answer was "${answer.trim()}" — not "yes". Stopping.`);
    return ok;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

interface ReserveModel {
  baseDrops: bigint;
  ownerDrops: bigint;
  source: "server_info" | "brief section 7 defaults";
}

async function readReserves(gateway: XrplGateway): Promise<ReserveModel> {
  try {
    const info = await gateway.request({ command: "server_info" });
    const ledger = info?.result?.info?.validated_ledger as Record<string, unknown> | undefined;
    const base = ledger?.reserve_base_xrp;
    const owner = ledger?.reserve_inc_xrp;
    if (base !== undefined && owner !== undefined) {
      return {
        baseDrops: BigInt(xrpToDrops(String(base))),
        ownerDrops: BigInt(xrpToDrops(String(owner))),
        source: "server_info",
      };
    }
  } catch {
    /* fall through to the documented defaults */
  }
  return {
    baseDrops: BigInt(xrpToDrops(FALLBACK_BASE_RESERVE_XRP)),
    ownerDrops: BigInt(xrpToDrops(FALLBACK_OWNER_RESERVE_XRP)),
    source: "brief section 7 defaults",
  };
}

async function ownerCount(gateway: XrplGateway, address: string): Promise<number> {
  const res = await gateway.request({
    command: "account_info",
    account: address,
    ledger_index: "validated",
  });
  return Number(res?.result?.account_data?.OwnerCount ?? 0);
}

async function holdsNft(gateway: XrplGateway, address: string, nftokenId: string): Promise<boolean> {
  const res = await gateway.request({ command: "account_nfts", account: address, limit: 400 });
  const nfts: Array<{ NFTokenID?: string }> = res?.result?.account_nfts ?? [];
  return nfts.some((n) => (n.NFTokenID ?? "").toUpperCase() === nftokenId.toUpperCase());
}

/**
 * The attendee signed from their own wallet, so we never saw the hash. Find it:
 * nft_history first (Clio, exact), then account_tx as a fallback.
 */
async function findAcceptTxHash(
  gateway: XrplGateway,
  params: { nftokenId: string; offerId: string; attendee: string },
): Promise<string | undefined> {
  try {
    const history = await gateway.request({ command: "nft_history", nft_id: params.nftokenId });
    const entries: Array<Record<string, any>> = history?.result?.transactions ?? [];
    for (const entry of entries) {
      const tx = entry.tx_json ?? entry.tx ?? entry;
      if (tx?.TransactionType === "NFTokenAcceptOffer" && tx?.Account === params.attendee) {
        const hash = entry.hash ?? tx.hash;
        if (typeof hash === "string") return hash;
      }
    }
  } catch {
    /* not a Clio node, or the history is not ready yet */
  }

  try {
    const res = await gateway.request({
      command: "account_tx",
      account: params.attendee,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: 50,
    });
    const entries: Array<Record<string, any>> = res?.result?.transactions ?? [];
    for (const entry of entries) {
      const tx = entry.tx_json ?? entry.tx ?? entry;
      if (
        tx?.TransactionType === "NFTokenAcceptOffer" &&
        String(tx?.NFTokenSellOffer ?? "").toUpperCase() === params.offerId.toUpperCase()
      ) {
        const hash = entry.hash ?? tx.hash;
        if (typeof hash === "string") return hash;
      }
    }
  } catch {
    /* fall through */
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** Returns the config only when every refusal condition is clear. */
function preflight(args: Args): AppConfig | undefined {
  const cfg = loadConfig({ requireIssuer: false });
  registerSecret(cfg.issuerSeed);

  r.header(`brief section 8 step 6 · ${cfg.endpoint}`);
  r.json("config (redacted)", describeConfig(cfg));

  let refused = false;
  const refuse = (name: string, detail: string): void => {
    r.check(name, false, detail);
    refused = true;
  };

  // 1. mainnet, and only mainnet.
  if (cfg.network === "mainnet") r.check("XRPL_NETWORK is mainnet", true, cfg.network);
  else refuse("XRPL_NETWORK is mainnet", `got "${cfg.network}" — this is the mainnet rehearsal`);

  // 2. a real, funded issuer.
  if (cfg.issuerSeed !== "") r.check("ISSUER_SEED is set", true, "[redacted]");
  else refuse("ISSUER_SEED is set", "no issuer seed in the environment — nothing can be signed");

  if (cfg.issuerAddress !== "") r.check("ISSUER_ADDRESS is set", true, cfg.issuerAddress);
  else refuse("ISSUER_ADDRESS is set", "set it to the address the seed derives");

  // 3. explicit, typed-out consent.
  if (args.consent) r.check("consent flag given", true, CONSENT_FLAG);
  else refuse("consent flag given", `pass ${CONSENT_FLAG} — this mints on mainnet with real XRP`);

  // 4. a named attendee. There is deliberately no default.
  if (args.attendee === undefined || args.attendee === "") {
    refuse("--attendee=r... supplied", "pass your own second real account. There is no default.");
  } else if (!isValidClassicAddress(args.attendee)) {
    refuse("--attendee=r... supplied", `"${args.attendee}" is not a valid XRPL classic address`);
  } else if (args.attendee === cfg.issuerAddress) {
    refuse("--attendee=r... supplied", "the attendee cannot be the issuer — use a second account");
  } else {
    r.check("--attendee=r... supplied", true, args.attendee);
  }

  if (refused) {
    r.blank();
    r.note("REFUSING TO RUN. Nothing was sent to the ledger.");
    r.note("Example:");
    r.note(`  XRPL_NETWORK=mainnet XRPL_ENDPOINT=wss://xrplcluster.com \\`);
    r.note(`  npx tsx scripts/03-mainnet-rehearsal.ts ${CONSENT_FLAG} --attendee=rYOURSECONDACCOUNT`);
    return undefined;
  }

  return cfg;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = preflight(args);
  if (cfg === undefined) return;

  const attendee = args.attendee as string;

  await withGateway(
    cfg,
    async (gw) => {
      // -- 1: the money ------------------------------------------------------
      r.step(1, "Issuer balance and reserve math (brief section 7)");

      const reserves = await readReserves(gw);
      const balanceXrp = await getAccountBalanceXrp(gw, gw.issuerAddress);
      const balanceDrops = BigInt(xrpToDrops(balanceXrp));
      const objects = await ownerCount(gw, gw.issuerAddress);
      const lockedDrops = reserves.baseDrops + reserves.ownerDrops * BigInt(objects);
      const spendableDrops = balanceDrops - lockedDrops;
      const minFloatDrops = BigInt(xrpToDrops(MIN_FLOAT_XRP));

      r.info("issuer", gw.issuerAddress);
      r.info("reserve source", reserves.source);
      r.info("base reserve", `${formatXrp(reserves.baseDrops)} XRP  (locked while the account exists)`);
      r.info("owner reserve", `${formatXrp(reserves.ownerDrops)} XRP  per ledger object owned`);
      r.info("objects owned now", `${objects}  ->  ${formatXrp(reserves.ownerDrops * BigInt(objects))} XRP locked`);
      r.info("total reserve locked", `${formatXrp(lockedDrops)} XRP`);
      r.info("balance", `${balanceXrp} XRP`);
      r.info("spendable", `${formatXrp(spendableDrops)} XRP`);
      r.blank();
      r.note("This run will add, temporarily:");
      r.note(`  NFTokenPage   up to ${formatXrp(reserves.ownerDrops)} XRP  (only if no existing page has room; holds ~16-24 badges)`);
      r.note(`  NFTokenOffer       ${formatXrp(reserves.ownerDrops)} XRP  (released the moment the offer is accepted or cancelled)`);
      r.note("  2 transaction fees   ~0.00003 XRP  BURNED, not recoverable");
      r.note("Reserves are locked in your own account, not transferred. Fees are gone.");

      if (balanceDrops < minFloatDrops) {
        const shortfall = minFloatDrops - balanceDrops;
        r.check(
          `issuer holds at least ${MIN_FLOAT_XRP} XRP`,
          false,
          `have ${balanceXrp} XRP, need ${MIN_FLOAT_XRP} XRP, SHORT ${formatXrp(shortfall)} XRP`,
        );
        r.blank();
        r.note(`Send ${formatXrp(shortfall)} XRP to ${gw.issuerAddress} and re-run.`);
        r.note("REFUSING TO PROCEED. Nothing was sent to the ledger.");
        return;
      }
      r.check(`issuer holds at least ${MIN_FLOAT_XRP} XRP`, true, `${balanceXrp} XRP`);

      const pendingBefore = await countPendingIssuerOffers(gw, gw.issuerAddress);
      r.info("pending offers now", `${pendingBefore}  (${formatXrp(reserves.ownerDrops * BigInt(pendingBefore))} XRP locked)`);

      // -- 2: the attendee ---------------------------------------------------
      r.step(2, "Check the attendee account");

      const active = await accountExists(gw, attendee);
      if (!r.check("attendee account is activated", active, attendee)) {
        r.blank();
        r.note("An unactivated address cannot receive an NFT (brief 5.4).");
        r.note(`Send at least ${formatXrp(reserves.baseDrops)} XRP to ${attendee} first.`);
        r.note("This script will NOT sponsor a mainnet account for you.");
        return;
      }
      r.links("attendee on explorer", explorerAccountUrls(cfg.network, attendee));

      // -- 3: mint -----------------------------------------------------------
      r.step(3, "Mint one badge ON MAINNET");
      r.info("taxon (event id)", args.eventId);
      r.info("uri", args.uri);
      if (args.uriIsDefault) {
        r.warn("Using the built-in placeholder URI. A minted URI is IMMUTABLE and permanent.");
        r.warn("Pass --uri=ipfs://<your CID>/metadata.json to rehearse with the real metadata.");
      }

      if (
        !(await confirm(
          `MINT a real badge from ${gw.issuerAddress} with taxon ${args.eventId}? This spends real XRP.`,
          args.autoYes,
        ))
      ) {
        r.warn("Not confirmed. Nothing was sent to the ledger.");
        return;
      }

      const badge = await mint(gw, { eventId: args.eventId, uri: args.uri });
      r.check("badge minted", badge.nftokenId.length === 64, badge.nftokenId);
      r.info("nftoken id", badge.nftokenId);
      r.info("mint tx", badge.txHash);
      r.info("fee burned", `${formatXrp(badge.fee)} XRP`);
      r.links("mint on explorer", explorerTxUrls(cfg.network, badge.txHash));
      r.links("issuer on explorer", explorerAccountUrls(cfg.network, gw.issuerAddress));
      r.note("Cutover checklist: confirm the badge is visible under the issuer address, above.");

      // -- 4: offer ----------------------------------------------------------
      r.step(4, "Create the destination-locked claim offer");
      r.note(`Destination = ${attendee}. Without it, ANYONE could accept and take the badge.`);

      if (
        !(await confirm(
          `CREATE a claim offer for ${badge.nftokenId} locked to ${attendee}? This locks ${formatXrp(reserves.ownerDrops)} XRP.`,
          args.autoYes,
        ))
      ) {
        r.warn("Not confirmed. The badge is minted and stays with the issuer; no offer was created.");
        return;
      }

      const offer = await createClaimOffer(gw, {
        nftokenId: badge.nftokenId,
        destination: attendee,
      });
      r.check("offer created", offer.offerId.length === 64, offer.offerId);
      r.check("offer is locked to the attendee", offer.destination === attendee, offer.destination);
      r.info("offer id", offer.offerId);
      r.info("offer tx", offer.txHash);
      r.info("fee burned", `${formatXrp(offer.fee)} XRP`);
      r.links("offer on explorer", explorerTxUrls(cfg.network, offer.txHash));

      // -- 5: hand over ------------------------------------------------------
      r.step(5, "STOP — the attendee signs this from their own wallet");

      const payload = buildAcceptOfferPayload({ offerId: offer.offerId, attendeeAddress: attendee });

      r.blank();
      r.note("Send this payload to the attendee (Xaman deeplink, QR, or paste it). We never see their key.");
      r.blank();
      r.rule();
      console.log(JSON.stringify(payload, null, 2));
      r.rule();
      r.blank();
      r.links("watch the issuer account", explorerAccountUrls(cfg.network, gw.issuerAddress));
      r.links("watch the attendee account", explorerAccountUrls(cfg.network, attendee));

      // -- 6: wait -----------------------------------------------------------
      r.step(6, `Poll for the accept — up to ${args.waitMinutes} minute(s)`);

      const deadline = Date.now() + args.waitMinutes * 60_000;
      let landed = false;

      while (Date.now() < deadline) {
        try {
          if (await holdsNft(gw, attendee, badge.nftokenId)) {
            landed = true;
            break;
          }
        } catch (err) {
          r.warn(`poll failed, retrying: ${err instanceof Error ? err.message : String(err)}`);
        }
        const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        r.note(`not yet — ${remaining}s left, checking again in ${POLL_SECONDS}s`);
        await sleep(POLL_SECONDS * 1000);
      }

      if (!landed) {
        r.check("attendee accepted the offer", false, `no accept seen in ${args.waitMinutes} minute(s)`);
        r.blank();
        r.note(`The offer is still open: ${offer.offerId}`);
        r.note(`It holds ${formatXrp(reserves.ownerDrops)} XRP of owner reserve until accepted or cancelled.`);

        if (args.cancelOnTimeout) {
          if (await confirm(`CANCEL offer ${offer.offerId} and release the reserve?`, args.autoYes)) {
            const cancelled = await cancelClaimOffer(gw, offer.offerId);
            r.ok(`offer cancelled in ${cancelled.txHash}`);
            r.links("cancel on explorer", explorerTxUrls(cfg.network, cancelled.txHash));
          }
        } else {
          r.note("Re-run with --cancel-on-timeout to release it, or leave it open and let them claim later.");
        }
        return;
      }

      r.check("attendee accepted the offer", true, `${attendee} now holds ${badge.nftokenId}`);

      // -- 7: verify ---------------------------------------------------------
      r.step(7, "Find the accept transaction and verify the claim");

      const acceptHash = await findAcceptTxHash(gw, {
        nftokenId: badge.nftokenId,
        offerId: offer.offerId,
        attendee,
      });

      if (acceptHash === undefined) {
        r.check("accept transaction hash found", false, "not in nft_history or the last 50 account_tx entries");
        r.note("The badge did land. Find the NFTokenAcceptOffer hash on an explorer and verify by hand.");
        r.links("attendee on explorer", explorerAccountUrls(cfg.network, attendee));
        return;
      }

      r.check("accept transaction hash found", true, acceptHash);
      r.info("ATTENDANCE RECORD", acceptHash);
      r.links("accept on explorer", explorerTxUrls(cfg.network, acceptHash));

      const verified = await verifyClaim(gw, {
        address: attendee,
        eventId: args.eventId,
        txHash: acceptHash,
        issuerAddress: gw.issuerAddress,
      });
      r.json("verifyClaim result", verified);
      r.check("verifyClaim -> attended", verified.attended === true, `status=${verified.status}`);

      // -- 8: settle ---------------------------------------------------------
      r.step(8, "Reserves after the claim");

      const pendingAfter = await countPendingIssuerOffers(gw, gw.issuerAddress);
      r.info("pending offers now", pendingAfter);
      r.check(
        "the accepted offer released its reserve",
        pendingAfter <= pendingBefore,
        `${pendingBefore} -> ${pendingAfter}`,
      );
      r.info("issuer balance", `${await getAccountBalanceXrp(gw, gw.issuerAddress)} XRP`);
      r.blank();
      r.note("Mainnet rehearsal complete. Persist the attendance record hash above.");
    },
    { connectTimeoutMs: 20_000 },
  );
}

run()
  .catch((err: unknown) => {
    r.caught(err, "rehearsal aborted");
  })
  .then(() => r.finish());
