/**
 * Console reporting for the hand-run operator scripts in `scripts/`.
 *
 * These scripts are run by a human, usually once, usually under time pressure,
 * often the morning of a demo. So the output is loud and sequential: every step
 * is numbered, every assertion prints pass or fail as it happens, and every run
 * ends with a summary table and an exit code — 0 pass, 1 fail.
 *
 * Two rules this module exists to enforce:
 *
 *   1. NEVER PRINT A SEED. Everything printed goes through `redact()` first.
 *      Register known secrets with `registerSecret()` and they are scrubbed from
 *      every subsequent line, including error messages and stack traces. A
 *      wallet is shown as its address plus a four-character seed fingerprint
 *      (`sEd4…`), which is enough to prove to an operator that a key exists
 *      without putting the key on a terminal, in a scrollback buffer, or in a
 *      CI log.
 *   2. Never take a script down with it. Nothing here touches the network and
 *      the only import is a type, so a bug in the library cannot break the
 *      reporting of that bug.
 */
import type { NetworkName } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const COLOR =
  process.env.FORCE_COLOR === "1" ||
  (process.env.NO_COLOR === undefined && process.stdout.isTTY === true);

const ESC = "\u001b[";

function paint(code: string, s: string): string {
  return COLOR ? `${ESC}${code}m${s}${ESC}0m` : s;
}

const green = (s: string): string => paint("32", s);
const red = (s: string): string => paint("31", s);
const yellow = (s: string): string => paint("33", s);
const cyan = (s: string): string => paint("36", s);
const dim = (s: string): string => paint("2", s);
const bold = (s: string): string => paint("1", s);
const bgRed = (s: string): string => paint("41;97;1", s);
const bgGreen = (s: string): string => paint("42;30;1", s);

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Exact secret values pinned by the caller. Scrubbed from every printed line. */
const SECRETS = new Set<string>();

/**
 * XRPL family seeds: base58, leading `s`, 29 characters in practice. The range
 * is deliberately wide — a false positive costs a redacted log line, a false
 * negative costs the issuer account.
 */
const SEED_SHAPED = /\bs[1-9A-HJ-NP-Za-km-z]{24,50}\b/g;

/**
 * Object keys whose values are never safe to print.
 *
 * Matched on the WHOLE key, never on a substring of it. A substring rule looks
 * safer and is actively harmful: "token" is a substring of "nftokenId", so a
 * substring match censors the single most useful field in a verifyClaim dump.
 * Keys are normalised (lowercased, non-alphanumerics stripped) and then have to
 * equal or END WITH one of these.
 */
const SECRET_KEY_SUFFIXES = [
  "seed",
  "secret",
  "password",
  "passphrase",
  "privatekey",
  "apikey",
  "apisecret",
  "authorization",
  "jwt",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "sessiontoken",
  "mnemonic",
];

/** Redacted only when the whole normalised key is exactly this. */
const SECRET_KEY_EXACT = ["token"];

/**
 * REDACTED:     seed, issuerSeed, ISSUER_SEED, secret, apiSecret, PINATA_JWT,
 *               jwt, password, authorization, token, accessToken, refresh_token
 * NOT REDACTED: nftokenId, nftokenIdSource, NFTokenID, nftoken_id, tokenTaxon,
 *               offerId, txHash, address
 *
 * Those cases are asserted by selfTest() below:
 *   REPORT_SELFTEST=1 npx tsx scripts/lib/report.ts
 */
export function isSecretKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SECRET_KEY_EXACT.includes(normalised)) return true;
  return SECRET_KEY_SUFFIXES.some((suffix) => normalised.endsWith(suffix));
}

/**
 * Pin a value as secret. Call this the moment a seed enters the process — before
 * the first line that could possibly contain it.
 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === "string" && value.trim().length >= 8) SECRETS.add(value.trim());
}

/** Proof a key exists without disclosing it: first four characters, then "…". */
export function seedFingerprint(seed: string | undefined | null): string {
  if (typeof seed !== "string" || seed.length === 0) return "[unset]";
  if (seed.length <= 4) return "…";
  return `${seed.slice(0, 4)}…`;
}

/** Scrub pinned secrets and anything seed-shaped out of a string. */
export function redactString(input: string): string {
  let out = input;
  for (const secret of SECRETS) {
    if (secret.length > 0 && out.includes(secret)) {
      out = out.split(secret).join(`${seedFingerprint(secret)}[REDACTED-SECRET]`);
    }
  }
  return out.replace(SEED_SHAPED, (match) => `${match.slice(0, 4)}…[REDACTED-SEED]`);
}

/**
 * Deep-redact any value before printing it. Strings are scrubbed, keys that look
 * like credentials are replaced wholesale, cycles are cut.
 *
 * Use this on anything derived from config, from a wallet, or from an error.
 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...redactPlain(value as unknown as Record<string, unknown>, seen),
    };
  }
  return redactPlain(value as Record<string, unknown>, seen);
}

function redactPlain(
  input: Record<string, unknown>,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (isSecretKey(key)) {
      out[key] = raw === undefined || raw === null || raw === "" ? "[unset]" : "[redacted]";
      continue;
    }
    out[key] = redact(raw, seen);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/**
 * Exact drops -> XRP for display. Integer maths only: `dropsToXrp()` returns a
 * JS number in xrpl v5, and float arithmetic on balances is banned (CLAUDE.md).
 */
export function formatXrp(drops: bigint | string | number): string {
  const n = typeof drops === "bigint" ? drops : BigInt(String(drops).split(".")[0] ?? "0");
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${frac.length > 0 ? `.${frac}` : ""}`;
}

// ---------------------------------------------------------------------------
// Explorer links — every script prints one so a human can confirm off-box
// ---------------------------------------------------------------------------

/** Bithomp is the only one of the three that covers all networks. */
const BITHOMP: Record<NetworkName, string> = {
  mainnet: "https://bithomp.com",
  testnet: "https://test.bithomp.com",
  devnet: "https://dev.bithomp.com",
};

const XRPL_ORG: Record<NetworkName, string> = {
  mainnet: "https://livenet.xrpl.org",
  testnet: "https://testnet.xrpl.org",
  devnet: "https://devnet.xrpl.org",
};

/** Primary (Bithomp) link for a transaction hash. */
export function explorerTxUrl(network: NetworkName, hash: string): string {
  return `${BITHOMP[network]}/explorer/${hash}`;
}

/** Primary (Bithomp) link for an account. */
export function explorerAccountUrl(network: NetworkName, address: string): string {
  return `${BITHOMP[network]}/explorer/${address}`;
}

/** Every explorer that can show this transaction. XRPScan is mainnet-only. */
export function explorerTxUrls(network: NetworkName, hash: string): string[] {
  const urls = [explorerTxUrl(network, hash), `${XRPL_ORG[network]}/transactions/${hash}`];
  if (network === "mainnet") urls.push(`https://xrpscan.com/tx/${hash}`);
  return urls;
}

/** Every explorer that can show this account. XRPScan is mainnet-only. */
export function explorerAccountUrls(network: NetworkName, address: string): string[] {
  const urls = [
    explorerAccountUrl(network, address),
    `${XRPL_ORG[network]}/accounts/${address}`,
  ];
  if (network === "mainnet") urls.push(`https://xrpscan.com/account/${address}`);
  return urls;
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckRow {
  name: string;
  status: CheckStatus;
  detail?: string;
}

const KEY_WIDTH = 24;
const RULE = "─".repeat(78);

export class Reporter {
  private readonly rows: CheckRow[] = [];
  private readonly startedAt = Date.now();
  private failures = 0;

  constructor(private readonly title: string) {}

  // -- structure ------------------------------------------------------------

  /** Big banner naming the script and what it is about to do. */
  header(subtitle?: string): void {
    console.log("");
    console.log(bold(cyan(RULE)));
    console.log(bold(cyan(`  ${this.title}`)));
    if (subtitle !== undefined) console.log(cyan(`  ${subtitle}`));
    console.log(bold(cyan(RULE)));
  }

  /** Numbered step banner. The scripts are a sequence; show where we are. */
  step(n: number, title: string): void {
    console.log("");
    console.log(bold(`STEP ${n}  ${title}`));
    console.log(dim(RULE));
  }

  rule(): void {
    console.log(dim(RULE));
  }

  blank(): void {
    console.log("");
  }

  // -- lines ----------------------------------------------------------------

  ok(msg: string): void {
    console.log(`  ${green("PASS")}  ${redactString(msg)}`);
  }

  /** Prints a failure AND sets the exit code to 1. There is no soft fail. */
  fail(msg: string): void {
    this.failures += 1;
    console.log(`  ${red("FAIL")}  ${redactString(msg)}`);
  }

  warn(msg: string): void {
    console.log(`  ${yellow("WARN")}  ${redactString(msg)}`);
  }

  note(msg: string): void {
    console.log(`  ${dim("note")}  ${redactString(msg)}`);
  }

  /** Aligned key/value. The value is deep-redacted before it is printed. */
  info(key: string, value: unknown): void {
    const shown =
      typeof value === "string" ? redactString(value) : JSON.stringify(redact(value));
    console.log(`  ${dim(`${key}:`.padEnd(KEY_WIDTH))}${shown ?? "undefined"}`);
  }

  /** A wallet exists, and here is the proof — without the key. */
  wallet(label: string, address: string, seed?: string): void {
    console.log(
      `  ${dim(`${label}:`.padEnd(KEY_WIDTH))}${address}  ${dim(`seed ${seedFingerprint(seed)}`)}`,
    );
  }

  /** Pretty-printed JSON. Used by 02 to dump raw ledger responses verbatim. */
  json(label: string, value: unknown): void {
    console.log(`  ${dim(`${label}:`)}`);
    const text = JSON.stringify(redact(value), null, 2) ?? "undefined";
    for (const line of text.split("\n")) console.log(`    ${line}`);
  }

  link(label: string, url: string): void {
    console.log(`  ${dim(`${label}:`.padEnd(KEY_WIDTH))}${cyan(url)}`);
  }

  links(label: string, urls: string[]): void {
    urls.forEach((url, i) => this.link(i === 0 ? label : "", url));
  }

  /** An error, redacted, with the typed code and details when it has them. */
  caught(err: unknown, context?: string): void {
    const prefix = context === undefined ? "" : `${context}: `;
    if (err instanceof Error) {
      const code = (err as { code?: unknown }).code;
      this.fail(`${prefix}${err.name}${typeof code === "string" ? ` [${code}]` : ""}: ${err.message}`);
      const details = (err as { details?: unknown }).details;
      if (details !== undefined) this.json("error details", details);
      if (err.stack !== undefined) {
        console.log(dim(redactString(err.stack).split("\n").slice(1).join("\n")));
      }
      return;
    }
    this.fail(`${prefix}${String(err)}`);
  }

  // -- assertions -----------------------------------------------------------

  /**
   * Record and print one named assertion. Returns the condition so callers can
   * branch. A false condition sets the process exit code to 1.
   */
  check(name: string, passed: boolean, detail?: string): boolean {
    this.rows.push({ name, status: passed ? "pass" : "fail", detail });
    if (passed) this.ok(detail === undefined ? name : `${name} — ${detail}`);
    else this.fail(detail === undefined ? name : `${name} — ${detail}`);
    return passed;
  }

  /**
   * Record something this run could not determine. Never a false pass: a skip is
   * visibly a skip in the summary and the operator has to decide.
   */
  skip(name: string, detail?: string): void {
    this.rows.push({ name, status: "skip", detail });
    console.log(`  ${yellow("SKIP")}  ${redactString(detail === undefined ? name : `${name} — ${detail}`)}`);
  }

  /**
   * A single claim, called out in a box because the whole architecture rests on
   * it. Used by 02 for "verifyClaim still says attended after a burn".
   */
  verdict(name: string, passed: boolean, detail?: string): void {
    this.rows.push({ name, status: passed ? "pass" : "fail", detail });
    if (!passed) this.failures += 1;
    const tag = passed ? bgGreen("  PASS  ") : bgRed("  FAIL  ");
    console.log("");
    console.log(`${tag} ${bold(name)}`);
    if (detail !== undefined) console.log(`         ${redactString(detail)}`);
    console.log("");
  }

  // -- result ---------------------------------------------------------------

  get failureCount(): number {
    return this.failures;
  }

  get exitCode(): number {
    return this.failures > 0 ? 1 : 0;
  }

  /** The summary table. Read this line and you know whether the run was good. */
  summary(): void {
    const width = Math.min(
      60,
      Math.max(20, ...this.rows.map((row) => row.name.length)),
    );

    console.log("");
    console.log(bold(cyan(RULE)));
    console.log(bold(cyan(`  SUMMARY — ${this.title}`)));
    console.log(bold(cyan(RULE)));

    if (this.rows.length === 0) console.log(dim("  (no checks recorded)"));

    for (const row of this.rows) {
      const tag =
        row.status === "pass" ? green("PASS") : row.status === "fail" ? red("FAIL") : yellow("SKIP");
      const detail = row.detail === undefined ? "" : dim(`  ${redactString(row.detail)}`);
      console.log(`  ${tag}  ${row.name.padEnd(width)}${detail}`);
    }

    const passed = this.rows.filter((r) => r.status === "pass").length;
    const failed = this.rows.filter((r) => r.status === "fail").length;
    const skipped = this.rows.filter((r) => r.status === "skip").length;
    const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);

    console.log(dim(RULE));
    console.log(
      `  ${passed} passed, ${failed} failed, ${skipped} skipped in ${seconds}s`,
    );
    console.log(
      this.exitCode === 0
        ? bgGreen("  RESULT: PASS  ") + green("  exit 0")
        : bgRed("  RESULT: FAIL  ") + red(`  exit 1  (${this.failures} failure(s))`),
    );
    console.log("");
  }

  /** Print the summary, flush stdout, exit 0 on pass and 1 on fail. */
  async finish(): Promise<never> {
    this.summary();
    return exitWith(this.exitCode);
  }
}

export function createReport(title: string): Reporter {
  return new Reporter(title);
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/**
 * Redaction is the one thing in here that fails silently and expensively: too
 * loose and a seed reaches a log, too tight and it censors `nftokenId`, which
 * is the field an operator most needs to read. Both directions are asserted.
 *
 *   REPORT_SELFTEST=1 npx tsx scripts/lib/report.ts
 */
export function selfTest(): boolean {
  const mustRedact = [
    "seed",
    "issuerSeed",
    "ISSUER_SEED",
    "secret",
    "apiSecret",
    "PINATA_JWT",
    "jwt",
    "password",
    "authorization",
    "token",
    "accessToken",
    "refresh_token",
    "privateKey",
  ];
  const mustNotRedact = [
    "nftokenId",
    "nftokenIdSource",
    "NFTokenID",
    "nftoken_id",
    "tokenTaxon",
    "offerId",
    "txHash",
    "address",
    "issuerAddress",
    "status",
    "attended",
  ];

  let failures = 0;
  const line = (pass: boolean, message: string): void => {
    if (!pass) failures += 1;
    console.log(`  ${pass ? green("PASS") : red("FAIL")}  ${message}`);
  };

  console.log(bold("redact(): keys that MUST be redacted"));
  for (const key of mustRedact) line(isSecretKey(key), key);

  console.log(bold("redact(): keys that must NOT be redacted"));
  for (const key of mustNotRedact) line(!isSecretKey(key), key);

  console.log(bold("redact(): values"));
  const sample = redact({
    nftokenId: "000800001A2B",
    nftokenIdSource: "meta.nftoken_id",
    issuerSeed: "sEdSomethingSecretGoesHereXXXXX",
    nested: { apiSecret: "hunter2", txHash: "ABCD" },
  }) as Record<string, any>;
  line(sample.nftokenId === "000800001A2B", "nftokenId survives verbatim");
  line(sample.nftokenIdSource === "meta.nftoken_id", "nftokenIdSource survives verbatim");
  line(sample.issuerSeed === "[redacted]", "issuerSeed is redacted");
  line(sample.nested?.apiSecret === "[redacted]", "nested apiSecret is redacted");
  line(sample.nested?.txHash === "ABCD", "nested txHash survives verbatim");

  console.log(bold("redactString(): pinned and seed-shaped values"));
  registerSecret("sEdVpinnedSecretValue1234567890");
  line(
    !redactString("the seed is sEdVpinnedSecretValue1234567890 ok").includes("pinnedSecretValue"),
    "a pinned secret is scrubbed from free text",
  );
  line(
    redactString("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh").includes("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"),
    "an r-address is left alone",
  );

  console.log("");
  console.log(failures === 0 ? bgGreen("  SELF-TEST PASS  ") : bgRed(`  SELF-TEST FAIL (${failures})  `));
  return failures === 0;
}

if (process.env.REPORT_SELFTEST === "1") {
  process.exitCode = selfTest() ? 0 : 1;
}

/**
 * Exit without truncating output. `process.exit()` can drop buffered writes when
 * stdout is a pipe, which is exactly how these scripts get captured into a log.
 */
export async function exitWith(code: number): Promise<never> {
  process.exitCode = code;
  await new Promise<void>((resolve) => {
    if (process.stdout.write("")) resolve();
    else process.stdout.once("drain", () => resolve());
  });
  process.exit(code);
}
