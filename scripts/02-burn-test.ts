/**
 * 02 — BURN TEST. Brief section 8, step 2. "This is a 20 minute check that
 * de-risks the entire verification story."
 *
 * The brief says: burn the badge, then call nft_info and nft_history and
 * inspect the raw responses — DO NOT TAKE THIS DOCUMENT'S WORD FOR IT. So this
 * script does not summarise. It runs a full claim, burns the badge from the
 * attendee wallet, and dumps every raw JSON response to stdout, before and
 * after the burn, so you can read for yourself exactly which fields survive.
 *
 * Then it re-runs verifyClaim() and asserts the single most important claim in
 * the architecture:
 *
 *     A BURNED BADGE IS STILL ATTENDANCE.
 *     attended: true, status: "attended_badge_burned"
 *
 * If that assertion ever fails, verification is broken and no amount of UI will
 * save it.
 *
 * RUN:
 *   npm run e2e:burn
 *   npx tsx scripts/02-burn-test.ts
 *   npx tsx scripts/02-burn-test.ts --event=20250102
 *
 * Use a CLIO endpoint. nft_info, nft_history and nfts_by_issuer are Clio
 * methods; a plain rippled answers `unknownCmd` and this script can only show
 * you half the picture:
 *   XRPL_ENDPOINT=wss://clio.altnet.rippletest.net:51233
 *
 * Raw responses are also written to out/burn-test-<taxon>.json so two runs can
 * be diffed. out/ is gitignored.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Wallet } from "xrpl";
import { loadConfig } from "../src/config.js";
import { XrplConnection, isRippledError, withGateway } from "../src/xrpl/client.js";
import { burn } from "../src/xrpl/burn.js";
import { mint } from "../src/xrpl/mint.js";
import { acceptOfferAs, createClaimOffer } from "../src/xrpl/offers.js";
import { verifyClaim } from "../src/xrpl/verify.js";
import type { XrplGateway } from "../src/types.js";
import {
  createReport,
  explorerTxUrls,
  formatXrp,
  redact,
  registerSecret,
} from "./lib/report.js";

const DEFAULT_EVENT_ID = 20_250_102;
const TEST_URI = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/metadata.json";
const PROBE_NFT_ID = `00080000${"0".repeat(56)}`;

/** rippled's several ways of saying "I do not implement that command". */
const METHOD_MISSING = ["unknownCmd", "notImpl", "notSupported"];

const CLIO_TESTNET = "wss://clio.altnet.rippletest.net:51233";

const r = createReport("02 · burn test — does a burned badge still verify?");

// ---------------------------------------------------------------------------
// Raw capture
// ---------------------------------------------------------------------------

interface RawCapture {
  label: string;
  request: Record<string, unknown>;
  ok: boolean;
  /** Verbatim. Not normalised, not reshaped — that is the entire point. */
  response?: unknown;
  error?: { code?: string; message: string };
  /** True when the node does not implement the command at all. */
  unsupported: boolean;
}

/** Never throws. A missing Clio method must not abort the run. */
async function capture(
  gateway: XrplGateway,
  label: string,
  request: Record<string, unknown>,
): Promise<RawCapture> {
  try {
    const response = await gateway.request(request);
    return { label, request, ok: true, response, unsupported: false };
  } catch (err) {
    const code = (err as { data?: { error?: string } } | undefined)?.data?.error;
    return {
      label,
      request,
      ok: false,
      unsupported: METHOD_MISSING.some((m) => isRippledError(err, m)),
      error: { code, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

function show(capture_: RawCapture): void {
  if (capture_.ok) {
    r.json(`${capture_.label}  (raw)`, capture_.response);
    return;
  }
  if (capture_.unsupported) {
    r.warn(`${capture_.label}: NOT AVAILABLE on this endpoint (${capture_.error?.code ?? "unknownCmd"}).`);
    r.warn(`  This is a Clio method. Re-run against ${CLIO_TESTNET} to see it.`);
    return;
  }
  r.warn(`${capture_.label}: failed — ${capture_.error?.code ?? ""} ${capture_.error?.message ?? ""}`.trim());
}

interface NodeIdentity {
  /** rippled's own build. Clio reports it as `rippled_version`, not `build_version`. */
  buildVersion: string;
  clioVersion: string | undefined;
  clio: boolean;
  /** Human label, e.g. "clio 2.1.1 / rippled 2.2.0". */
  versions: string;
  detail: string;
}

async function probeNode(gateway: XrplGateway): Promise<NodeIdentity> {
  const info = await gateway.request({ command: "server_info" });
  const inner = (info?.result?.info ?? {}) as Record<string, unknown>;
  const buildVersion = String(inner.build_version ?? inner.rippled_version ?? "unknown");
  const clioVersion = typeof inner.clio_version === "string" ? inner.clio_version : undefined;
  const versions =
    clioVersion === undefined
      ? `rippled ${buildVersion}`
      : `clio ${clioVersion} / rippled ${buildVersion}`;

  const probe = await capture(gateway, "nft_info probe", {
    command: "nft_info",
    nft_id: PROBE_NFT_ID,
  });

  return {
    buildVersion,
    clioVersion,
    clio: !probe.unsupported,
    versions,
    detail: probe.unsupported ? "nft_info -> unknownCmd (plain rippled)" : "nft_info answered",
  };
}

/** Present-or-absent digest of the fields the verification story depends on. */
function fieldDigest(capture_: RawCapture): Record<string, unknown> | undefined {
  if (!capture_.ok) return undefined;
  const result = (capture_.response as { result?: Record<string, unknown> } | undefined)?.result;
  if (!result) return undefined;
  const wanted = ["nft_id", "owner", "issuer", "is_burned", "nft_taxon", "nft_serial", "uri", "flags"];
  const digest: Record<string, unknown> = {};
  for (const key of wanted) {
    digest[key] = key in result ? (result[key] ?? "(null)") : "— ABSENT —";
  }
  return digest;
}

function parseEventId(argv: string[]): number {
  const flag = argv.find((a) => a.startsWith("--event="));
  if (flag === undefined) return DEFAULT_EVENT_ID;
  const parsed = Number.parseInt(flag.slice("--event=".length), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--event must be a non-negative integer, got "${flag}"`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const eventId = parseEventId(process.argv.slice(2));
  const cfg = loadConfig({ requireIssuer: false });

  r.header(`brief section 8 step 2 · event/taxon ${eventId} · ${cfg.endpoint}`);

  if (
    !r.check(
      "XRPL_NETWORK is testnet",
      cfg.network === "testnet",
      cfg.network === "testnet" ? cfg.network : `got "${cfg.network}"`,
    )
  ) {
    r.blank();
    r.note("This script funds wallets from the testnet faucet and then destroys a badge.");
    r.note("It must never point at mainnet. Set XRPL_NETWORK=testnet and use");
    r.note(`  XRPL_ENDPOINT=${CLIO_TESTNET}`);
    r.note("REFUSING TO RUN.");
    return;
  }

  // -- 1: connect -----------------------------------------------------------
  r.step(1, "Connect and establish whether this node serves the Clio NFT methods");

  const boot = await XrplConnection.connect(cfg, { connectTimeoutMs: 20_000 });
  let issuerWallet: Wallet;
  let attendeeWallet: Wallet;
  let node: NodeIdentity;

  try {
    node = await probeNode(boot);
    r.info("endpoint", boot.endpoint);
    r.info("versions", node.versions);
    r.info("clio", node.clio ? `yes — ${node.detail}` : `no — ${node.detail}`);
    r.check("node reachable", true, `${boot.endpoint} · ${node.versions} · clio ${node.clio ? "yes" : "no"}`);

    if (node.clio) {
      r.ok("nft_info / nft_history / nfts_by_issuer are available — full burn evidence.");
    } else {
      r.warn("THIS NODE SERVES NO nft_info, nft_history OR nfts_by_issuer.");
      r.warn("The burn test can only show you the account_nfts half of the picture.");
      r.warn(`Re-run against the Clio endpoint to see the rest:  XRPL_ENDPOINT=${CLIO_TESTNET}`);
    }

    // -- 2: wallets ---------------------------------------------------------
    r.step(2, "Fund two wallets from the testnet faucet");
    const issuerFunding = await boot.client.fundWallet();
    issuerWallet = issuerFunding.wallet;
    registerSecret(issuerWallet.seed);
    r.wallet("issuer", issuerWallet.address, issuerWallet.seed);

    const attendeeFunding = await boot.client.fundWallet();
    attendeeWallet = attendeeFunding.wallet;
    registerSecret(attendeeWallet.seed);
    r.wallet("attendee", attendeeWallet.address, attendeeWallet.seed);
    r.check("two wallets funded", issuerWallet.address !== attendeeWallet.address);
  } finally {
    await boot.disconnect();
  }

  await withGateway(
    cfg,
    async (gw) => {
      let feesDrops = 0n;

      // -- 3: full claim cycle ---------------------------------------------
      r.step(3, "Run the full claim cycle: mint -> destination-locked offer -> accept");

      const badge = await mint(gw, { eventId, uri: TEST_URI });
      feesDrops += BigInt(badge.fee);
      r.info("nftoken id", badge.nftokenId);
      r.info("mint tx", badge.txHash);

      const offer = await createClaimOffer(gw, {
        nftokenId: badge.nftokenId,
        destination: attendeeWallet.address,
      });
      feesDrops += BigInt(offer.fee);
      r.info("offer id", offer.offerId);

      const accepted = await acceptOfferAs(gw, {
        offerId: offer.offerId,
        wallet: attendeeWallet,
      });
      r.info("accept tx", accepted.txHash);
      r.links("accept on explorer", explorerTxUrls(cfg.network, accepted.txHash));
      r.check("claim cycle completed", accepted.txHash.length === 64, accepted.txHash);
      r.note("The accept hash is the attendance record. Everything below tests whether it survives.");

      // -- 4: baseline ------------------------------------------------------
      r.step(4, "BEFORE THE BURN — raw responses");

      const before = {
        nftInfo: await capture(gw, "nft_info", { command: "nft_info", nft_id: badge.nftokenId }),
        nftHistory: await capture(gw, "nft_history", {
          command: "nft_history",
          nft_id: badge.nftokenId,
        }),
        accountNfts: await capture(gw, "account_nfts (attendee)", {
          command: "account_nfts",
          account: attendeeWallet.address,
        }),
        nftsByIssuer: await capture(gw, "nfts_by_issuer", {
          command: "nfts_by_issuer",
          issuer: gw.issuerAddress,
          nft_taxon: eventId,
        }),
      };

      for (const c of Object.values(before)) show(c);

      const verifyBefore = await verifyClaim(gw, {
        address: attendeeWallet.address,
        eventId,
        txHash: accepted.txHash,
        issuerAddress: gw.issuerAddress,
      });
      r.json("verifyClaim BEFORE the burn", verifyBefore);
      r.check(
        "baseline: verifyClaim -> attended",
        verifyBefore.attended === true,
        `status=${verifyBefore.status}`,
      );

      // -- 5: burn ----------------------------------------------------------
      r.step(5, "Burn the badge FROM THE ATTENDEE WALLET");
      r.note("A holder can always burn their own NFT, whatever tfBurnable says.");

      const burned = await burn(gw, { nftokenId: badge.nftokenId, wallet: attendeeWallet });
      feesDrops += BigInt(burned.fee);
      r.info("burn tx", burned.txHash);
      r.info("ledger index", burned.ledgerIndex);
      r.links("burn on explorer", explorerTxUrls(cfg.network, burned.txHash));
      r.check("burn transaction validated", burned.txHash.length === 64, burned.txHash);

      // -- 6: the raw truth -------------------------------------------------
      r.step(6, "AFTER THE BURN — raw responses, verbatim");
      r.note("Read these yourself. This is the only part of the system you should not take on trust.");

      const after = {
        nftInfo: await capture(gw, "nft_info", { command: "nft_info", nft_id: badge.nftokenId }),
        nftHistory: await capture(gw, "nft_history", {
          command: "nft_history",
          nft_id: badge.nftokenId,
        }),
        accountNfts: await capture(gw, "account_nfts (attendee)", {
          command: "account_nfts",
          account: attendeeWallet.address,
        }),
        nftsByIssuer: await capture(gw, "nfts_by_issuer", {
          command: "nfts_by_issuer",
          issuer: gw.issuerAddress,
          nft_taxon: eventId,
        }),
      };

      for (const c of Object.values(after)) show(c);

      // -- 7: what survived -------------------------------------------------
      r.step(7, "Which fields survived the burn");

      const digest = fieldDigest(after.nftInfo);
      if (digest !== undefined) {
        r.json("nft_info fields after the burn", digest);
        r.check(
          "nft_info still resolves a burned token",
          after.nftInfo.ok,
          "this is what lets verification report attended_badge_burned",
        );
        r.check("nft_info reports is_burned: true", digest.is_burned === true, String(digest.is_burned));
        r.check(
          "nft_info still reports the issuer",
          typeof digest.issuer === "string" && digest.issuer === gw.issuerAddress,
          String(digest.issuer),
        );
        r.check(
          "nft_info still reports the taxon",
          digest.nft_taxon === eventId,
          String(digest.nft_taxon),
        );
      } else if (after.nftInfo.unsupported) {
        r.skip("nft_info after burn", `Clio method unavailable on ${cfg.endpoint} — re-run against ${CLIO_TESTNET}`);
      } else {
        r.check("nft_info after burn", false, after.nftInfo.error?.message ?? "no result");
      }

      // account_nfts works on every rippled, so this half always runs.
      const attendeeNftsAfter: Array<{ NFTokenID?: string }> =
        (after.accountNfts.response as { result?: { account_nfts?: Array<{ NFTokenID?: string }> } })
          ?.result?.account_nfts ?? [];
      r.check(
        "account_nfts no longer lists the badge",
        after.accountNfts.ok &&
          attendeeNftsAfter.every(
            (n) => (n.NFTokenID ?? "").toUpperCase() !== badge.nftokenId.toUpperCase(),
          ),
        `attendee now holds ${attendeeNftsAfter.length} badge(s) — ownership is gone`,
      );
      r.note("Ownership is gone. Attendance is not ownership. That is the whole design.");

      // -- 8: THE assertion -------------------------------------------------
      r.step(8, "Re-run verifyClaim() against the same accept transaction hash");

      const verifyAfter = await verifyClaim(gw, {
        address: attendeeWallet.address,
        eventId,
        txHash: accepted.txHash,
        issuerAddress: gw.issuerAddress,
      });
      r.json("verifyClaim AFTER the burn", verifyAfter);

      r.verdict(
        "A BURNED BADGE IS STILL ATTENDANCE — verifyClaim().attended === true",
        verifyAfter.attended === true,
        `attended=${String(verifyAfter.attended)} status=${verifyAfter.status} ` +
          `isBurned=${String(verifyAfter.isBurned)}`,
      );

      if (node.clio) {
        r.verdict(
          'status === "attended_badge_burned"',
          verifyAfter.status === "attended_badge_burned",
          `got "${verifyAfter.status}"`,
        );
      } else {
        r.skip(
          'status === "attended_badge_burned"',
          `cannot be determined without nft_info — got "${verifyAfter.status}". Re-run against ${CLIO_TESTNET}.`,
        );
        r.note("attended:true was still proved above, from the transaction alone.");
      }

      r.check(
        "verification never consulted current ownership",
        verifyAfter.checks?.issuerAndTaxonMatch === true && verifyAfter.attended === true,
        "the attendee holds nothing and still verifies",
      );

      // -- 9: evidence on disk ----------------------------------------------
      r.step(9, "Write the raw responses to disk for diffing");

      const outDir = fileURLToPath(new URL("../out/", import.meta.url));
      const outFile = `${outDir}burn-test-${eventId}.json`;
      mkdirSync(outDir, { recursive: true });

      const document = {
        meta: {
          generatedAt: new Date().toISOString(),
          script: "scripts/02-burn-test.ts",
          endpoint: cfg.endpoint,
          connectedTo: gw.endpoint,
          network: cfg.network,
          buildVersion: node.buildVersion,
          clioVersion: node.clioVersion ?? null,
          clio: node.clio,
          eventId,
          uri: TEST_URI,
          issuerAddress: gw.issuerAddress,
          attendeeAddress: attendeeWallet.address,
          nftokenId: badge.nftokenId,
          mintTxHash: badge.txHash,
          offerId: offer.offerId,
          acceptTxHash: accepted.txHash,
          burnTxHash: burned.txHash,
          feesBurnedDrops: feesDrops.toString(),
        },
        beforeBurn: before,
        afterBurn: after,
        fieldDigestAfterBurn: digest ?? null,
        verifyClaim: { beforeBurn: verifyBefore, afterBurn: verifyAfter },
      };

      writeFileSync(outFile, `${JSON.stringify(redact(document), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });

      r.info("written", outFile);
      r.note("Re-running with the same --event overwrites this file. Copy it before you diff.");
      r.info("fees burned (drops)", feesDrops.toString());
      r.info("fees burned (XRP)", formatXrp(feesDrops));
    },
    {
      wallet: issuerWallet,
      issuerAddress: issuerWallet.address,
      connectTimeoutMs: 20_000,
    },
  );
}

run()
  .catch((err: unknown) => {
    r.caught(err, "run aborted");
  })
  .then(() => r.finish());
