/**
 * ============================================================================
 * THE CIDs THIS FILE PRODUCES ARE NOT REAL IPFS CONTENT ADDRESSES.
 *
 * They are a sha256 of the bytes wearing a `bafkTEST` prefix. Nothing is
 * uploaded anywhere. Any `ipfs://` URI minted against this pinner will NEVER
 * resolve — not from Pinata, not from a public gateway, not from your own
 * node — and because NFTokenMint's URI is immutable, a badge minted against
 * one is permanently broken. There is no fixing it after the fact.
 *
 * For unit tests and offline development only. Constructing it with
 * `{ network: "mainnet" }` makes every pin throw, on purpose.
 * ============================================================================
 */
import { createHash } from "node:crypto";
import { MetadataError } from "../errors.js";
import type { IpfsPinner, NetworkName, PinResult } from "../types.js";

/** Reserved TLD (RFC 2606). Guaranteed not to resolve, which is the point. */
export const MEMORY_GATEWAY = "https://ipfs.invalid";

/** Prefix chosen to be obvious in a log, a database row, or an explorer. */
export const MEMORY_CID_PREFIX = "bafkTEST";

export interface MemoryPinEntry {
  cid: string;
  uri: string;
  gatewayUrl: string;
  kind: "file" | "json";
  /** Byte length of the pinned content. */
  size: number;
  /** Exactly the bytes that were hashed. */
  data: Uint8Array;
  filename?: string;
  contentType?: string;
  /** Present for kind === "json": the value as handed to pinJson. */
  json?: unknown;
  /** Pin label: the filename, or the name passed to pinJson. */
  name: string;
}

export interface MemoryPinnerOptions {
  network?: NetworkName;
  /** Override the fake gateway origin. Still fake. */
  gateway?: string;
}

/** sha256 of the bytes, first 40 hex chars, behind a loud prefix. */
export function fakeCidFor(data: Uint8Array): string {
  const hex = createHash("sha256").update(data).digest("hex");
  return `${MEMORY_CID_PREFIX}${hex.slice(0, 40)}`;
}

export class MemoryPinner implements IpfsPinner {
  readonly network: NetworkName;
  readonly gateway: string;
  private readonly store = new Map<string, MemoryPinEntry>();

  constructor(options: MemoryPinnerOptions = {}) {
    this.network = options.network ?? "testnet";
    this.gateway = (options.gateway ?? MEMORY_GATEWAY).replace(/\/+$/, "");
  }

  async pinFile(input: {
    data: Uint8Array | Buffer;
    filename: string;
    contentType?: string;
  }): Promise<PinResult> {
    this.assertNotMainnet(input.filename);
    const data = Uint8Array.from(input.data);
    const entry: MemoryPinEntry = {
      ...this.address(data),
      kind: "file",
      size: data.byteLength,
      data,
      name: input.filename,
      filename: input.filename,
    };
    if (input.contentType !== undefined) entry.contentType = input.contentType;
    return this.remember(entry);
  }

  async pinJson(input: { json: unknown; name: string }): Promise<PinResult> {
    this.assertNotMainnet(input.name);
    let serialized: string;
    try {
      serialized = JSON.stringify(input.json) ?? "null";
    } catch (cause) {
      throw new MetadataError(
        "METADATA_INVALID",
        `Cannot serialise "${input.name}" to JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        { name: input.name },
      );
    }
    const data = new TextEncoder().encode(serialized);
    return this.remember({
      ...this.address(data),
      kind: "json",
      size: data.byteLength,
      data,
      name: input.name,
      json: input.json,
    });
  }

  /** Everything pinned so far, in insertion order. */
  list(): MemoryPinEntry[] {
    return [...this.store.values()];
  }

  /** Read back a pin by CID. Undefined when nothing was pinned under it. */
  get(cid: string): MemoryPinEntry | undefined {
    return this.store.get(cid);
  }

  /** Read back a pin by `ipfs://<cid>` URI. */
  getByUri(uri: string): MemoryPinEntry | undefined {
    return this.store.get(uri.replace(/^ipfs:\/\//, "").split("/")[0] ?? "");
  }

  /** Decoded JSON of a pin, or undefined when the CID holds raw bytes. */
  getJson(cid: string): unknown {
    return this.store.get(cid)?.json;
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  private address(data: Uint8Array): { cid: string; uri: string; gatewayUrl: string } {
    const cid = fakeCidFor(data);
    return { cid, uri: `ipfs://${cid}`, gatewayUrl: `${this.gateway}/ipfs/${cid}` };
  }

  private remember(entry: MemoryPinEntry): PinResult {
    this.store.set(entry.cid, entry);
    return { cid: entry.cid, uri: entry.uri, gatewayUrl: entry.gatewayUrl, size: entry.size };
  }

  private assertNotMainnet(what: string): void {
    if (this.network === "mainnet") {
      throw new MetadataError(
        "PIN_FAILED",
        `MemoryPinner refuses to pin "${what}" on mainnet: its CIDs are fake and a badge minted against one can never resolve. Use PinataPinner.`,
        { network: this.network, name: what },
      );
    }
  }
}

/** Free-function accessor, for tests that hold a plain IpfsPinner reference. */
export function getPinned(pinner: MemoryPinner, cid: string): MemoryPinEntry | undefined {
  return pinner.get(cid);
}
