/**
 * Offline XrplGateway for unit tests.
 *
 * Queue responses per rippled command and per transaction type. Anything not
 * queued throws, so a test can never silently pass by hitting a default.
 */
import type {
  NetworkName,
  SubmitOptions,
  SubmitOutcome,
  XrplGateway,
} from "../../src/types.js";

export interface RecordedRequest {
  command: string;
  payload: Record<string, unknown>;
}

export interface RecordedSubmit {
  transactionType: string;
  tx: Record<string, unknown>;
  options?: SubmitOptions;
}

type RequestHandler = (payload: Record<string, unknown>) => unknown;
type SubmitHandler = (tx: Record<string, unknown>) => Partial<SubmitOutcome> | Error;

export class MockGateway implements XrplGateway {
  readonly network: NetworkName;
  readonly issuerAddress: string;
  readonly requests: RecordedRequest[] = [];
  readonly submits: RecordedSubmit[] = [];
  disconnected = false;

  private readonly requestHandlers = new Map<string, RequestHandler[]>();
  private readonly submitHandlers = new Map<string, SubmitHandler[]>();

  constructor(opts: { network?: NetworkName; issuerAddress?: string } = {}) {
    this.network = opts.network ?? "testnet";
    this.issuerAddress = opts.issuerAddress ?? "rISSUERxxxxxxxxxxxxxxxxxxxxxxxxxx";
  }

  /** Queue one response for `command`. Repeat to queue several in order. */
  onRequest(command: string, handler: RequestHandler | unknown): this {
    const fn: RequestHandler = typeof handler === "function" ? (handler as RequestHandler) : () => handler;
    const list = this.requestHandlers.get(command) ?? [];
    list.push(fn);
    this.requestHandlers.set(command, list);
    return this;
  }

  /** Queue one outcome for a transaction type, or an Error to throw. */
  onSubmit(transactionType: string, handler: SubmitHandler | Partial<SubmitOutcome> | Error): this {
    const fn: SubmitHandler =
      typeof handler === "function" ? (handler as SubmitHandler) : () => handler;
    const list = this.submitHandlers.get(transactionType) ?? [];
    list.push(fn);
    this.submitHandlers.set(transactionType, list);
    return this;
  }

  async request<Res = any>(req: Record<string, unknown>): Promise<Res> {
    const command = String(req.command);
    this.requests.push({ command, payload: req });
    const list = this.requestHandlers.get(command);
    if (!list || list.length === 0) {
      throw new Error(`MockGateway: no queued response for command "${command}"`);
    }
    const handler = list.length === 1 ? list[0]! : list.shift()!;
    const out = handler(req);
    if (out instanceof Error) throw out;
    return out as Res;
  }

  async submit(tx: any, options?: SubmitOptions): Promise<SubmitOutcome> {
    const transactionType = String(tx.TransactionType);
    this.submits.push({ transactionType, tx, options });
    const list = this.submitHandlers.get(transactionType);
    if (!list || list.length === 0) {
      throw new Error(`MockGateway: no queued outcome for "${transactionType}"`);
    }
    const handler = list.length === 1 ? list[0]! : list.shift()!;
    const out = handler(tx);
    if (out instanceof Error) throw out;
    return {
      hash: "MOCKHASH",
      ledgerIndex: 1,
      engineResult: "tesSUCCESS",
      validated: true,
      meta: {},
      fee: "12",
      ...out,
    };
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  /** Last submitted transaction of the given type. */
  lastSubmit(transactionType: string): Record<string, unknown> | undefined {
    return [...this.submits].reverse().find((s) => s.transactionType === transactionType)?.tx;
  }

  /** Last request payload for the given command. */
  lastRequest(command: string): Record<string, unknown> | undefined {
    return [...this.requests].reverse().find((r) => r.command === command)?.payload;
  }
}

/** A rippled-shaped error, e.g. rippledError("actNotFound"). */
export function rippledError(code: string, message = code): Error & { data: { error: string } } {
  const err = new Error(message) as Error & { data: { error: string } };
  err.data = { error: code };
  return err;
}
