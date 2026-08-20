/**
 * 01 — TESTNET END TO END. Brief section 8, step 1. "Get this green before
 * anything else."
 *
 * Walks the entire happy path against a live testnet node, with two wallets the
 * faucet gives us for free:
 *
 *   fund issuer + attendee -> mint a soulbound badge -> prove it is soulbound
 *   -> destination-locked offer -> attendee accepts -> account_nfts confirms
 *   -> verifyClaim(accept tx) says attended -> pending offers back to zero.
 *
 * Nothing here needs an issuer seed in the environment: both wallets come from
 * the faucet and the issuer wallet is handed to the connection as the default
 * signer. An .env containing nothing but XRPL_ENDPOINT is enough.
 *
 * RUN:
 *   npm run e2e:testnet
 *   npx tsx scripts/01-testnet-e2e.ts
 *   npx tsx scripts/01-testnet-e2e.ts --event=20250101
 *
 * The NFT query commands (nft_info, nft_history, nfts_by_issuer) are Clio-only,
 * so prefer wss://clio.altnet.rippletest.net:51233. This script itself only
 * needs account_nfts, which every rippled serves, so it passes on either.
 */
import { NFTokenMintFlags, parseNFTokenID, type Wallet } from "xrpl";
import { loadConfig } from "../src/config.js";
import { XrplConnection, isRippledError, withGateway } from "../src/xrpl/client.js";
import { mint } from "../src/xrpl/mint.js";
import { acceptOfferAs, countPendingIssuerOffers, createClaimOffer } from "../src/xrpl/offers.js";
import { getAccountNfts, getRoster } from "../src/xrpl/roster.js";
import { accountExists, getAccountBalanceXrp } from "../src/xrpl/sponsor.js";
import { verifyClaim } from "../src/xrpl/verify.js";
import type { XrplGateway } from "../src/types.js";
import {
  createReport,
  explorerAccountUrl,
  explorerTxUrls,
  formatXrp,
  registerSecret,
} from "./lib/report.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fixed test taxon. All badges for one event share a taxon; this is "the test event". */
const DEFAULT_EVENT_ID = 20_250_101;

/** Short ipfs:// URI. Points at metadata JSON, not the image. Well under 256 bytes. */
const TEST_URI = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/metadata.json";

/** Well-formed NFTokenID that cannot exist. Used only to ask "do you serve nft_info?". */
const PROBE_NFT_ID = `00080000${"0".repeat(56)}`;

const r = createReport("01 · XRPL testnet end-to-end");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface NodeIdentity {
  /** rippled's own build. Clio reports it as `rippled_version`, not `build_version`. */
  buildVersion: string;
  clioVersion: string | undefined;
  clio: boolean;
  /** Human label, e.g. "clio 2.1.1 / rippled 2.2.0". */
  versions: string;
  detail: string;
}

/**
 * server_info tells us the versions; a live nft_info call tells us the truth
 * about capability. A plain rippled answers `unknownCmd` to every Clio method,
 * and only Clio reports a `clio_version`.
 */
async function probeNode(gateway: XrplGateway): Promise<NodeIdentity> {
  const info = await gateway.request({ command: "server_info" });
  const inner = (info?.result?.info ?? {}) as Record<string, unknown>;
  const buildVersion = String(inner.build_version ?? inner.rippled_version ?? "unknown");
  const clioVersion = typeof inner.clio_version === "string" ? inner.clio_version : undefined;
  const versions =
    clioVersion === undefined
      ? `rippled ${buildVersion}`
      : `clio ${clioVersion} / rippled ${buildVersion}`;

  try {
    await gateway.request({ command: "nft_info", nft_id: PROBE_NFT_ID });
    return { buildVersion, clioVersion, clio: true, versions, detail: "nft_info answered" };
  } catch (err) {
    if (isRippledError(err, "unknownCmd")) {
      return {
        buildVersion,
        clioVersion,
        clio: false,
        versions,
        detail: "nft_info -> unknownCmd (plain rippled, no Clio methods)",
      };
    }
    // objectNotFound / invalidParams both mean the command exists.
    return {
      buildVersion,
      clioVersion,
      clio: true,
      versions,
      detail: `nft_info answered (${(err as Error).message.slice(0, 60)})`,
    };
  }
}

interface AccountNftEntry {
  NFTokenID: string;
  Flags: number;
  Issuer: string;
  NFTokenTaxon: number;
  nft_serial: number;
  URI?: string;
  TransferFee?: number;
}

async function accountNfts(gateway: XrplGateway, address: string): Promise<AccountNftEntry[]> {
  const res = await gateway.request({ command: "account_nfts", account: address, limit: 400 });
  const entries: AccountNftEntry[] = res?.result?.account_nfts ?? [];
  return entries;
}

/** Fee actually burned by a validated transaction, in drops. */
async function txFeeDrops(gateway: XrplGateway, hash: string): Promise<bigint> {
  const res = await gateway.request({ command: "tx", transaction: hash });
  const raw = res?.result?.tx_json?.Fee ?? res?.result?.Fee ?? "0";
  return BigInt(String(raw));
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

  // requireIssuer:false — this script has no business reading ISSUER_SEED.
  const cfg = loadConfig({ requireIssuer: false });

  r.header(`brief section 8 step 1 · event/taxon ${eventId} · ${cfg.endpoint}`);

  // -- guard ----------------------------------------------------------------
  // loadConfig() already refuses a mainnet/altnet mismatch in either direction.
  // This is the other half: never let a faucet script run against real money.
  if (
    !r.check(
      "XRPL_NETWORK is testnet",
      cfg.network === "testnet",
      cfg.network === "testnet" ? cfg.network : `got "${cfg.network}"`,
    )
  ) {
    r.blank();
    r.note("This script funds wallets from the testnet faucet and mints throwaway badges.");
    r.note("It must never point at mainnet. Set:");
    r.note("  XRPL_NETWORK=testnet");
    r.note("  XRPL_ENDPOINT=wss://clio.altnet.rippletest.net:51233");
    r.note("REFUSING TO RUN.");
    return;
  }

  // -- 1: connect -----------------------------------------------------------
  r.step(1, "Connect to the testnet node");
  r.info("endpoint", cfg.endpoint);
  r.info("network", cfg.network);
  r.info("fallbacks", cfg.fallbackEndpoints.length > 0 ? cfg.fallbackEndpoints.join(", ") : "(none)");

  const boot = await XrplConnection.connect(cfg, { connectTimeoutMs: 20_000 });
  let issuerWallet: Wallet;
  let attendeeWallet: Wallet;
  let node: NodeIdentity;

  try {
    node = await probeNode(boot);
    r.info("connected to", boot.endpoint);
    r.info("versions", node.versions);
    r.info("clio", node.clio ? `yes — ${node.detail}` : `no — ${node.detail}`);
    r.check("node reachable", true, `${boot.endpoint} · ${node.versions} · clio ${node.clio ? "yes" : "no"}`);
    if (!node.clio) {
      r.warn("This node serves no nft_info / nft_history / nfts_by_issuer.");
      r.warn("account_nfts works, so this script still passes — but 02-burn-test needs Clio.");
      r.warn("Clio testnet endpoint: wss://clio.altnet.rippletest.net:51233");
    }

    // -- 2: faucet ----------------------------------------------------------
    r.step(2, "Fund two wallets from the testnet faucet");
    r.note("The faucet is rate limited. If this hangs or 503s, wait a minute and re-run.");

    const issuerFunding = await boot.client.fundWallet();
    issuerWallet = issuerFunding.wallet;
    registerSecret(issuerWallet.seed);
    r.wallet("issuer", issuerWallet.address, issuerWallet.seed);
    r.info("issuer balance (XRP)", String(issuerFunding.balance));

    const attendeeFunding = await boot.client.fundWallet();
    attendeeWallet = attendeeFunding.wallet;
    registerSecret(attendeeWallet.seed);
    r.wallet("attendee", attendeeWallet.address, attendeeWallet.seed);
    r.info("attendee balance (XRP)", String(attendeeFunding.balance));

    r.check("two wallets funded", issuerWallet.address !== attendeeWallet.address);
    r.link("issuer on explorer", explorerAccountUrl(cfg.network, issuerWallet.address));
    r.link("attendee on explorer", explorerAccountUrl(cfg.network, attendeeWallet.address));
  } finally {
    await boot.disconnect();
  }

  // Reconnect with the faucet issuer as the default signer, so mint() and
  // createClaimOffer() sign as the issuer without a seed in the environment.
  await withGateway(
    cfg,
    async (gw) => {
      let feesDrops = 0n;

      // -- 3: mint ----------------------------------------------------------
      r.step(3, "Mint one soulbound badge");
      r.info("taxon (event id)", eventId);
      r.info("uri", TEST_URI);
      r.info("uri bytes", Buffer.byteLength(TEST_URI, "utf8"));

      const badge = await mint(gw, { eventId, uri: TEST_URI });
      feesDrops += BigInt(badge.fee);

      r.info("nftoken id", badge.nftokenId);
      r.info("mint tx", badge.txHash);
      r.info("ledger index", badge.ledgerIndex);
      r.links("mint on explorer", explorerTxUrls(cfg.network, badge.txHash));
      r.check("mint returned an nftoken_id", badge.nftokenId.length === 64, badge.nftokenId);
      r.check("mint taxon echoed back", badge.eventId === eventId);

      // -- 4: soulbound -----------------------------------------------------
      r.step(4, "Assert the badge is soulbound (flags are immutable after mint)");

      // The NFTokenID itself encodes the flags, the issuer, the taxon and the
      // serial. Decoding it locally is a check the node cannot get wrong.
      const decoded = parseNFTokenID(badge.nftokenId);
      r.info("flags in NFTokenID", decoded.Flags);
      r.info("issuer in NFTokenID", decoded.Issuer);
      r.info("taxon in NFTokenID", decoded.Taxon);

      r.check(
        "tfTransferable UNSET in NFTokenID",
        (decoded.Flags & NFTokenMintFlags.tfTransferable) === 0,
        `flags=${decoded.Flags}`,
      );
      r.check(
        "tfBurnable SET in NFTokenID",
        (decoded.Flags & NFTokenMintFlags.tfBurnable) !== 0,
        "issuer can revoke a badge issued in error",
      );
      r.check("TransferFee is zero", decoded.TransferFee === 0, `TransferFee=${decoded.TransferFee}`);
      r.check("issuer in NFTokenID matches", decoded.Issuer === gw.issuerAddress, decoded.Issuer);
      r.check("taxon in NFTokenID matches", decoded.Taxon === eventId, String(decoded.Taxon));

      // ...and the same again as the ledger reports it.
      const issuerHeld = await accountNfts(gw, gw.issuerAddress);
      const onLedger = issuerHeld.find((n) => n.NFTokenID === badge.nftokenId);
      if (r.check("badge is in the issuer's account_nfts", onLedger !== undefined)) {
        const flags = onLedger?.Flags ?? -1;
        r.info("flags on ledger", flags);
        r.check(
          "ledger agrees: non-transferable",
          (flags & NFTokenMintFlags.tfTransferable) === 0,
          `flags=${flags}`,
        );
        r.check("ledger agrees: taxon", onLedger?.NFTokenTaxon === eventId);
        r.check(
          "ledger agrees: no transfer fee",
          (onLedger?.TransferFee ?? 0) === 0,
          `TransferFee=${onLedger?.TransferFee ?? 0}`,
        );
      }

      // -- 5: offer ---------------------------------------------------------
      r.step(5, "Create a destination-locked claim offer");

      // An unfunded address cannot receive an NFT (brief 5.4). Faucet wallets
      // are funded, so this asserts rather than sponsors.
      const attendeeActive = await accountExists(gw, attendeeWallet.address);
      r.check("attendee account is activated", attendeeActive === true, attendeeWallet.address);

      const offer = await createClaimOffer(gw, {
        nftokenId: badge.nftokenId,
        destination: attendeeWallet.address,
      });
      feesDrops += BigInt(offer.fee);

      r.info("offer id", offer.offerId);
      r.info("destination", offer.destination);
      r.info("offer tx", offer.txHash);
      r.links("offer on explorer", explorerTxUrls(cfg.network, offer.txHash));
      r.check(
        "offer is locked to the attendee",
        offer.destination === attendeeWallet.address,
        "without Destination, anyone could take the badge",
      );

      const pendingBefore = await countPendingIssuerOffers(gw, gw.issuerAddress);
      r.info("pending issuer offers", pendingBefore);
      r.check("exactly one offer pending", pendingBefore === 1, `count=${pendingBefore}`);

      // -- 6: accept --------------------------------------------------------
      r.step(6, "Accept the offer as the attendee");
      r.note("On a real claim this is signed on the attendee's phone via Xaman. Here we hold the key.");

      const accepted = await acceptOfferAs(gw, {
        offerId: offer.offerId,
        wallet: attendeeWallet,
      });
      const acceptFee = await txFeeDrops(gw, accepted.txHash);
      feesDrops += acceptFee;

      r.info("accept tx", accepted.txHash);
      r.info("ledger index", accepted.ledgerIndex);
      r.links("accept on explorer", explorerTxUrls(cfg.network, accepted.txHash));
      r.check("accept transaction validated", accepted.txHash.length === 64, accepted.txHash);
      r.note("THIS HASH IS THE ATTENDANCE RECORD. Persist it, not the ownership state.");

      // -- 7: ownership -----------------------------------------------------
      r.step(7, "Confirm the attendee holds the badge (account_nfts)");

      const attendeeHeld = await accountNfts(gw, attendeeWallet.address);
      const held = attendeeHeld.find((n) => n.NFTokenID === badge.nftokenId);
      r.info("attendee nft count", attendeeHeld.length);
      r.check("attendee now holds the badge", held !== undefined, badge.nftokenId);
      r.check("badge issuer is our issuer", held?.Issuer === gw.issuerAddress);

      const issuerAfter = await accountNfts(gw, gw.issuerAddress);
      r.check(
        "issuer no longer holds the badge",
        issuerAfter.every((n) => n.NFTokenID !== badge.nftokenId),
        `issuer holds ${issuerAfter.length} badge(s)`,
      );

      // The same question asked through the library, so a live run exercises
      // roster.ts pagination and response unwrapping rather than only my
      // hand-rolled request above.
      const viaLibrary = await getAccountNfts(gw, attendeeWallet.address);
      r.check(
        "roster.getAccountNfts() agrees with the raw query",
        viaLibrary.some((n) => n.nftokenId.toUpperCase() === badge.nftokenId.toUpperCase()),
        `${viaLibrary.length} badge(s) reported`,
      );

      // nfts_by_issuer is Clio-only and is the single most useful query in the
      // system (brief 6.1) — but it is not required for this script to pass.
      if (node.clio) {
        const roster = await getRoster(gw, eventId);
        r.info("roster minted/claimed/burned", `${roster.minted}/${roster.claimed}/${roster.burned}`);
        r.check("roster shows one badge minted", roster.minted === 1, `minted=${roster.minted}`);
        r.check("roster shows one badge claimed", roster.claimed === 1, `claimed=${roster.claimed}`);
        r.check("roster shows nothing burned", roster.burned === 0, `burned=${roster.burned}`);
      } else {
        r.skip("roster (nfts_by_issuer)", "not a Clio node — re-run against wss://clio.altnet.rippletest.net:51233");
      }

      // -- 8: verify --------------------------------------------------------
      r.step(8, "verifyClaim() against the accept transaction hash");
      r.note("Attendance is an event, not a state — verification reads the tx, not the balance.");

      const verified = await verifyClaim(gw, {
        address: attendeeWallet.address,
        eventId,
        txHash: accepted.txHash,
        issuerAddress: gw.issuerAddress,
      });

      r.json("verifyClaim result", verified);
      r.check("verifyClaim -> attended", verified.attended === true, `status=${verified.status}`);
      r.check("verifyClaim -> status attended", verified.status === "attended", verified.status);
      r.check("check: transaction found", verified.checks?.transactionFound === true);
      r.check("check: is NFTokenAcceptOffer", verified.checks?.isAcceptOffer === true);
      r.check("check: submitted by the attendee", verified.checks?.submittedByAddress === true);
      r.check("check: succeeded", verified.checks?.succeeded === true);
      r.check("check: issuer and taxon match", verified.checks?.issuerAndTaxonMatch === true);

      // -- 9: reserves and fees ---------------------------------------------
      r.step(9, "Pending offers and total fees burned");

      const pendingAfter = await countPendingIssuerOffers(gw, gw.issuerAddress);
      r.info("pending issuer offers", pendingAfter);
      r.check(
        "no offers left pending",
        pendingAfter === 0,
        "an accepted offer releases its 0.2 XRP owner reserve",
      );

      const issuerBalance = await getAccountBalanceXrp(gw, gw.issuerAddress);
      const attendeeBalance = await getAccountBalanceXrp(gw, attendeeWallet.address);
      r.info("issuer balance (XRP)", issuerBalance);
      r.info("attendee balance (XRP)", attendeeBalance);
      r.info("fees burned (drops)", feesDrops.toString());
      r.info("fees burned (XRP)", formatXrp(feesDrops));
      r.note("Fees are burned, not paid to anyone. Reserves are locked, not spent.");

      r.blank();
      r.info("badge nftoken id", badge.nftokenId);
      r.info("attendance tx hash", accepted.txHash);
      r.links("confirm for yourself", explorerTxUrls(cfg.network, accepted.txHash));
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
