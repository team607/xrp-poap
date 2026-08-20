/**
 * DEMO — the whole flow in a browser, one command, zero setup.
 *
 *   npm run demo
 *
 * Faucet-funds a throwaway issuer, stands the real API up in front of it with
 * the testnet-only `/demo/*` harness enabled, and prints a URL. The page at
 * that URL drives the REAL endpoints — POST /events/:eventId/claims, POST
 * /.../confirm, GET /verify, GET /roster, GET /events/:eventId/attendance — so
 * what a viewer watches is the code that ships, not a re-enactment of it.
 *
 * Nothing is required in the environment. `XRPL_ENDPOINT` is honoured if a .env
 * or the shell sets one; otherwise the Clio testnet server is used, because the
 * roster and verification queries are Clio methods and answer `unknownCmd` on a
 * plain rippled node.
 *
 * WHAT THIS SPENDS: nothing real. The issuer is a fresh faucet wallet, it exists
 * for the life of the process, and its seed is never written anywhere — not to
 * .env, not to a log, not to stdout. Stop the process and the issuer is gone.
 *
 * REFUSES TO RUN ON MAINNET, three times over: here, in buildDeps(), and once
 * per request inside the routes themselves.
 */
import { config as loadDotenv } from "dotenv";
import type { Wallet } from "xrpl";
import { buildDeps } from "../src/api/deps.js";
import { buildServer } from "../src/api/server.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { XrplConnection } from "../src/xrpl/client.js";
import { createReport, exitWith, explorerAccountUrl, registerSecret } from "./lib/report.js";

// ---------------------------------------------------------------------------
// Defaults — so a clean checkout with no .env at all still works
// ---------------------------------------------------------------------------

/** Clio testnet. nft_info / nfts_by_issuer are Clio methods; the demo uses both. */
const DEFAULT_ENDPOINT = "wss://clio.altnet.rippletest.net:51233";

/**
 * Badge metadata for the demo mint. Without a URI every claim 400s, and routes
 * deliberately do not pin metadata themselves, so the demo brings its own.
 */
const DEFAULT_METADATA_URI =
  "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/metadata.json";

const r = createReport("XRPL badge demo · testnet");

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  // Load .env FIRST, so a configured endpoint still wins over the default
  // below. loadConfig() calls this again; it is idempotent and never overrides
  // a variable that is already set.
  loadDotenv({ quiet: true });
  if (!process.env.XRPL_ENDPOINT?.trim()) process.env.XRPL_ENDPOINT = DEFAULT_ENDPOINT;

  // requireIssuer:false — the whole point is that there is no issuer to
  // configure. One is created from the faucet below.
  const cfg = loadConfig({ requireIssuer: false });

  r.header(`a click-through of the README flow · ${cfg.endpoint}`);

  // -- guard ----------------------------------------------------------------
  // loadConfig() already refuses a mainnet/altnet mismatch in either direction.
  // This is the other half, and it is the reason this script exists at all: it
  // takes faucet money and signs on an attendee's behalf.
  if (cfg.network !== "testnet" && cfg.network !== "devnet") {
    r.fail(`XRPL_NETWORK is "${cfg.network}"`);
    r.blank();
    r.note("This launcher faucet-funds a throwaway issuer, generates attendee wallets and");
    r.note("signs transactions on their behalf. It must never point at mainnet. Set:");
    r.note("  XRPL_NETWORK=testnet");
    r.note(`  XRPL_ENDPOINT=${DEFAULT_ENDPOINT}`);
    r.note("REFUSING TO RUN.");
    r.blank();
    return exitWith(1);
  }

  // -- 1: a throwaway issuer ------------------------------------------------
  r.step(1, "Faucet-fund a throwaway issuer");
  r.note("The faucet is rate limited. If this hangs or 503s, wait a minute and re-run.");

  const boot = await XrplConnection.connect(cfg, { connectTimeoutMs: 20_000 });
  let issuer: Wallet;
  let issuerBalance: string;
  try {
    const funding = await boot.client.fundWallet();
    issuer = funding.wallet;
    issuerBalance = String(funding.balance);
    // Pin it before the first line that could possibly contain it. Everything
    // the reporter prints from here on is scrubbed of this value.
    registerSecret(issuer.seed);
  } finally {
    await boot.disconnect();
  }

  if (!issuer.seed) {
    throw new Error("the faucet returned a wallet with no seed; cannot sign as this issuer");
  }

  r.info("issuer address", issuer.classicAddress);
  r.info("issuer balance (XRP)", issuerBalance);
  r.link("issuer on explorer", explorerAccountUrl(cfg.network, issuer.classicAddress));

  // -- 2: the API, wired to that issuer -------------------------------------
  r.step(2, "Start the API with the demo harness enabled");

  const config: AppConfig = {
    ...cfg,
    // Both, from the same wallet: XrplConnection asserts that ISSUER_SEED
    // derives ISSUER_ADDRESS and refuses to start otherwise. In memory only —
    // nothing here is written to .env or anywhere else on disk.
    issuerAddress: issuer.classicAddress,
    issuerSeed: issuer.seed,
    // Faucet money on a throwaway account, so sponsorship is free — and it is
    // what makes the "unfunded attendee" branch of the demo real rather than
    // staged. POST /claims 409s that attendee without it.
    sponsor: { ...cfg.sponsor, enabled: true },
    // In memory. Nothing about a demo should outlive the process, and a demo
    // that needs a Postgres is not a one-command demo.
    databaseUrl: undefined,
    defaultMetadataUri: cfg.defaultMetadataUri ?? DEFAULT_METADATA_URI,
    // The whole point of this launcher. AppConfig owns the switch, so setting
    // it here is enough — buildDeps re-asserts it is not paired with mainnet.
    demoEnabled: true,
  };

  const { deps, close } = await buildDeps(config);
  const app = buildServer(deps);
  app.addHook("onClose", async () => {
    await close();
  });

  await app.listen({ port: config.api.port, host: config.api.host });

  const origin = `http://${config.api.host}:${config.api.port}`;

  // -- 3: the banner --------------------------------------------------------
  r.blank();
  r.rule();
  r.link("OPEN THIS", `${origin}/demo`);
  r.rule();
  r.info("network", config.network);
  r.info("endpoint", config.endpoint);
  r.info("issuer", issuer.classicAddress);
  r.link("issuer on explorer", explorerAccountUrl(config.network, issuer.classicAddress));
  r.info("sponsorship", `on · ${config.sponsor.amountXrp} XRP, cap ${config.sponsor.dailyCapXrp}/day`);
  r.info("storage", "in memory (no DATABASE_URL needed; nothing survives a restart)");
  r.blank();
  r.warn("The demo routes at /demo are LIVE: they generate wallets, take faucet funds");
  r.warn("and sign as an attendee. Testnet only. Never run this against mainnet.");
  r.warn(`This issuer is throwaway. Its key exists only in this process and is forgotten`);
  r.warn("on exit — do not send it anything you want to keep.");
  r.blank();
  r.note("The page drives the real endpoints: POST /events/:eventId/claims, /confirm,");
  r.note("GET /verify, /roster, /events/:eventId/attendance. Nothing is simulated.");
  r.note("Ctrl-C to stop.");
  r.blank();

  // -- 4: shutdown ----------------------------------------------------------
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    r.blank();
    r.note(`${signal} — closing the server and disconnecting from ${config.endpoint}`);
    void app.close().then(
      () => {
        r.note("stopped. The throwaway issuer is forgotten; there is nothing to clean up.");
        return exitWith(0);
      },
      (err: unknown) => {
        r.caught(err, "shutdown");
        return exitWith(1);
      },
    );
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => shutdown(signal));
  }
}

run().catch((err: unknown) => {
  r.caught(err, "the demo could not start");
  r.blank();
  void exitWith(1);
});
