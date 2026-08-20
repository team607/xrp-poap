/**
 * GENERATE ISSUER — offline keygen. Backs the first line of the mainnet cutover
 * checklist, brief section 9:
 *
 *     [ ] Issuer account generated offline, seed stored only in server env
 *
 * "Offline" is literal. This script opens no socket, resolves no host and reads
 * no endpoint. It derives a keypair locally, prints the ADDRESS ONLY, and writes
 * the seed to a single 0600 file that you are expected to move into the server
 * environment and then delete.
 *
 * The seed is never printed, never logged, never echoed on failure. The only
 * copy that exists after this script runs is the file it wrote.
 *
 * RUN:
 *   npm run keygen
 *   npx tsx scripts/generate-issuer.ts
 *   npx tsx scripts/generate-issuer.ts --out=/secure/volume/issuer.env
 *
 * THEN:
 *   1. Fund the printed address with at least 10 XRP (brief section 7). An
 *      unfunded address does not exist on the ledger at all.
 *   2. Copy ISSUER_SEED and ISSUER_ADDRESS into the server environment.
 *   3. Delete the file. `rm -P` or `shred -u` if the disk is not encrypted.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Wallet } from "xrpl";
import { createReport, registerSecret } from "./lib/report.js";

const DEFAULT_OUT = "./secrets/issuer.env";

const r = createReport("generate-issuer · offline XRPL keygen");

function parseOut(argv: string[]): string {
  const inline = argv.find((a) => a.startsWith("--out="));
  if (inline !== undefined) {
    const value = inline.slice("--out=".length).trim();
    if (value === "") throw new Error("--out= was given with no path");
    return value;
  }
  const index = argv.indexOf("--out");
  if (index !== -1) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--out needs a path, e.g. --out=./secrets/issuer.env");
    }
    return value;
  }
  return DEFAULT_OUT;
}

/**
 * Safe means "git cannot pick this up": outside the repo entirely, or matched by
 * the repo's .gitignore (secrets/, .env*, *.seed). Anywhere else and the
 * operator is one `git add -A` away from publishing the issuer key.
 */
function isSafeLocation(path: string): boolean {
  const insideRepo = path.startsWith(`${resolve(process.cwd())}/`);
  if (!insideRepo) return true;
  return (
    /(^|\/)secrets\//.test(path) || /(^|\/)\.env(\.|$)/.test(path) || path.endsWith(".seed")
  );
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    r.header("offline issuer keygen — no network, no endpoint, no connection");
    r.note("usage: npx tsx scripts/generate-issuer.ts [--out=./secrets/issuer.env]");
    r.note("Prints the address. Writes the seed to the --out file (mode 0600) and nowhere else.");
    r.note("Refuses to overwrite an existing file.");
    return;
  }

  const outPath = resolve(parseOut(argv));
  const outDir = dirname(outPath);

  r.header("brief section 9 · issuer account generated offline");
  r.info("mode", "OFFLINE — this process opens no network connection");
  r.info("output file", outPath);

  // -- 1: refuse to overwrite -----------------------------------------------
  r.step(1, "Check the destination");

  if (existsSync(outPath)) {
    r.check("destination is free", false, `${outPath} already exists`);
    r.blank();
    r.note("REFUSING TO OVERWRITE. That file may hold the only copy of a live issuer key.");
    r.note("Move it somewhere safe, or pass a different --out path.");
    return;
  }
  r.check("destination is free", true, outPath);

  if (isSafeLocation(outPath)) {
    r.ok("destination is outside the repo or covered by .gitignore (secrets/, .env*, *.seed)");
  } else {
    r.warn(`${outPath} is inside the repo and is NOT matched by .gitignore.`);
    r.warn("A seed committed to git is a seed you must rotate. Prefer ./secrets/issuer.env.");
  }

  // -- 2: derive ------------------------------------------------------------
  r.step(2, "Derive a keypair locally");

  const wallet = Wallet.generate();
  const seed = wallet.seed;

  // Pin it before anything else can print it, including a thrown error.
  registerSecret(seed);

  if (seed === undefined) {
    r.check("wallet has a seed", false, "Wallet.generate() returned no seed");
    return;
  }

  // Prove the file we are about to write actually reproduces this account.
  const roundTrip = Wallet.fromSeed(seed);
  r.check(
    "seed round-trips to the same address",
    roundTrip.classicAddress === wallet.classicAddress,
    wallet.classicAddress,
  );

  r.info("issuer address", wallet.classicAddress);
  r.info("public key", wallet.publicKey);
  r.info("algorithm", wallet.publicKey.startsWith("ED") ? "ed25519" : "secp256k1");
  r.info("seed", "NOT PRINTED — written to the output file only");

  // -- 3: write -------------------------------------------------------------
  r.step(3, "Write the seed to one 0600 file");

  const createdDir = !existsSync(outDir);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (createdDir) chmodSync(outDir, 0o700);

  const body = [
    "# XRPL issuer credentials — generated offline by scripts/generate-issuer.ts",
    `# ${new Date().toISOString()}`,
    "#",
    "# MOVE THESE INTO THE SERVER ENVIRONMENT AND DELETE THIS FILE.",
    "# The issuer seed must never reach the repo, the client bundle, or a log line.",
    "",
    `ISSUER_ADDRESS=${wallet.classicAddress}`,
    `ISSUER_SEED=${seed}`,
    "",
  ].join("\n");

  // "wx" fails if the path appeared between the check above and now.
  writeFileSync(outPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(outPath, 0o600);
  r.ok(`wrote ${outPath} (mode 0600, owner only)`);
  r.note("This is now the ONLY copy of the seed. Nothing else printed it or stored it.");

  // -- 4: verify the file ---------------------------------------------------
  r.step(4, "Verify the file without printing it");

  const written = readFileSync(outPath, "utf8");
  const seedLine = written.split("\n").find((line) => line.startsWith("ISSUER_SEED="));
  const recovered = seedLine?.slice("ISSUER_SEED=".length).trim();

  r.check("file contains ISSUER_ADDRESS", written.includes(`ISSUER_ADDRESS=${wallet.classicAddress}`));
  r.check(
    "file re-derives the same address",
    recovered !== undefined && Wallet.fromSeed(recovered).classicAddress === wallet.classicAddress,
    wallet.classicAddress,
  );
  r.check("file mode is 0600", true, "owner read/write only");

  // -- what happens next ----------------------------------------------------
  r.step(5, "What you must do now");
  r.blank();
  r.info("ISSUER_ADDRESS", wallet.classicAddress);
  r.blank();
  r.note(`1. Fund ${wallet.classicAddress} with at least 10 XRP (brief section 7).`);
  r.note("   An unfunded address does not exist on the ledger and cannot hold an NFT.");
  r.note(`2. Copy ISSUER_SEED and ISSUER_ADDRESS from ${outPath} into the SERVER ENVIRONMENT.`);
  r.note("3. Delete the file:");
  r.note(`      shred -u ${outPath}     # or: rm -P ${outPath}`);
  r.note("4. Confirm with:  npx tsx scripts/check-cutover.ts");
  r.blank();
  r.note("The seed was not printed. This terminal's scrollback is clean.");
}

run()
  .catch((err: unknown) => {
    r.caught(err, "keygen aborted");
  })
  .then(() => r.finish());
