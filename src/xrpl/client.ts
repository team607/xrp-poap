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
  readonly endpoint: string;
  readonly client: Client;
  private readonly defaultWallet?: Wallet;

  private constructor(
    client: Client,
    endpoint: string,
    network: NetworkName,
    issuerAddress: string,
    wallet?: Wallet,
  ) {
    this.client = client;
    this.endpoint = endpoint;
    this.network = network;
    this.issuerAddress = issuerAddress;
    this.defaultWallet = wallet;
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
      const client = new Client(endpoint, { connectionTimeout: connectTimeoutMs });
      try {
        await client.connect();
        return new XrplConnection(client, endpoint, cfg.network, issuerAddress, wallet);
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

  async request<Res = any>(req: Record<string, unknown>): Promise<Res> {
    return (await this.client.request(req as any)) as Res;
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

    const prepared = await this.client.autofill(tx);
    const response = await this.client.submitAndWait(prepared, { wallet });
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
    if (this.client.isConnected()) await this.client.disconnect();
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
