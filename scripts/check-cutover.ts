/**
 * CHECK CUTOVER — brief section 9, mechanised as far as a script can take it.
 *
 * Walks the mainnet cutover checklist line by line and prints pass, fail or
 * skip for each. Anything it cannot determine is a SKIP with a note saying what
 * a human has to do — never a false pass. Exits 1 if any hard check fails.
 *
 * RUN:
 *   npx tsx scripts/check-cutover.ts
 *   npx tsx scripts/check-cutover.ts --metadata-uri=ipfs://<CID>/metadata.json
 *   npx tsx scripts/check-cutover.ts \
 *       --metadata-uri=ipfs://<CID>/metadata.json \
 *       --verify-tx=<accept tx hash> --verify-address=r... --event=20250101
 *
 * FLAGS:
 *   --metadata-uri=...     resolve this URI over public IPFS gateways
 *   --verify-tx=<hash>     an NFTokenAcceptOffer hash from a real claim
 *   --verify-address=r...  the account that submitted it
 *   --event=<taxon>        the event id that claim belongs to
 *   --max-pending-offers=N pending-offer ceiling before this fails (default 25)
 *
 * It is safe to run against testnet as a dry run; the mainnet-only lines then
 * report as skipped rather than passing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet, xrpToDrops } from "xrpl";
import { XrplLayerError } from "../src/errors.js";
import {
  assertNetworkMatchesEndpoint,
  describeConfig,
  loadConfig,
  type AppConfig,
} from "../src/config.js";
import { XrplConnection, isRippledError } from "../src/xrpl/client.js";
import { countPendingIssuerOffers } from "../src/xrpl/offers.js";
import { getAccountBalanceXrp } from "../src/xrpl/sponsor.js";
import { verifyClaim } from "../src/xrpl/verify.js";
import type { XrplGateway } from "../src/types.js";
import {
  createReport,
  explorerAccountUrls,
  explorerTxUrls,
  formatXrp,
  registerSecret,
} from "./lib/report.js";

const MIN_FLOAT_XRP = "10";
const DEFAULT_MAX_PENDING_OFFERS = 25;
const PENDING_OFFERS_COMFORTABLE = 5;
const PROBE_NFT_ID = `00080000${"0".repeat(56)}`;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

/**
 * Assembled at runtime so this file does not itself contain the string it is
 * hunting for. A scanner that trips on its own source is a scanner nobody runs.
 */
const SEED_ASSIGNMENT = `ISSUER_SEED=${"s"}`;

/**
 * The same assignment followed by a real base58 payload. XRPL family seeds are
 * 29 to 31 characters, so anything shorter is documentation, not a key.
 */
const SEED_SHAPED_ASSIGNMENT = new RegExp(`${SEED_ASSIGNMENT}[1-9A-HJ-NP-Za-km-z]{23,49}`);

/**
 * Public gateways tried after the configured one. The point of the check is
 * that the metadata resolves somewhere other than your own node.
 */
const PUBLIC_IPFS_GATEWAYS = ["https://ipfs.io", "https://dweb.link", "https://w3s.link"];

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "coverage",
  "out",
  "secrets",
  ".turbo",
  ".next",
  ".cache",
]);

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const r = createReport("check-cutover · brief section 9");

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function flagValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  const value = hit === undefined ? undefined : hit.slice(prefix.length).trim();
  return value === "" ? undefined : value;
}

// ---------------------------------------------------------------------------
// Working-tree scan
// ---------------------------------------------------------------------------

interface FileSet {
  files: string[];
  mode: string;
}

/** Tracked files if git can tell us; otherwise a conservative walk. */
function candidateFiles(): FileSet {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = out.split("\0").filter((f) => f.length > 0);
    if (files.length > 0) return { files, mode: "git ls-files (tracked files)" };
  } catch {
    /* not a git repo, or no git on PATH */
  }

  const files: string[] = [];
  walk(REPO_ROOT, files);
  return {
    files,
    mode: "filesystem walk (not a git repo — .gitignored paths skipped by name)",
  };
}

function walk(dir: string, into: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), into);
      continue;
    }
    if (!entry.isFile()) continue;
    // .env is gitignored and is the sanctioned home for a local seed.
    if (/^\.env(\..*)?$/.test(entry.name) && entry.name !== ".env.example") continue;
    into.push(relative(REPO_ROOT, join(dir, entry.name)));
  }
}

/** Every file under `dir`, used to scan build output that git does not track. */
function walkAbsolute(dir: string): string[] {
  const found: string[] = [];
  walk(dir, found);
  return found;
}

interface Hit {
  file: string;
  line: number;
}

const contentCache = new Map<string, string | undefined>();

function readText(relativePath: string): string | undefined {
  if (contentCache.has(relativePath)) return contentCache.get(relativePath);
  let text: string | undefined;
  try {
    const full = join(REPO_ROOT, relativePath);
    if (statSync(full).size <= MAX_SCAN_BYTES) {
      const raw = readFileSync(full, "utf8");
      if (!raw.includes("\0")) text = raw;
    }
  } catch {
    text = undefined;
  }
  contentCache.set(relativePath, text);
  return text;
}

/** Finds a literal needle. Returns locations only — never the matched text. */
function findLiteral(files: string[], needle: string, exclude: string[] = []): Hit[] {
  return findWhere(files, (line) => line.includes(needle), exclude);
}

/** Finds a pattern. Returns locations only — never the matched text. */
function findPattern(files: string[], pattern: RegExp, exclude: string[] = []): Hit[] {
  return findWhere(files, (line) => pattern.test(line), exclude);
}

function findWhere(files: string[], match: (line: string) => boolean, exclude: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    if (exclude.includes(file)) continue;
    const text = readText(file);
    if (text === undefined) continue;
    text.split("\n").forEach((line, index) => {
      if (match(line)) hits.push({ file, line: index + 1 });
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

async function isClio(gateway: XrplGateway): Promise<{ clio: boolean; detail: string }> {
  try {
    await gateway.request({ command: "nft_info", nft_id: PROBE_NFT_ID });
    return { clio: true, detail: "nft_info answered" };
  } catch (err) {
    if (isRippledError(err, "unknownCmd") || isRippledError(err, "notImpl")) {
      return { clio: false, detail: "nft_info -> unknownCmd (plain rippled)" };
    }
    return { clio: true, detail: `nft_info answered (${(err as Error).message.slice(0, 50)})` };
  }
}

// ---------------------------------------------------------------------------
// IPFS
// ---------------------------------------------------------------------------

interface GatewayResult {
  url: string;
  /** Served a 200 AND the body parsed as JSON. */
  ok: boolean;
  /** Answered at all. A 200 of the wrong content type still counts. */
  reached: boolean;
  status?: number;
  json?: unknown;
  error?: string;
}

function gatewayUrls(uri: string, configured: string): string[] {
  if (uri.startsWith("http://") || uri.startsWith("https://")) return [uri];
  if (!uri.startsWith("ipfs://")) return [];
  const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  const bases = [configured.replace(/\/+$/, ""), ...PUBLIC_IPFS_GATEWAYS];
  return [...new Set(bases)].map((base) => `${base}/ipfs/${path}`);
}

async function fetchJson(url: string): Promise<GatewayResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { url, ok: false, reached: true, status: res.status, error: res.statusText };
    const text = await res.text();
    try {
      return { url, ok: true, reached: true, status: res.status, json: JSON.parse(text) };
    } catch {
      return {
        url,
        ok: false,
        reached: true,
        status: res.status,
        error: "served 200 but the body is not JSON — the URI must point at the metadata JSON, not the image",
      };
    }
  } catch (err) {
    return { url, ok: false, reached: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const argv = process.argv.slice(2);

  // Read the real environment BEFORE dotenv can merge .env into it, so we can
  // tell "in the server environment" from "in a local file".
  const seedInRealEnv = process.env.ISSUER_SEED;

  let cfg: AppConfig;
  try {
    cfg = loadConfig({ requireIssuer: false });
  } catch (err) {
    r.header("configuration");
    r.check("[3] endpoint guard assertion passes", false, err instanceof Error ? err.message : String(err));
    r.note("loadConfig() refused the endpoint/network pair. Nothing else can be checked.");
    return;
  }
  registerSecret(cfg.issuerSeed);

  const maxPending = Number.parseInt(
    flagValue(argv, "max-pending-offers") ?? String(DEFAULT_MAX_PENDING_OFFERS),
    10,
  );
  const metadataUri = flagValue(argv, "metadata-uri");
  const verifyTx = flagValue(argv, "verify-tx");
  const verifyAddress = flagValue(argv, "verify-address");
  const eventIdRaw = flagValue(argv, "event");

  r.header(`mainnet cutover checklist · ${cfg.endpoint}`);
  r.json("config (redacted)", describeConfig(cfg));

  const dryRun = cfg.network !== "mainnet";
  if (dryRun) {
    r.warn(`XRPL_NETWORK is "${cfg.network}", not mainnet. This is a DRY RUN of the cutover checklist.`);
    r.warn("Mainnet-only lines will report as skipped.");
  }

  // -- connectivity ---------------------------------------------------------
  r.step(0, "Connectivity");

  let gateway: XrplConnection | undefined;
  try {
    gateway = await XrplConnection.connect(cfg, { connectTimeoutMs: 20_000 });
    r.check("node reachable", true, gateway.endpoint);
  } catch (err) {
    // A ConfigError here is the seed/address assertion in XrplConnection, not
    // an unreachable node. Reporting it as "node reachable: FAIL" sends the
    // operator to debug their network instead of their environment.
    if (err instanceof XrplLayerError && err.code === "CONFIG_INVALID") {
      r.skip("node reachable", "not attempted — the issuer configuration is invalid, see [1] below");
      r.check("issuer configuration is coherent", false, err.message);
    } else {
      r.check("node reachable", false, err instanceof Error ? err.message : String(err));
    }
  }

  try {
    if (gateway !== undefined) {
      // Clio reports rippled's build as `rippled_version` and its own as
      // `clio_version`; only a plain rippled uses `build_version`.
      const info = await gateway.request({ command: "server_info" });
      const inner = (info?.result?.info ?? {}) as Record<string, unknown>;
      const buildVersion = String(inner.build_version ?? inner.rippled_version ?? "unknown");
      const clioVersion = typeof inner.clio_version === "string" ? inner.clio_version : undefined;
      r.info(
        "versions",
        clioVersion === undefined
          ? `rippled ${buildVersion}`
          : `clio ${clioVersion} / rippled ${buildVersion}`,
      );

      const clio = await isClio(gateway);
      r.check(
        "node is Clio-enabled (nft_info / nft_history / nfts_by_issuer)",
        clio.clio,
        `clio ${clio.clio ? "yes" : "no"} — ${clio.detail}`,
      );
      if (!clio.clio) {
        r.note("Roster and burn-aware verification need Clio. Use wss://xrplcluster.com on mainnet");
        r.note("or wss://clio.altnet.rippletest.net:51233 on testnet.");
      }
      if (cfg.fallbackEndpoints.length === 0) {
        r.warn("XRPL_FALLBACK_ENDPOINTS is empty. Public Clio servers carry no SLA (brief section 10).");
      }
    }

    // -- 1 ------------------------------------------------------------------
    r.step(1, "[1] Issuer account generated offline, seed stored only in server env");

    const seedPresent = cfg.issuerSeed !== "";
    r.check("ISSUER_SEED is present in the environment", seedPresent, seedPresent ? "[redacted]" : "unset");
    r.check("ISSUER_ADDRESS is present", cfg.issuerAddress !== "", cfg.issuerAddress || "unset");

    // A transposed seed/address pair starts cleanly and only fails on the
    // first live mint, as a bad signature, in front of a queue of attendees.
    // Catch it here instead. The seed never enters the output.
    if (seedPresent && cfg.issuerAddress !== "") {
      let derived: string | undefined;
      try {
        derived = Wallet.fromSeed(cfg.issuerSeed).classicAddress;
      } catch {
        r.check("ISSUER_SEED is a valid XRPL seed", false, "could not be parsed as a seed");
      }
      if (derived !== undefined) {
        r.check(
          "ISSUER_SEED derives ISSUER_ADDRESS",
          derived === cfg.issuerAddress,
          derived === cfg.issuerAddress
            ? cfg.issuerAddress
            : `seed derives ${derived}, but ISSUER_ADDRESS is ${cfg.issuerAddress} — every mint would be signed by the wrong account`,
        );
      }
    } else {
      r.skip("ISSUER_SEED derives ISSUER_ADDRESS", "needs both ISSUER_SEED and ISSUER_ADDRESS");
    }

    if (seedPresent) {
      if (seedInRealEnv !== undefined && seedInRealEnv.trim() !== "") {
        r.ok("the seed came from the process environment, not from a file");
      } else {
        r.warn("the seed came from .env, not from the process environment.");
        r.warn("Fine for local work. On the server it belongs in the environment itself.");
      }
    }

    // -- 2 ------------------------------------------------------------------
    r.step(2, `[2] Issuer funded with at least ${MIN_FLOAT_XRP} XRP`);

    if (gateway === undefined || cfg.issuerAddress === "") {
      r.skip(`[2] issuer funded with ${MIN_FLOAT_XRP}+ XRP`, "no connection or no ISSUER_ADDRESS");
    } else {
      try {
        const balanceXrp = await getAccountBalanceXrp(gateway, cfg.issuerAddress);
        const balanceDrops = BigInt(xrpToDrops(balanceXrp));
        const minDrops = BigInt(xrpToDrops(MIN_FLOAT_XRP));
        r.info("issuer balance", `${balanceXrp} XRP`);
        r.check(
          `[2] issuer funded with ${MIN_FLOAT_XRP}+ XRP`,
          balanceDrops >= minDrops,
          balanceDrops >= minDrops
            ? `${balanceXrp} XRP`
            : `have ${balanceXrp} XRP, SHORT ${formatXrp(minDrops - balanceDrops)} XRP`,
        );
      } catch (err) {
        r.check(
          `[2] issuer funded with ${MIN_FLOAT_XRP}+ XRP`,
          false,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // -- 3 ------------------------------------------------------------------
    r.step(3, "[3] XRPL_NETWORK=mainnet and the endpoint guard assertion passes");

    try {
      assertNetworkMatchesEndpoint(cfg.network, cfg.endpoint);
      for (const fallback of cfg.fallbackEndpoints) {
        assertNetworkMatchesEndpoint(cfg.network, fallback);
      }
      r.check("[3] endpoint guard assertion passes", true, `${cfg.network} <- ${cfg.endpoint}`);
    } catch (err) {
      r.check("[3] endpoint guard assertion passes", false, err instanceof Error ? err.message : String(err));
    }

    if (dryRun) r.skip("[3] XRPL_NETWORK is mainnet", `currently "${cfg.network}"`);
    else r.check("[3] XRPL_NETWORK is mainnet", true, cfg.network);

    // -- 4 and 9 ------------------------------------------------------------
    r.step(4, "[4] One complete claim rehearsed  ·  [9] a burned badge still verifies");

    const eventId = eventIdRaw === undefined ? undefined : Number.parseInt(eventIdRaw, 10);
    if (
      gateway === undefined ||
      verifyTx === undefined ||
      verifyAddress === undefined ||
      eventId === undefined ||
      !Number.isInteger(eventId)
    ) {
      r.skip(
        "[4] one complete claim rehearsed",
        "pass --verify-tx=<accept hash> --verify-address=r... --event=N, or run scripts/03-mainnet-rehearsal.ts",
      );
      r.skip(
        "[9] verifyClaim() says attended for a burned badge",
        "run scripts/02-burn-test.ts, or pass the accept hash of a claim whose badge you burned",
      );
    } else {
      try {
        const verified = await verifyClaim(gateway, {
          address: verifyAddress,
          eventId,
          txHash: verifyTx,
          issuerAddress: cfg.issuerAddress === "" ? undefined : cfg.issuerAddress,
        });
        r.json("verifyClaim result", verified);
        r.check("[4] one complete claim rehearsed", verified.attended === true, `status=${verified.status}`);
        r.links("the claim on an explorer", explorerTxUrls(cfg.network, verifyTx));

        if (verified.status === "attended_badge_burned") {
          r.check("[9] verifyClaim() says attended for a burned badge", true, verified.status);
        } else {
          r.skip(
            "[9] verifyClaim() says attended for a burned badge",
            `this badge is not burned (status=${verified.status}) — run scripts/02-burn-test.ts`,
          );
        }
      } catch (err) {
        r.check("[4] one complete claim rehearsed", false, err instanceof Error ? err.message : String(err));
        r.skip("[9] verifyClaim() says attended for a burned badge", "the rehearsal check did not complete");
      }
    }

    // -- 5 ------------------------------------------------------------------
    r.step(5, "[5] Badge visible on an explorer under the issuer address");

    if (cfg.issuerAddress === "") {
      r.skip("[5] badge visible on an explorer", "no ISSUER_ADDRESS to link to");
    } else {
      r.links("issuer", explorerAccountUrls(cfg.network, cfg.issuerAddress));
      r.skip("[5] badge visible on an explorer", "open the links above and confirm with your own eyes");
    }

    // -- 6 ------------------------------------------------------------------
    r.step(6, "[6] Metadata JSON resolves from a public IPFS gateway");

    // Before asking whether a CID resolves, ask whether we can make one at all.
    // A Pinata key with no scopes returns 200 from testAuthentication and 403
    // from every pin, so the failure surfaces as identical artwork on every
    // badge rather than as an error. Check the capability, not the credential.
    if (cfg.pinata.jwt === undefined || cfg.pinata.jwt === "") {
      r.skip("[6] Pinata key can pin", "PINATA_JWT is unset — badges use one shared image");
    } else {
      const { checkPinataUsable } = await import("../src/metadata/pinata.js");
      const usable = await checkPinataUsable({ jwt: cfg.pinata.jwt });
      r.check(
        "[6] Pinata key can pin",
        usable.usable,
        usable.usable ? `verified against the pinning endpoint` : `${usable.reason ?? usable.status ?? "failed"} — ${usable.message}`,
      );
      if (!usable.usable) {
        r.note("testAuthentication returns 200 for a key with no scopes, so it is not");
        r.note("evidence of anything. This probe hits the endpoint that matters.");
      }
    }

    if (metadataUri === undefined) {
      r.skip("[6] metadata resolves over a public gateway", "pass --metadata-uri=ipfs://<CID>/metadata.json");
    } else {
      const urls = gatewayUrls(metadataUri, cfg.pinata.gateway);
      if (urls.length === 0) {
        r.check("[6] metadata resolves over a public gateway", false, `cannot turn "${metadataUri}" into a gateway URL`);
      } else {
        r.info("metadata uri", metadataUri);
        const results: GatewayResult[] = [];
        for (const url of urls) {
          const result = await fetchJson(url);
          results.push(result);
          if (result.ok) r.ok(`${url} -> 200, valid JSON`);
          else r.warn(`${url} -> ${result.status ?? "no response"} ${result.error ?? ""}`.trim());
          if (result.ok && results.filter((x) => x.ok).length >= 2) break;
        }

        const resolved = results.filter((x) => x.ok);
        const reached = results.filter((x) => x.reached);
        r.check(
          "[6] metadata resolves over a public gateway",
          resolved.length > 0,
          `${resolved.length} of ${results.length} gateway(s) returned valid JSON` +
            (resolved.length === 0 && reached.length > 0
              ? ` (${reached.length} responded, none with JSON)`
              : ""),
        );
        const first = resolved[0];
        if (first !== undefined) {
          const meta = first.json as Record<string, unknown> | undefined;
          r.info("metadata name", String(meta?.name ?? "(none)"));
          r.info("metadata image", String(meta?.image ?? "(none)"));
          if (typeof meta?.image === "string" && !meta.image.startsWith("ipfs://")) {
            r.warn("image is not an ipfs:// URI — it will rot when that host goes away");
          }
        }
      }
    }

    // -- 7 ------------------------------------------------------------------
    r.step(7, "[7] Sponsorship endpoint rate limited and daily-capped");

    if (!cfg.sponsor.enabled) {
      r.check("[7] sponsorship is capped", true, "SPONSOR_ENABLED=false — nothing can be drained");
    } else {
      const cap = cfg.sponsor.dailyCapXrp;
      const capDrops = BigInt(xrpToDrops(cap));
      r.info("sponsor amount", `${cfg.sponsor.amountXrp} XRP per attendee`);
      r.info("daily cap", `${cap} XRP`);
      r.check("[7] a daily sponsorship cap is configured", capDrops > 0n, `${cap} XRP/day`);
      r.skip(
        "[7] sponsorship endpoint is rate limited",
        "config-level cap only — confirm the per-address and per-IP limits in the API layer",
      );
    }

    // -- 8 ------------------------------------------------------------------
    r.step(8, "[8] Offers created lazily, verified by the issuer's pending offer count");

    if (gateway === undefined || cfg.issuerAddress === "") {
      r.skip("[8] pending offer count is small", "no connection or no ISSUER_ADDRESS");
    } else {
      try {
        const pending = await countPendingIssuerOffers(gateway, cfg.issuerAddress);
        const lockedDrops = BigInt(xrpToDrops("0.2")) * BigInt(pending);
        r.info("pending offers", pending);
        r.info("reserve locked by them", `${formatXrp(lockedDrops)} XRP`);
        r.check(
          "[8] pending offer count is small",
          pending <= maxPending,
          `${pending} pending (ceiling ${maxPending})`,
        );
        if (pending > PENDING_OFFERS_COMFORTABLE && pending <= maxPending) {
          r.warn(`${pending} offers open at once. Pre-creating offers locks 0.2 XRP each — create them lazily.`);
        }
      } catch (err) {
        r.check("[8] pending offer count is small", false, err instanceof Error ? err.message : String(err));
      }
    }

    // -- 10 -----------------------------------------------------------------
    r.step(10, "[10] Issuer seed absent from the repo, the client bundle and the logs");

    const { files, mode } = candidateFiles();
    const distFiles = walkAbsolute(join(REPO_ROOT, "dist"));
    const scanned = [...files, ...distFiles];
    r.info("scan mode", mode);
    r.info("files scanned", `${scanned.length}${distFiles.length > 0 ? ` (incl. ${distFiles.length} in dist/)` : ""}`);

    // (a) the literal seed value, anywhere.
    if (cfg.issuerSeed === "") {
      r.skip("[10] the seed value is absent from the tree", "ISSUER_SEED is unset, nothing to search for");
    } else {
      const hits = findLiteral(scanned, cfg.issuerSeed);
      r.check(
        "[10] the seed value is absent from the tree",
        hits.length === 0,
        hits.length === 0
          ? `${scanned.length} files searched`
          : `FOUND IN ${hits.map((h) => `${h.file}:${h.line}`).join(", ")}`,
      );
      if (hits.length > 0) {
        r.blank();
        r.note("THE ISSUER SEED IS IN THE WORKING TREE. Treat it as compromised:");
        r.note("  1. generate a new issuer (npm run keygen), 2. move the funds, 3. purge the files above.");
      }
    }

    // (b) anything that assigns a seed-SHAPED value, outside the example file.
    //     Shape matters: the brief documents a placeholder of exactly this
    //     form in section 3, and a check that always fails is one nobody reads.
    const seedShapedHits = findPattern(scanned, SEED_SHAPED_ASSIGNMENT, [".env.example"]);
    r.check(
      `[10] no seed-shaped "${SEED_ASSIGNMENT}..." outside .env.example`,
      seedShapedHits.length === 0,
      seedShapedHits.length === 0
        ? "clean"
        : `FOUND IN ${seedShapedHits.map((h) => `${h.file}:${h.line}`).join(", ")}`,
    );
    if (seedShapedHits.length > 0) {
      r.blank();
      r.note("A SEED-SHAPED VALUE IS ASSIGNED IN THE TREE. Assume it is live and rotate it.");
    }

    // Placeholders and documentation. Not a failure, but worth one human look.
    const placeholderHits = findLiteral(scanned, SEED_ASSIGNMENT, [".env.example"]).filter(
      (hit) => !seedShapedHits.some((s) => s.file === hit.file && s.line === hit.line),
    );
    if (placeholderHits.length > 0) {
      r.note(
        `"${SEED_ASSIGNMENT}..." also appears, not seed-shaped (so: docs or a placeholder), in ` +
          `${placeholderHits.map((h) => `${h.file}:${h.line}`).join(", ")}`,
      );
    }

    // (c) leftovers from keygen. Gitignored, so not a repo risk — but it is a
    //     copy of the key sitting on a disk, which the checklist says to remove.
    for (const leftover of ["secrets/issuer.env", ".env"]) {
      try {
        const text = readFileSync(join(REPO_ROOT, leftover), "utf8");
        if (cfg.issuerSeed !== "" && text.includes(cfg.issuerSeed)) {
          if (leftover === ".env") {
            r.warn(".env holds the issuer seed. Gitignored, so not in the repo — but never deploy this file.");
          } else {
            r.warn(`${leftover} still holds the issuer seed. Move it into the server env and delete the file:`);
            r.warn(`  shred -u ${join(REPO_ROOT, leftover)}`);
          }
        }
      } catch {
        /* absent, which is the good case */
      }
    }

    r.note("Logs cannot be checked from here: grep your log sink for the seed once, by hand.");
  } finally {
    if (gateway !== undefined) await gateway.disconnect();
  }
}

run()
  .catch((err: unknown) => {
    r.caught(err, "checklist aborted");
  })
  .then(() => r.finish());
