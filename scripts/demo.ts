/**
 * DEMO — the whole flow in a browser, one command, zero setup.
 *
 *   npm run demo              127.0.0.1 only
 *   npm run demo -- --lan     also reachable from a phone on the same wifi
 *
 * Faucet-funds a throwaway issuer, stands the real API up in front of it with
 * the testnet-only `/demo/*` harness enabled, and prints four URLs. Every page
 * drives the REAL endpoints — POST /events/:eventId/claims, POST /.../confirm,
 * GET /verify, GET /roster, GET /events/:eventId/attendance — so what a viewer
 * watches is the code that ships, not a re-enactment of it.
 *
 * TWO ROLES, TWO SCREENS. `/demo/attendee` is what someone at an event holds:
 * their wallet address as a QR code. `/demo/volunteer` is the badge desk that
 * scans it, funds an empty wallet and issues the badge. `--lan` is what makes
 * that literal rather than mimed — the attendee page opens on an actual phone
 * and the laptop's camera reads an actual screen.
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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { Wallet } from "xrpl";
import { buildDeps } from "../src/api/deps.js";
import { buildServer } from "../src/api/server.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { XrplConnection } from "../src/xrpl/client.js";
import { getAccountBalanceXrp } from "../src/xrpl/sponsor.js";
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
// LAN
// ---------------------------------------------------------------------------

/**
 * `--lan` — bind 0.0.0.0 instead of the loopback address.
 *
 * Opt-in and nothing else changes: the default stays 127.0.0.1, because a demo
 * server that quietly listens on every interface the first time someone runs it
 * is a surprise, and surprises about what is listening are the expensive kind.
 */
const WANT_LAN = process.argv.slice(2).includes("--lan");

/**
 * Every address a phone on the same wifi could actually reach this on.
 *
 * IPv4 and non-internal only. There is usually one; there can be several (a
 * VPN, a Docker bridge, a second NIC) and guessing which one the phone is on is
 * not something this script can do, so it prints them and lets the human pick.
 */
function lanOrigins(port: number): string[] {
  const origins: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        origins.push(`http://${address.address}:${port}`);
      }
    }
  }
  return origins;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** Where a durable demo keeps its issuer between runs. Gitignored. */
const DEMO_STATE_DIR = "out";

/**
 * Read back the issuer seed from a previous run, if there is one.
 *
 * Mode 0600 and under out/, which is gitignored — this is faucet money on a
 * testnet throwaway, but it is still a signing key and gets treated like one.
 * Any problem reading it is answered with "no remembered issuer" rather than a
 * throw: the worst case is a fresh wallet, which is where we started.
 */
async function readRememberedIssuer(path: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const seed = (parsed as { seed?: unknown } | null)?.seed;
    return typeof seed === "string" && seed !== "" ? seed : undefined;
  } catch {
    return undefined;
  }
}

async function rememberIssuer(path: string, seed: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ seed }, null, 2)}\n`, { mode: 0o600 });
}

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
  // A throwaway faucet issuer is right for a stateless demo and WRONG the
  // moment storage is durable. Claims, attendance and events live in Postgres
  // and outlive the process; a fresh issuer every restart does not. A persisted
  // claim then points at a badge minted by yesterday's issuer, the idempotent
  // claim path hands that offer straight back, and verification correctly
  // refuses it — "issuer is rX..., expected rY...". Measured exactly that way.
  r.step(1, "The issuer");

  const issuerFile = join(DEMO_STATE_DIR, `issuer-${cfg.network}.json`);
  const remembered = cfg.databaseUrl ? await readRememberedIssuer(issuerFile) : undefined;

  let issuer: Wallet;
  let issuerBalance: string;

  if (remembered) {
    issuer = Wallet.fromSeed(remembered);
    registerSecret(issuer.seed);
    const conn = await XrplConnection.connect(cfg, { connectTimeoutMs: 20_000 });
    try {
      issuerBalance = await getAccountBalanceXrp(conn, issuer.classicAddress);
    } finally {
      await conn.disconnect();
    }
    r.ok("reusing the issuer from the last run — durable storage needs a durable issuer");
    r.info("remembered in", issuerFile);
  } else {
    r.note("The faucet is rate limited. If this hangs or 503s, wait a minute and re-run.");
    const boot = await XrplConnection.connect(cfg, { connectTimeoutMs: 20_000 });
    try {
      const funding = await boot.client.fundWallet();
      issuer = funding.wallet;
      issuerBalance = String(funding.balance);
      // Pin it before the first line that could possibly contain it.
      registerSecret(issuer.seed);
    } finally {
      await boot.disconnect();
    }
    if (cfg.databaseUrl && issuer.seed) {
      await rememberIssuer(issuerFile, issuer.seed);
      r.info("remembered in", issuerFile);
      r.note("Delete that file to start over with a fresh issuer and a clean slate.");
    }
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
    // Use Postgres when one is configured, memory otherwise.
    //
    // A demo must stay one command with no database — that is why the memory
    // fallback exists. But events and registrations are real records now: an
    // organiser who creates an event, collects sign-ups, then restarts and
    // finds an empty room has not been served by "nothing outlives the demo".
    // So honour DATABASE_URL when the operator has bothered to set one.
    ...(cfg.databaseUrl ? { databaseUrl: cfg.databaseUrl } : { databaseUrl: undefined }),
    defaultMetadataUri: cfg.defaultMetadataUri ?? DEFAULT_METADATA_URI,
    // The whole point of this launcher. AppConfig owns the switch, so setting
    // it here is enough — buildDeps re-asserts it is not paired with mainnet.
    demoEnabled: true,
    api: {
      ...cfg.api,
      // 0.0.0.0 ONLY on an explicit --lan. Without it this is loopback and a
      // phone cannot reach it, which is the safe default and the reason the
      // flag exists at all.
      host: WANT_LAN ? "0.0.0.0" : cfg.api.host,
    },
  };

  const { deps, close } = await buildDeps(config);
  const app = buildServer(deps);
  app.addHook("onClose", async () => {
    await close();
  });

  await app.listen({ port: config.api.port, host: config.api.host });

  const port = config.api.port;
  // 0.0.0.0 is what we BIND; it is not a URL anyone can open. The loopback
  // address is always the right thing to print for the machine running this.
  const origin = `http://${config.api.host === "0.0.0.0" ? "127.0.0.1" : config.api.host}:${port}`;
  const lan = WANT_LAN ? lanOrigins(port) : [];
  const phone = lan[0];

  // -- 3: the banner --------------------------------------------------------
  //
  // THE REAL APP FIRST. The `/demo/*` role-play below it is a harness that
  // generates wallets and signs as an attendee; the pages printed here are the
  // ones a guest and a volunteer actually use, and they are what a rehearsal
  // should be run against. When BADGE_BASE_URL names a public origin — a
  // tunnel, a staging host — that is the origin a phone can reach, so print it
  // rather than a loopback address nobody else can open.
  const publicOrigin = (config.badgeBaseUrl ?? "").replace(/\/+$/, "");
  const guestOrigin = publicOrigin || phone || origin;

  r.blank();
  r.rule();
  r.note("THE APP. A guest registers, shows their pass at the door, and a");
  r.note("volunteer on the desk issues the badge. Sign-in required at the desk.");
  r.blank();

  r.link("register", `${guestOrigin}/register`);
  r.note("the invitation: prove a wallet in Xaman, put a name to it");
  r.link("their pass", `${guestOrigin}/attend`);
  r.note("what a guest opens at the door — the code the desk scans");
  r.blank();

  r.link("THE DESK", `${guestOrigin}/volunteer`);
  r.note("scan, decide, issue. Behind the admin login");
  r.link("organiser", `${guestOrigin}/admin`);
  r.note("create events, watch registrations arrive");
  if (guestOrigin !== origin) r.info("on this machine", `${origin}/volunteer`);
  r.rule();

  r.note("TWO SCREENS, one event. Open the attendee page on a phone and the");
  r.note("volunteer page on the laptop, then walk up to yourself.");
  r.note("These are the ROLE-PLAY pages: they generate a wallet and sign for it.");
  r.blank();

  r.link("ATTENDEE", `${origin}/demo/attendee`);
  if (phone !== undefined) r.link("on a phone", `${phone}/demo/attendee`);
  r.note("their wallet as a QR code; then a pending badge, and a confirm button");
  r.blank();

  r.link("VOLUNTEER", `${origin}/demo/volunteer`);
  if (phone !== undefined) r.link("on the LAN", `${phone}/demo/volunteer`);
  r.note("the badge desk: scan, see whether the wallet can even receive an NFT,");
  r.note("fund it if it cannot, then issue the badge");
  r.rule();

  r.link("chooser", `${origin}/demo`);
  r.note("pick a role. Start here if you only have one screen");
  r.link("walkthrough", `${origin}/demo/walkthrough`);
  r.note("the original single-page explainer: the whole cycle, ending in a burn");
  r.rule();

  if (lan.length > 1) {
    r.info("other LAN addresses", lan.slice(1).join("  "));
  }
  r.info("network", config.network);
  r.info("endpoint", config.endpoint);
  r.info("bound to", `${config.api.host}:${port}`);
  r.info("issuer", issuer.classicAddress);
  r.link("issuer on explorer", explorerAccountUrl(config.network, issuer.classicAddress));
  r.info("sponsorship", `on · ${config.sponsor.amountXrp} XRP, cap ${config.sponsor.dailyCapXrp}/day`);
  r.info(
    "storage",
    config.databaseUrl
      ? "postgres — events, registrations and attendance persist across restarts"
      : "in memory — no DATABASE_URL set, nothing survives a restart",
  );
  r.blank();

  if (WANT_LAN) {
    r.warn("--lan: THIS SERVER IS ON YOUR LOCAL NETWORK. Bound to 0.0.0.0, so anything");
    r.warn("on the same wifi can reach it — conference wifi, cafe wifi, the person at");
    r.warn("the next table. It is unauthenticated, it generates wallets, it spends");
    r.warn("faucet XRP and it signs as an attendee.");
    r.warn("It is testnet with a throwaway issuer, so there is no real money to lose.");
    r.warn("Stop it when the demo is over rather than leaving it running.");
    if (lan.length === 0) {
      r.warn("No non-internal IPv4 address was found: nothing here to give a phone.");
    }
  } else {
    r.note("Loopback only (127.0.0.1). A phone cannot reach this — re-run with");
    r.note("`npm run demo -- --lan` to open the attendee page on a real device.");
  }
  r.blank();

  r.warn("The demo routes at /demo are LIVE: they generate wallets, take faucet funds");
  r.warn("and sign as an attendee. Testnet only. Never run this against mainnet.");
  r.warn(`This issuer is throwaway. Its key exists only in this process and is forgotten`);
  r.warn("on exit — do not send it anything you want to keep.");
  r.blank();
  r.note("The pages drive the real endpoints: POST /events/:eventId/claims, /confirm,");
  r.note("GET /verify, /roster, /events/:eventId/attendance. Nothing is simulated.");
  r.note("Signing as the attendee is the one shim: production signs in Xaman.");
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
