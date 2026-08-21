/**
 * Pre-pin per-attendee badge artwork for a roster, before the doors open.
 *
 * Every attendee gets their own deterministic image, and pinning one takes a
 * round trip to Pinata. Doing that inside a claim puts Pinata's latency and
 * rate limits between a person at a desk and their badge. So the expected
 * roster is pinned ahead of time into a manifest file, and the API only pins
 * at the desk for a walk-up who was never on the list.
 *
 *   npm run prepin -- --event=900001 --addresses=./roster.txt \
 *     --name="Feooh 2026" [--dry-run] [--concurrency=4]
 *
 * The roster is one classic address per line; blank lines and `#` comments are
 * ignored. Re-running is cheap and expected: addresses already in the manifest
 * are skipped, so adding ten names to the file pins ten badges, not the roster
 * again. A failure on one address never abandons the rest — it is recorded,
 * reported at the end, and the run exits non-zero so a CI job or a human
 * notices.
 *
 * --dry-run pins to an in-memory pinner and writes no manifest, so you can see
 * exactly what the real run would do without a JWT and without putting
 * anything on a public network. Its CIDs are fake and it is refused on mainnet.
 */
import { readFile } from "node:fs/promises";
import { isValidClassicAddress } from "xrpl";
import { loadConfig } from "../src/config.js";
import { XrplLayerError } from "../src/errors.js";
import { MAX_TAXON, type IpfsPinner } from "../src/types.js";
import { MemoryPinner } from "../src/metadata/memory-pinner.js";
import { PinataPinner } from "../src/metadata/pinata.js";
import {
  PinningBadgeUriResolver,
  badgeManifestPath,
  loadBadgeManifest,
} from "../src/metadata/badge-uri-resolver.js";
import { createReport, registerSecret } from "./lib/report.js";

const r = createReport("prepin-badges — pin per-attendee artwork for a roster");

/** Pinata rate-limits. A 500-person roster fired at once gets 429s, not badges. */
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
}

function has(argv: string[], name: string): boolean {
  return flag(argv, name) !== undefined;
}

interface Args {
  eventId: number;
  addressesPath: string;
  name?: string;
  eventDate?: string;
  venue?: string;
  collection?: string;
  manifestPath?: string;
  concurrency: number;
  dryRun: boolean;
}

const USAGE =
  "usage: --event=<taxon> --addresses=<file> [--name=] [--date=] [--venue=] " +
  "[--collection=] [--manifest=<path>] [--concurrency=4] [--dry-run]";

function parseArgs(argv: string[]): Args {
  const eventRaw = flag(argv, "event");
  const addressesPath = flag(argv, "addresses");
  if (!eventRaw || !addressesPath) {
    throw new XrplLayerError("INVALID_INPUT", USAGE);
  }

  const eventId = Number.parseInt(eventRaw, 10);
  if (!Number.isInteger(eventId) || eventId < 0 || eventId > MAX_TAXON) {
    throw new XrplLayerError(
      "INVALID_TAXON",
      `--event must be an integer in [0, ${MAX_TAXON}] (it is the NFTokenTaxon), got "${eventRaw}"`,
    );
  }

  const concurrencyRaw = flag(argv, "concurrency");
  const concurrency = concurrencyRaw ? Number.parseInt(concurrencyRaw, 10) : DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new XrplLayerError(
      "INVALID_INPUT",
      `--concurrency must be an integer in [1, ${MAX_CONCURRENCY}], got "${concurrencyRaw}"`,
    );
  }

  return {
    eventId,
    addressesPath,
    ...(flag(argv, "name") ? { name: flag(argv, "name") as string } : {}),
    ...(flag(argv, "date") ? { eventDate: flag(argv, "date") as string } : {}),
    ...(flag(argv, "venue") ? { venue: flag(argv, "venue") as string } : {}),
    ...(flag(argv, "collection") ? { collection: flag(argv, "collection") as string } : {}),
    ...(flag(argv, "manifest") ? { manifestPath: flag(argv, "manifest") as string } : {}),
    concurrency,
    dryRun: has(argv, "dry-run"),
  };
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

interface RosterProblem {
  line: number;
  raw: string;
  reason: string;
}

interface Roster {
  addresses: string[];
  invalid: RosterProblem[];
  duplicates: RosterProblem[];
}

/**
 * One address per line. Every bad line is reported with its line number rather
 * than aborting on the first: an operator fixing a 500-line roster one typo
 * per run is an operator who misses the doors opening.
 */
export function parseRoster(text: string): Roster {
  const addresses: string[] = [];
  const invalid: RosterProblem[] = [];
  const duplicates: RosterProblem[] = [];
  const seen = new Set<string>();

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    // `#` cannot appear in base58, so an inline comment is unambiguous.
    const value = (rawLine.split("#")[0] ?? "").trim();
    if (value === "") return;

    if (!isValidClassicAddress(value)) {
      invalid.push({ line, raw: value, reason: "not a valid XRPL classic address" });
      return;
    }
    if (seen.has(value)) {
      duplicates.push({ line, raw: value, reason: "already listed above" });
      return;
    }
    seen.add(value);
    addresses.push(value);
  });

  return { addresses, invalid, duplicates };
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/** Bounded fan-out. Workers pull from a shared cursor until the roster is done. */
async function pool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await worker(item, index);
    }
  });
  await Promise.all(runners);
}

/** Wraps a pinner to total the bytes actually uploaded. */
function countingPinner(inner: IpfsPinner, onBytes: (n: number) => void): IpfsPinner {
  return {
    async pinFile(input) {
      const result = await inner.pinFile(input);
      onBytes(input.data.byteLength);
      return result;
    },
    async pinJson(input) {
      const result = await inner.pinJson(input);
      onBytes(Buffer.byteLength(JSON.stringify(input.json) ?? "", "utf8"));
      return result;
    },
  };
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // requireIssuer:false — pinning never touches the ledger and never signs.
  const cfg = loadConfig({ requireIssuer: false });
  registerSecret(cfg.pinata.jwt);

  const manifestPath = args.manifestPath ?? badgeManifestPath(args.eventId);

  r.header(
    `${args.dryRun ? "DRY RUN — nothing leaves this machine" : "PRE-PINNING TO IPFS"} · event ${args.eventId}`,
  );

  // A dry run pins nothing, but it writes URIs to a terminal, and a fake URI
  // printed under a mainnet config is one copy-paste from a permanently
  // unresolvable badge. Same guard as scripts/publish-badge.ts.
  if (args.dryRun && cfg.network === "mainnet") {
    r.fail("--dry-run is refused while XRPL_NETWORK=mainnet.");
    r.note("A dry run produces FAKE CIDs. Printing them next to a mainnet");
    r.note("config invites minting badges that can never resolve.");
    r.note("");
    r.note("Preview against testnet:   cp .env.staging .env");
    r.note("Or pin for real:           set PINATA_JWT and drop --dry-run");
    await r.finish();
    return;
  }

  // -- 1 ---------------------------------------------------------------------
  r.step(1, "Read the roster");

  let text: string;
  try {
    text = await readFile(args.addressesPath, "utf8");
  } catch (err) {
    r.fail(`cannot read --addresses ${args.addressesPath}: ${(err as Error).message}`);
    r.note("One classic address per line. Blank lines and # comments are ignored.");
    await r.finish();
    return;
  }

  const roster = parseRoster(text);
  r.info("file", args.addressesPath);
  r.info("valid addresses", roster.addresses.length);

  for (const problem of roster.duplicates) {
    r.warn(`line ${problem.line}: ${problem.raw} — ${problem.reason}, skipping the repeat`);
  }
  for (const problem of roster.invalid) {
    // Loud, and counted — but the other 499 addresses still get badges.
    r.fail(`line ${problem.line}: "${problem.raw}" — ${problem.reason}`);
  }
  if (roster.invalid.length > 0) {
    r.note(`${roster.invalid.length} line(s) above were skipped. Fix them and re-run;`);
    r.note("addresses pinned in this run will be skipped the second time.");
  }

  if (roster.addresses.length === 0) {
    r.fail("No valid addresses in the roster. Nothing to pin.");
    await r.finish();
    return;
  }

  // -- 2 ---------------------------------------------------------------------
  r.step(2, "Choose the pinner");

  let basePinner: IpfsPinner;
  if (args.dryRun) {
    basePinner = new MemoryPinner({ network: cfg.network });
    r.warn("DRY RUN: using the in-memory pinner. No manifest will be written.");
    r.note("The CIDs below are NOT real content addresses. Nothing minted");
    r.note("against them will ever resolve. Re-run without --dry-run to pin.");
  } else {
    if (!cfg.pinata.jwt) {
      r.fail("PINATA_JWT is not set. Add it to .env, or pass --dry-run to preview.");
      await r.finish();
      return;
    }
    basePinner = new PinataPinner({ jwt: cfg.pinata.jwt, gateway: cfg.pinata.gateway });
    r.info("pinner", "Pinata");
    r.info("gateway", cfg.pinata.gateway);
    r.info("jwt", "[redacted]");
  }

  let bytes = 0;
  const pinner = countingPinner(basePinner, (n) => {
    bytes += n;
  });

  // -- 3 ---------------------------------------------------------------------
  r.step(3, "Check what the manifest already covers");

  const already = await loadBadgeManifest(manifestPath, {
    eventId: args.eventId,
    onWarn: (message) => r.warn(message),
  });
  r.info("manifest", manifestPath);
  r.info("already pinned", Object.keys(already.entries).length);
  const expected = roster.addresses.filter((a) => already.entries[a] === undefined).length;
  r.info("to pin now", expected);
  if (expected === 0) {
    r.note("Every roster address is already in the manifest. This run is a no-op.");
  }

  // -- 4 ---------------------------------------------------------------------
  r.step(4, `Pin ${expected} badge(s), ${args.concurrency} at a time`);

  const resolver = new PinningBadgeUriResolver({
    pinner,
    manifestPath,
    persist: !args.dryRun,
    onWarn: (message) => r.warn(message),
    ...(args.name === undefined ? {} : { eventName: args.name }),
    ...(args.eventDate === undefined ? {} : { eventDate: args.eventDate }),
    ...(args.venue === undefined ? {} : { venue: args.venue }),
    ...(args.collection === undefined ? {} : { collection: { name: args.collection } }),
  });

  const total = roster.addresses.length;
  const width = String(total).length;
  const failures: { address: string; message: string }[] = [];
  let pinned = 0;
  let skipped = 0;
  let done = 0;

  await pool(roster.addresses, args.concurrency, async (address) => {
    let status: string;
    try {
      const uri = await resolver.resolve({ eventId: args.eventId, address });
      if (uri.pinnedOnDemand) {
        pinned += 1;
        status = `pinned    ${uri.metadataUri}`;
      } else {
        skipped += 1;
        status = "skipped   already in the manifest";
      }
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      failures.push({ address, message });
      status = `FAILED    ${message}`;
    }
    done += 1;
    console.log(
      `  [ ${String(done).padStart(width)}/${total} ]  ${address.padEnd(35)}  ${status}`,
    );
  });

  // Every queued manifest write, before anything claims the file is current.
  await resolver.flush();

  // -- 5 ---------------------------------------------------------------------
  r.step(5, "Result");

  r.info("pinned", pinned);
  r.info("skipped", skipped);
  r.info("failed", failures.length);
  r.info("invalid lines", roster.invalid.length);
  r.info("duplicate lines", roster.duplicates.length);
  r.info("bytes uploaded", human(bytes));
  r.info("manifest", args.dryRun ? "not written (dry run)" : manifestPath);

  for (const failure of failures) {
    r.fail(`${failure.address} — ${failure.message}`);
  }

  r.check(
    "every valid roster address has a badge URI",
    failures.length === 0,
    failures.length === 0 ? `${pinned} pinned, ${skipped} already done` : `${failures.length} failed`,
  );
  r.check("every roster line parsed", roster.invalid.length === 0, `${roster.invalid.length} bad line(s)`);

  if (failures.length > 0) {
    r.note("Re-run the same command: addresses that succeeded are skipped, so a");
    r.note("retry only touches the ones that failed. Lower --concurrency if the");
    r.note("failures look like rate limiting (HTTP 429).");
  }

  // -- 6 ---------------------------------------------------------------------
  r.step(6, "Wire it up");

  if (args.dryRun) {
    r.note("Dry run: no manifest was written and nothing was uploaded.");
    r.note("Re-run without --dry-run, with PINATA_JWT set, to pin for real.");
  } else {
    r.note("THE MANIFEST IS WHAT THE API READS. This file:");
    r.note("");
    r.note(`  ${manifestPath}`);
    r.note("");
    r.note("Ship it to the machine serving claims, at the same path. Without it");
    r.note("the API still works — it just pins every badge at the desk, which is");
    r.note("a Pinata round trip per attendee while someone stands and waits.");
    r.note("");
    r.note("Re-running after adding names is cheap: listed addresses are skipped.");
  }

  await r.finish();
}

run().catch((err: unknown) => {
  r.caught(err, "pre-pin aborted");
  void r.finish();
});
