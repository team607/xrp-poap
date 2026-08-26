/**
 * The only place in the codebase that talks to a rippled/Clio node.
 *
 * Everything else takes an XrplGateway, which is why the whole library is
 * unit-testable without a network.
 */
import { Client, Wallet, type SubmittableTransaction } from "xrpl";
import type { AppConfig } from "../config.js";
import {
  ConfigError,
  ConnectionError,
  TransactionFailedError,
  XrplLayerError,
} from "../errors.js";
import type {
  NetworkName,
  SubmitOptions,
  SubmitOutcome,
  XrplGateway,
} from "../types.js";

export interface ConnectionOptions {
  /** Milliseconds to wait for the initial connect on each endpoint. */
  connectTimeoutMs?: number;
  /** Signer used when submit() is called without an explicit wallet. */
  wallet?: Wallet;
  /**
   * Overrides cfg.issuerAddress. Scripts that mint from a faucet-funded
   * throwaway wallet use this instead of writing a seed into the environment.
   */
  issuerAddress?: string;
  /**
   * Builds the underlying client. Exists so tests can drive the real
   * reconnect logic against a stand-in socket instead of re-implementing the
   * policy in the test and asserting against that.
   */
  clientFactory?: (endpoint: string, opts: { connectionTimeout: number }) => Client;
}

/**
 * True when the failure is the socket, not the request.
 *
 * xrpl.js surfaces a dropped connection as NotConnectedError or
 * DisconnectedError depending on where in its stack the drop was noticed. A
 * public Clio server with no SLA WILL drop an idle socket, and without this the
 * process stays up while every ledger call fails forever.
 */
export function isDisconnectedError(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name ?? "";
  if (name === "NotConnectedError" || name === "DisconnectedError") return true;
  const message = err instanceof Error ? err.message : "";
  return /NotConnected|DisconnectedError|websocket was closed|not connected/i.test(
    `${name} ${message}`,
  );
}

/** True when a rippled response carried this specific error code. */
export function isRippledError(err: unknown, code: string): boolean {
  const data = (err as { data?: { error?: string } } | undefined)?.data;
  if (data?.error === code) return true;
  // Some transports surface the code only in the message.
  return err instanceof Error && err.message.includes(code);
}

function metaOf(result: Record<string, any>): Record<string, unknown> {
  const meta = result?.meta ?? result?.metaData;
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
}

/** nftoken_id and offer_id live in transaction metadata and nowhere else. */
export function metaString(outcome: SubmitOutcome, field: string): string | undefined {
  const v = outcome.meta[field];
  return typeof v === "string" ? v : undefined;
}

export function requireMetaString(outcome: SubmitOutcome, field: string): string {
  const v = metaString(outcome, field);
  if (!v) {
    throw new XrplLayerError(
      "TX_FAILED",
      `Transaction ${outcome.hash} succeeded but metadata has no "${field}". The node may be returning a reduced metadata shape.`,
      { field, hash: outcome.hash, metaKeys: Object.keys(outcome.meta) },
    );
  }
  return v;
}

export class XrplConnection implements XrplGateway {
  readonly network: NetworkName;
  readonly issuerAddress: string;
  private readonly defaultWallet?: Wallet;

  /** Mutable: a reconnect may land on a different endpoint. */
  #client: Client;
  #endpoint: string;
  /** Every endpoint we may use, primary first. Kept for reconnects. */
  readonly #endpoints: readonly string[];
  readonly #connectTimeoutMs: number;
  readonly #makeClient: (endpoint: string, opts: { connectionTimeout: number }) => Client;
  /** Collapses a stampede of concurrent failures into one reconnect. */
  #reconnecting: Promise<void> | undefined;

  /**
   * Stamped on everything this connection submits. See submit().
   */
  readonly #sourceTag: number | undefined;
  #closed = false;

  /** The raw client. Scripts use this for fundWallet(). */
  get client(): Client {
    return this.#client;
  }

  /** The endpoint currently in use, which may not be the configured primary. */
  get endpoint(): string {
    return this.#endpoint;
  }

  private constructor(
    client: Client,
    endpoint: string,
    network: NetworkName,
    issuerAddress: string,
    wallet: Wallet | undefined,
    endpoints: readonly string[],
    connectTimeoutMs: number,
    makeClient: (endpoint: string, opts: { connectionTimeout: number }) => Client,
    sourceTag: number | undefined,
  ) {
    this.#client = client;
    this.#endpoint = endpoint;
    this.network = network;
    this.issuerAddress = issuerAddress;
    this.defaultWallet = wallet;
    this.#endpoints = endpoints;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#makeClient = makeClient;
    this.#sourceTag = sourceTag;
  }

  /**
   * Rebuild the socket, walking the endpoint list from the top.
   *
   * Concurrent callers share one attempt: twenty in-flight requests hitting a
   * dead socket must not open twenty connections.
   */
  async #reconnect(): Promise<void> {
    if (this.#closed) {
      throw new ConnectionError("This XrplConnection has been disconnected.");
    }
    if (this.#reconnecting) return this.#reconnecting;

    this.#reconnecting = (async () => {
      try {
        await this.#client.disconnect();
      } catch {
        /* it is already gone; that is why we are here */
      }
      const failures: string[] = [];
      for (const endpoint of this.#endpoints) {
        const next = this.#makeClient(endpoint, { connectionTimeout: this.#connectTimeoutMs });
        try {
          await next.connect();
          this.#client = next;
          this.#endpoint = endpoint;
          return;
        } catch (err) {
          failures.push(`${endpoint}: ${(err as Error).message}`);
          try {
            await next.disconnect();
          } catch {
            /* nothing to close */
          }
        }
      }
      throw new ConnectionError(
        `Lost the XRPL connection and could not re-establish it (tried ${this.#endpoints.length}).`,
        { failures },
      );
    })().finally(() => {
      this.#reconnecting = undefined;
    });

    return this.#reconnecting;
  }

  /** Run `fn`; on a dropped socket, reconnect once and run it again. */
  async #withReconnect<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!isDisconnectedError(err)) throw err;
      if (this.#closed) {
        // Rethrowing the raw NotConnectedError here is useless: its message is
        // the request payload. Say what actually happened.
        throw new ConnectionError(
          "This XrplConnection has been disconnected; build a new one to talk to the ledger.",
          { endpoint: this.#endpoint },
        );
      }
      await this.#reconnect();
      return fn();
    }
  }

  /** Has this transaction already been validated? Used before any resend. */
  async #findByHash(hash: string): Promise<Record<string, any> | undefined> {
    try {
      const res = await this.#client.request({ command: "tx", transaction: hash } as any);
      return (res as { result?: Record<string, any> }).result;
    } catch (err) {
      if (isRippledError(err, "txnNotFound")) return undefined;
      throw err;
    }
  }

  /**
   * Connects to the primary endpoint, falling back through
   * XRPL_FALLBACK_ENDPOINTS in order. Public Clio servers carry no SLA, so a
   * fallback is not optional in anything you care about.
   */
  static async connect(
    cfg: AppConfig,
    options: ConnectionOptions = {},
  ): Promise<XrplConnection> {
    const { connectTimeoutMs = 15_000 } = options;
    const makeClient =
      options.clientFactory ?? ((endpoint, opts) => new Client(endpoint, opts));
    const endpoints = [cfg.endpoint, ...cfg.fallbackEndpoints];
    const failures: string[] = [];

    const wallet =
      options.wallet ?? (cfg.issuerSeed ? Wallet.fromSeed(cfg.issuerSeed) : undefined);
    const issuerAddress = options.issuerAddress ?? cfg.issuerAddress;

    // A transposed seed/address pair starts cleanly, reports the configured
    // address on /health, and then fails every mint on-chain with a bad
    // signature — a 502 in front of a queue of attendees. Catch it here.
    // The seed itself never enters the error.
    if (!options.wallet && wallet && issuerAddress && wallet.classicAddress !== issuerAddress) {
      throw new ConfigError(
        `ISSUER_SEED derives ${wallet.classicAddress} but ISSUER_ADDRESS is ${issuerAddress}. ` +
          `Every mint would be signed by an account that is not the configured issuer.`,
        { derivedAddress: wallet.classicAddress, configuredAddress: issuerAddress },
      );
    }

    for (const endpoint of endpoints) {
      const client = makeClient(endpoint, { connectionTimeout: connectTimeoutMs });
      try {
        await client.connect();
        return new XrplConnection(
          client,
          endpoint,
          cfg.network,
          issuerAddress,
          wallet,
          endpoints,
          connectTimeoutMs,
          makeClient,
          cfg.sourceTag,
        );
      } catch (err) {
        failures.push(`${endpoint}: ${(err as Error).message}`);
        try {
          await client.disconnect();
        } catch {
          /* already down */
        }
      }
    }

    throw new ConnectionError(
      `Could not connect to any XRPL endpoint (tried ${endpoints.length}).`,
      { failures },
    );
  }

  /** Reads are pure, so a dropped socket is simply retried on a fresh one. */
  async request<Res = any>(req: Record<string, unknown>): Promise<Res> {
    return this.#withReconnect(
      async () => (await this.#client.request(req as any)) as Res,
    );
  }

  /**
   * Autofill, sign, submit, and wait for validation. Asserts tesSUCCESS unless
   * told otherwise.
   */
  async submit(
    tx: SubmittableTransaction,
    options: SubmitOptions = {},
  ): Promise<SubmitOutcome> {
    const wallet = options.wallet ?? this.defaultWallet;
    if (!wallet) {
      throw new ConnectionError(
        "submit() needs a signing wallet: none was passed and no ISSUER_SEED was configured.",
      );
    }

    // Split deliberately into prepare-and-sign, then send.
    //
    // A dropped socket during PREPARE has put nothing on the wire, so the whole
    // step is safe to redo. A dropped socket during SEND is the dangerous case:
    // re-running autofill would allocate a NEW Sequence, and resubmitting under
    // it would mint a second badge for one claim. So the signed blob is reused
    // verbatim — the ledger enforces one application per (Account, Sequence) —
    // and before resending at all we ask whether it already landed.

    // SourceTag goes on HERE, not at each call site.
    //
    // It was wired into the Xaman payload only, so the one transaction the app
    // does NOT submit — the attendee's accept — carried the tag and the three
    // it does submit did not. Measured on a live issuer: 1 of 4. `.env.example`
    // promises "every transaction this app submits", so the promise is kept in
    // the one place every submission passes through.
    //
    // An explicit SourceTag on the transaction wins: a caller that set one
    // meant it.
    const tagged: SubmittableTransaction =
      this.#sourceTag !== undefined && (tx as { SourceTag?: number }).SourceTag === undefined
        ? ({ ...tx, SourceTag: this.#sourceTag } as SubmittableTransaction)
        : tx;

    // --- prepare + sign: nothing sent yet, retry freely ---------------------
    const signed = await this.#withReconnect(async () => {
      const prepared = await this.#client.autofill(tagged);
      return wallet.sign(prepared);
    });

    // --- send: the same bytes, or nothing ----------------------------------
    let response: { result: unknown };
    try {
      response = await this.#client.submitAndWait(signed.tx_blob);
    } catch (err) {
      if (!isDisconnectedError(err) || this.#closed) throw err;
      await this.#reconnect();
      // It may well have been applied before the socket died. Ask first: a
      // blind resend is safe against duplication but a needless round trip,
      // and a landed transaction is the answer we already want.
      const landed = await this.#findByHash(signed.hash);
      response = landed
        ? { result: landed }
        : await this.#client.submitAndWait(signed.tx_blob);
    }
    const result = response.result as Record<string, any>;
    const meta = metaOf(result);

    const engineResult =
      (typeof meta.TransactionResult === "string" ? meta.TransactionResult : undefined) ??
      result.engine_result ??
      "unknown";

    const outcome: SubmitOutcome = {
      hash: result.hash ?? result.tx_json?.hash ?? "",
      ledgerIndex: result.ledger_index ?? 0,
      engineResult,
      validated: result.validated === true,
      meta,
      fee: String(result.tx_json?.Fee ?? result.Fee ?? "0"),
    };

    if (options.throwOnFailure !== false && engineResult !== "tesSUCCESS") {
      throw new TransactionFailedError(
        engineResult,
        `${tx.TransactionType} failed with ${engineResult}`,
        { txHash: outcome.hash, transactionType: tx.TransactionType },
      );
    }

    return outcome;
  }

  async disconnect(): Promise<void> {
    // Latch first: a reconnect racing a deliberate shutdown would resurrect the
    // socket the caller just asked us to close.
    this.#closed = true;
    if (this.#client.isConnected()) await this.#client.disconnect();
  }
}

/** Convenience factory. */
export async function createGateway(
  cfg: AppConfig,
  options?: ConnectionOptions,
): Promise<XrplConnection> {
  return XrplConnection.connect(cfg, options);
}

/** Runs `fn` with a connection and always disconnects, even on throw. */
export async function withGateway<T>(
  cfg: AppConfig,
  fn: (gateway: XrplConnection) => Promise<T>,
  options?: ConnectionOptions,
): Promise<T> {
  const gateway = await XrplConnection.connect(cfg, options);
  try {
    return await fn(gateway);
  } finally {
    await gateway.disconnect();
  }
}
