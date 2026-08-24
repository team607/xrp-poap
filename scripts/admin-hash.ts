/**
 * ADMIN HASH — turn a password you type into the two environment lines the
 * server needs. Run by hand, once, per deployment.
 *
 *     npm run admin:hash
 *     npx tsx scripts/admin-hash.ts
 *
 * WHAT IT WILL NOT DO, and why:
 *
 *   - It never echoes the password. Typing is silent, there is no confirmation
 *     line reading it back, and it is never handed to console.log, to an error
 *     message or to a log sink. The only place it exists is a string in this
 *     process for as long as the scrypt takes.
 *   - It does not accept the password as an argument. `--password=hunter2`
 *     lands in shell history, in `ps` output and in CI logs; the whole point of
 *     this script is that the password only ever exists in one place. Passing
 *     one is refused rather than quietly honoured.
 *   - It writes no file. The output is two lines to paste into `.env` or into
 *     whatever holds the deployment's secrets — this script does not get to
 *     decide where that is.
 *
 * A piped password (`echo … | npm run admin:hash`) works, for a provisioning
 * script that already holds the value. It is second best: the pipe is fine, the
 * shell history that produced it usually is not.
 */
import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from "../src/api/auth.js";

const COLOR = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
const paint = (code: string, s: string): string => (COLOR ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s: string): string => paint("1", s);
const dim = (s: string): string => paint("2", s);
const red = (s: string): string => paint("31", s);
const green = (s: string): string => paint("32", s);
const yellow = (s: string): string => paint("33", s);

/** Every write goes through here so nothing can accidentally print the input. */
function say(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${red("✗")} ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Reading a password without echoing it
// ---------------------------------------------------------------------------

const ETX = "\u0003"; // ctrl-c
const EOT = "\u0004"; // ctrl-d
const BACKSPACE = new Set(["\u0008", "\u007f"]);

/**
 * Read one line from a TTY in raw mode, printing nothing.
 *
 * Raw mode rather than readline: readline's only way to suppress the echo is to
 * monkey-patch its private `_writeToOutput`, and a private API is a poor thing
 * to have standing between a password and a terminal that everyone can read.
 * Here the characters are simply never written anywhere.
 */
function readHiddenFromTty(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(prompt);

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const finish = (fn: () => void): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      fn();
    };

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish(() => resolve(buffer));
          return;
        }
        if (char === ETX) {
          finish(() => reject(new Error("Cancelled.")));
          return;
        }
        if (char === EOT) {
          finish(() => (buffer === "" ? reject(new Error("Cancelled.")) : resolve(buffer)));
          return;
        }
        if (BACKSPACE.has(char)) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        // Ignore the rest of the C0 range: arrow keys and friends arrive as
        // escape sequences and must not end up inside the password.
        if (char < " ") continue;
        buffer += char;
      }
    };

    stdin.on("data", onData);
  });
}

/** A pipe echoes nothing by definition, so this only has to read a line. */
function readLineFromPipe(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.split("\n")[0] ?? ""));
    process.stdin.on("error", reject);
  });
}

async function readPassword(prompt: string): Promise<string> {
  return process.stdin.isTTY ? readHiddenFromTty(prompt) : readLineFromPipe();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function refusePasswordArguments(argv: string[]): void {
  const offender = argv.find(
    (arg) => /^--?(password|pass|pw)\b/i.test(arg) || /^--?p=/i.test(arg),
  );
  if (!offender) return;

  // The value itself is NOT echoed back, not even as part of the complaint.
  fail(
    "Refusing to take a password from the command line: it is now in your shell history and in " +
      "`ps` output for anyone on this machine to read.\n" +
      "  Run `npm run admin:hash` with no arguments and type it at the prompt.\n" +
      `  Then clear the history entry that contains it (the flag was ${offender.split("=")[0]}=…).`,
  );
}

async function main(): Promise<void> {
  refusePasswordArguments(process.argv.slice(2));

  say();
  say(bold("admin-hash · one operator account for the POAP admin console"));
  say(dim("The password is never echoed, never logged and never written to disk."));
  say();

  const password = await readPassword("Admin password: ");

  if (password.length === 0) {
    fail("No password was entered.");
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    // Says the length it got, never the value — the length is already visible
    // to whoever typed it.
    fail(
      `That password is ${password.length} characters; the minimum is ${MIN_PASSWORD_LENGTH}.\n` +
        "  This is the only account on the system and it fronts the whole admin API: event\n" +
        "  creation, the registration list, and the desk console. A short password behind a\n" +
        "  slow hash is still a short password — scrypt buys you a few orders of magnitude,\n" +
        "  and a six-character password needs about ten.\n" +
        "  Use a passphrase: four or five unrelated words are easy to type at a desk and\n" +
        "  hopeless to guess.",
    );
  }

  if (process.stdin.isTTY) {
    const again = await readPassword("Confirm password: ");
    if (again !== password) {
      fail("The two entries do not match. Nothing was hashed; run it again.");
    }
  }

  const encoded = await hashPassword(password);

  // Cheap proof that what is about to be pasted actually verifies, before an
  // operator finds out at a login prompt at the door.
  if (!(await verifyPassword(password, encoded))) {
    fail("The hash did not verify against the password it was made from. This is a bug — stop.");
  }

  const sessionSecret = randomBytes(32).toString("hex");

  say(`${green("✓")} hashed with scrypt (N=32768, r=8, p=1, 64-byte key, random 16-byte salt)`);
  say();
  say(bold("Paste these into .env (or your secret store):"));
  say();
  say(`ADMIN_PASSWORD_HASH=${encoded}`);
  say(`SESSION_SECRET=${sessionSecret}`);
  say();
  say(dim("Then set ADMIN_EMAIL to the address you will sign in with. All three must be set:"));
  say(dim("the server refuses to start with only some of them, and serves 503 on /admin/api"));
  say(dim("with none of them. It never serves the admin API unauthenticated."));
  say();
  say(
    `${yellow("!")} In a ${bold(".env")} file paste the lines exactly as printed. In a ${bold("shell")}, ` +
      "single-quote the hash —",
  );
  say(`  the ${bold("$")} characters are separators, and an unquoted shell would expand them.`);
  say(
    `${yellow("!")} SESSION_SECRET above is freshly generated. Rotating it later invalidates every ` +
      "session,",
  );
  say("  which is exactly what you want after a leaked cookie.");
  say();
}

main().catch((err: unknown) => {
  // Whatever went wrong, the password is not part of the story: nothing in this
  // script ever puts it in an error.
  process.stderr.write(`${red("✗")} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
