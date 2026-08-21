/**
 * Pin a badge image and its XLS-24d metadata to IPFS, and print the URI that
 * goes in NFTokenMint's URI field.
 *
 * Brief section 8 step 4. Run this ONCE per event: one pin serves every badge
 * for that taxon, because every badge for an event carries the same URI.
 *
 *   npm run publish:badge -- --image=./badge.png --event=900001 \
 *     --name="Feooh 2026" --description="Attended Feooh 2026" [--dry-run]
 *
 * --dry-run pins to an in-memory pinner instead of Pinata, so you can inspect
 * the exact metadata document and the resulting byte count without a JWT and
 * without putting anything on a public network. The CIDs it prints are fake
 * and are refused on mainnet.
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { loadConfig } from "../src/config.js";
import { XrplLayerError } from "../src/errors.js";
import { MAX_URI_BYTES } from "../src/types.js";
import { MemoryPinner } from "../src/metadata/memory-pinner.js";
import { PinataPinner, checkGatewayResolves } from "../src/metadata/pinata.js";
import { publishBadge } from "../src/metadata/publish.js";
import { createReport, registerSecret } from "./lib/report.js";

const r = createReport("publish-badge — pin the artwork and the metadata JSON");

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

/** Wallets render a square badge; anything else gets letterboxed or cropped. */
const RECOMMENDED_MAX_BYTES = 1_000_000;

function flag(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
}

function has(argv: string[], name: string): boolean {
  return flag(argv, name) !== undefined;
}

interface Args {
  image: string;
  eventId: number;
  name: string;
  description: string;
  eventDate?: string;
  venue?: string;
  collection?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const image = flag(argv, "image");
  const eventRaw = flag(argv, "event");
  if (!image || !eventRaw) {
    throw new XrplLayerError(
      "INVALID_INPUT",
      "usage: --image=<path> --event=<taxon> [--name=] [--description=] " +
        "[--date=] [--venue=] [--collection=] [--dry-run]",
    );
  }
  const eventId = Number.parseInt(eventRaw, 10);
  if (!Number.isInteger(eventId)) {
    throw new XrplLayerError("INVALID_INPUT", `--event must be an integer, got "${eventRaw}"`);
  }
  return {
    image,
    eventId,
    name: flag(argv, "name") || `Attendance badge · event ${eventId}`,
    description:
      flag(argv, "description") ||
      `Proof of attendance for event ${eventId}, issued on the XRP Ledger.`,
    ...(flag(argv, "date") ? { eventDate: flag(argv, "date") as string } : {}),
    ...(flag(argv, "venue") ? { venue: flag(argv, "venue") as string } : {}),
    ...(flag(argv, "collection") ? { collection: flag(argv, "collection") as string } : {}),
    dryRun: has(argv, "dry-run"),
  };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // requireIssuer:false — pinning never touches the ledger and never signs.
  const cfg = loadConfig({ requireIssuer: false });
  registerSecret(cfg.pinata.jwt);

  r.header(
    `${args.dryRun ? "DRY RUN — nothing leaves this machine" : "PINNING TO IPFS"} · event ${args.eventId}`,
  );

  // A dry run mints nothing, but it prints a URI, and a URI printed under a
  // mainnet config is one copy-paste away from EVENT_METADATA_URI. MemoryPinner
  // refuses mainnet for exactly this reason; catch it here so the refusal is a
  // sentence rather than a stack trace from three frames down.
  if (args.dryRun && cfg.network === "mainnet") {
    r.fail("--dry-run is refused while XRPL_NETWORK=mainnet.");
    r.note("A dry run produces FAKE CIDs. Printing them next to a mainnet");
    r.note("config invites pasting one into EVENT_METADATA_URI, which would");
    r.note("mint permanently unresolvable badges with real XRP.");
    r.note("");
    r.note("Preview against testnet:   cp .env.staging .env");
    r.note("Or pin for real:           set PINATA_JWT and drop --dry-run");
    r.finish();
    return;
  }

  // -- 1 -------------------------------------------------------------------
  r.step(1, "Read the artwork");

  let bytes: Buffer;
  try {
    bytes = await readFile(args.image);
  } catch (err) {
    r.fail(`cannot read --image ${args.image}: ${(err as Error).message}`);
    r.finish();
    return;
  }

  const ext = extname(args.image).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  r.info("file", args.image);
  r.info("size", `${bytes.length.toLocaleString()} bytes`);
  r.info("type", contentType ?? `unknown (${ext || "no extension"})`);

  if (!contentType) {
    r.warn(
      `Unrecognised extension "${ext}". Pinata will store it, but a wallet that ` +
        "cannot infer a type may refuse to render it. Prefer .png or .svg.",
    );
  }
  if (bytes.length > RECOMMENDED_MAX_BYTES) {
    r.warn(
      `${(bytes.length / 1_000_000).toFixed(1)} MB is large for a badge. Public IPFS ` +
        "gateways are slow, and a wallet that times out shows a blank tile. " +
        "500x500 PNG under ~200 KB renders everywhere.",
    );
  }

  // -- 2 -------------------------------------------------------------------
  r.step(2, "Choose the pinner");

  let pinner;
  if (args.dryRun) {
    pinner = new MemoryPinner({ network: cfg.network });
    r.warn("DRY RUN: using the in-memory pinner.");
    r.note("The CIDs below are NOT real content addresses. Nothing minted");
    r.note("against them will ever resolve. Re-run without --dry-run to pin.");
  } else {
    if (!cfg.pinata.jwt) {
      r.fail("PINATA_JWT is not set. Add it to .env, or pass --dry-run to preview.");
      r.finish();
      return;
    }
    pinner = new PinataPinner({ jwt: cfg.pinata.jwt, gateway: cfg.pinata.gateway });
    r.info("pinner", "Pinata");
    r.info("gateway", cfg.pinata.gateway);
    r.info("jwt", "[redacted]");
  }

  // -- 3 -------------------------------------------------------------------
  r.step(3, "Pin the image, then the metadata that points at it");

  const published = await publishBadge(pinner, {
    image: {
      data: bytes,
      filename: basename(args.image),
      ...(contentType ? { contentType } : {}),
    },
    metadata: {
      name: args.name,
      description: args.description,
      eventId: args.eventId,
      ...(args.eventDate ? { eventDate: args.eventDate } : {}),
      ...(args.venue ? { venue: args.venue } : {}),
      ...(args.collection ? { collection: { name: args.collection } } : {}),
    },
  });

  r.ok("image pinned");
  r.info("image uri", published.imageUri);
  r.ok("metadata pinned");
  r.info("metadata uri", published.metadataUri);
  r.info("gateway url", published.pin.gatewayUrl);
  r.json("the document a wallet will read", published.metadata);

  // -- 4 -------------------------------------------------------------------
  r.step(4, "Does it fit in the mint field?");

  const uriBytes = Buffer.byteLength(published.metadataUri, "utf8");
  r.check(
    `metadata URI fits NFTokenMint's ${MAX_URI_BYTES}-byte cap`,
    uriBytes <= MAX_URI_BYTES,
    `${uriBytes} bytes`,
  );

  // -- 5 -------------------------------------------------------------------
  r.step(5, "Does a public gateway actually serve it?");

  if (args.dryRun) {
    r.skip("metadata resolves over a public gateway", "dry run — nothing was pinned");
  } else {
    // Cutover checklist line: "resolves from a public IPFS gateway, not just
    // your local node". A CID that only your pinner can serve is a badge that
    // renders for nobody.
    const res = await checkGatewayResolves(published.pin.gatewayUrl, { timeoutMs: 15_000 });
    r.check(
      "metadata resolves over a public gateway",
      res.ok,
      res.ok ? `HTTP ${res.status}` : (res.error ?? `HTTP ${res.status}`),
    );
    if (!res.ok) {
      r.note("Pinata can take a few seconds to propagate. Re-run this step before");
      r.note("you mint; a URI that does not resolve mints a blank badge.");
    }
  }

  // -- 6 -------------------------------------------------------------------
  r.step(6, "Wire it up");

  r.note("Put this in .env so every badge for this event points at it:");
  r.note("");
  r.note(`  EVENT_METADATA_URI=${published.metadataUri}`);
  r.note("");
  r.note("One pin serves every badge for this taxon. Re-run only when the");
  r.note("artwork changes — and note the URI is fixed at mint, so badges");
  r.note("already issued keep pointing at the old CID.");

  r.finish();
}

run()
  .catch((err: unknown) => {
    r.caught(err, "publish aborted");
    r.finish();
  });
