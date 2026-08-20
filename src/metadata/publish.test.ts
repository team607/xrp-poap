import { describe, expect, it } from "vitest";
import { MetadataError, XrplLayerError } from "../errors.js";
import { MAX_URI_BYTES, type IpfsPinner, type PinResult } from "../types.js";
import {
  MEMORY_CID_PREFIX,
  MemoryPinner,
  fakeCidFor,
  getPinned,
} from "./memory-pinner.js";
import { publishBadge, type PublishBadgeInput } from "./publish.js";
import { TRAIT_EVENT_ID, XLS24D_SCHEMA_URI, assertValidBadgeMetadata } from "./schema.js";

const IMAGE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const input: PublishBadgeInput = {
  image: { data: IMAGE, filename: "badge.png", contentType: "image/png" },
  metadata: {
    name: "Feooh Meetup Badge",
    description: "Proof of attendance.",
    eventId: 4242,
    eventName: "Launch Night",
    collection: { name: "Feooh POAP", family: "Feooh" },
  },
};

describe("MemoryPinner", () => {
  it("is deterministic: identical bytes give an identical CID", async () => {
    const a = new MemoryPinner();
    const b = new MemoryPinner();
    const first = await a.pinFile({ data: IMAGE, filename: "badge.png" });
    const second = await b.pinFile({ data: Uint8Array.from(IMAGE), filename: "other-name.png" });
    expect(first.cid).toBe(second.cid);
    expect(first.cid).toBe(fakeCidFor(IMAGE));
    expect(first.uri).toBe(`ipfs://${first.cid}`);
  });

  it("labels its CIDs as fake and unresolvable", async () => {
    const pinner = new MemoryPinner();
    const result = await pinner.pinFile({ data: IMAGE, filename: "badge.png" });
    expect(result.cid.startsWith(MEMORY_CID_PREFIX)).toBe(true);
    expect(result.cid).toHaveLength(MEMORY_CID_PREFIX.length + 40);
    // .invalid is reserved and can never resolve. That is the point.
    expect(result.gatewayUrl).toContain(".invalid/ipfs/");
  });

  it("gives different bytes a different CID", async () => {
    const pinner = new MemoryPinner();
    const a = await pinner.pinFile({ data: new Uint8Array([1]), filename: "a.png" });
    const b = await pinner.pinFile({ data: new Uint8Array([2]), filename: "b.png" });
    expect(a.cid).not.toBe(b.cid);
    expect(pinner.size).toBe(2);
  });

  it("reads back what was pinned", async () => {
    const pinner = new MemoryPinner();
    const file = await pinner.pinFile({
      data: IMAGE,
      filename: "badge.png",
      contentType: "image/png",
    });
    const doc = await pinner.pinJson({ json: { hello: "world" }, name: "doc.json" });

    const entry = getPinned(pinner, file.cid);
    expect(entry?.kind).toBe("file");
    expect(entry?.filename).toBe("badge.png");
    expect(entry?.contentType).toBe("image/png");
    expect(entry?.data).toEqual(IMAGE);
    expect(entry?.size).toBe(IMAGE.byteLength);

    expect(pinner.getJson(doc.cid)).toEqual({ hello: "world" });
    expect(pinner.get(doc.cid)?.kind).toBe("json");
    expect(pinner.getByUri(doc.uri)?.name).toBe("doc.json");
    expect(pinner.list()).toHaveLength(2);
    expect(getPinned(pinner, "bafkTESTnope")).toBeUndefined();

    pinner.clear();
    expect(pinner.size).toBe(0);
  });

  it("refuses to pin on mainnet, because these CIDs never resolve", async () => {
    const pinner = new MemoryPinner({ network: "mainnet" });
    await expect(pinner.pinFile({ data: IMAGE, filename: "badge.png" })).rejects.toBeInstanceOf(
      MetadataError,
    );
    await expect(pinner.pinJson({ json: {}, name: "doc.json" })).rejects.toMatchObject({
      code: "PIN_FAILED",
    });
    await expect(pinner.pinJson({ json: {}, name: "doc.json" })).rejects.toThrow(/mainnet/);
    expect(pinner.size).toBe(0);
  });

  it("still works on testnet and devnet", async () => {
    await expect(
      new MemoryPinner({ network: "devnet" }).pinJson({ json: {}, name: "d.json" }),
    ).resolves.toMatchObject({ uri: expect.stringContaining("ipfs://") });
  });
});

describe("publishBadge", () => {
  it("pins the image, then the validated metadata, and returns both URIs", async () => {
    const pinner = new MemoryPinner();
    const result = await publishBadge(pinner, input);

    expect(result.imageUri).toBe(`ipfs://${fakeCidFor(IMAGE)}`);
    expect(result.metadataUri).toBe(result.pin.uri);
    expect(result.metadataUri).not.toBe(result.imageUri);
    expect(result.metadataUri.startsWith("ipfs://")).toBe(true);

    expect(result.metadata).toMatchObject({
      schema: XLS24D_SCHEMA_URI,
      nftType: "art.v0",
      name: "Feooh Meetup Badge",
      image: result.imageUri,
      collection: { name: "Feooh POAP", family: "Feooh" },
    });
    expect(result.metadata.attributes[0]).toEqual({ trait_type: TRAIT_EVENT_ID, value: 4242 });
    expect(() => assertValidBadgeMetadata(result.metadata)).not.toThrow();

    // What was pinned is exactly what was returned.
    expect(pinner.getJson(result.pin.cid)).toEqual(result.metadata);
    expect(pinner.get(result.pin.cid)?.name).toBe("badge-4242-metadata.json");
    expect(pinner.list().map((e) => e.kind)).toEqual(["file", "json"]);
    expect(result.pin.gatewayUrl).toContain(result.pin.cid);
  });

  it("is deterministic end to end", async () => {
    const a = await publishBadge(new MemoryPinner(), input);
    const b = await publishBadge(new MemoryPinner(), input);
    expect(a.metadataUri).toBe(b.metadataUri);
  });

  it("skips the image pin when the artwork is already on IPFS", async () => {
    const pinner = new MemoryPinner();
    const alreadyPinnedUri = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    const result = await publishBadge(pinner, {
      image: { alreadyPinnedUri },
      metadata: input.metadata,
    });

    expect(result.imageUri).toBe(alreadyPinnedUri);
    expect(result.metadata.image).toBe(alreadyPinnedUri);
    expect(pinner.list().map((e) => e.kind)).toEqual(["json"]);
  });

  it("rejects an already-pinned image uri that is not ipfs://", async () => {
    await expect(
      publishBadge(new MemoryPinner(), {
        image: { alreadyPinnedUri: "https://cdn.example.com/badge.png" },
        metadata: input.metadata,
      }),
    ).rejects.toMatchObject({ code: "METADATA_INVALID" });
  });

  it("does not pin anything when the metadata would be invalid", async () => {
    const pinner = new MemoryPinner();
    await expect(
      publishBadge(pinner, { image: { alreadyPinnedUri: "ipfs://bafkcid" }, metadata: { ...input.metadata, name: "" } }),
    ).rejects.toBeInstanceOf(MetadataError);
    expect(pinner.size).toBe(0);
  });

  it("propagates a pinner failure untouched", async () => {
    const failing: IpfsPinner = {
      pinFile: () => Promise.reject(new XrplLayerError("PIN_FAILED", "Pinata is down")),
      pinJson: () => Promise.reject(new XrplLayerError("PIN_FAILED", "Pinata is down")),
    };
    await expect(publishBadge(failing, input)).rejects.toMatchObject({ code: "PIN_FAILED" });
  });

  describe("the 256-byte NFTokenMint URI cap", () => {
    /** A pinner whose CID carries a long appended path, the only way to blow the cap. */
    function longUriPinner(pathSuffix: string): IpfsPinner {
      const inner = new MemoryPinner();
      return {
        pinFile: (i) => inner.pinFile(i),
        pinJson: async (i) => {
          const pin = await inner.pinJson(i);
          const uri = `${pin.uri}/${pathSuffix}`;
          return { ...pin, uri } satisfies PinResult;
        },
      };
    }

    it("rejects a metadata URI over the cap, naming the byte length", async () => {
      const suffix = "deeply/".repeat(40) + "metadata.json";
      const error = await publishBadge(longUriPinner(suffix), input)
        .then(() => null)
        .catch((e: unknown) => e as XrplLayerError);

      expect(error).toBeInstanceOf(MetadataError);
      expect(error?.code).toBe("URI_TOO_LONG");
      const bytes = error?.details?.["bytes"] as number;
      expect(bytes).toBeGreaterThan(MAX_URI_BYTES);
      expect(error?.message).toContain(String(bytes));
      expect(error?.message).toContain(String(MAX_URI_BYTES));
      expect(error?.details?.["max"]).toBe(MAX_URI_BYTES);
    });

    it("allows a URI sitting exactly on the cap", async () => {
      const bare = (await new MemoryPinner().pinJson({ json: {}, name: "x" })).uri;
      // ipfs://<cid> plus a slash, padded to exactly MAX_URI_BYTES.
      const suffix = "a".repeat(MAX_URI_BYTES - bare.length - 1);
      const result = await publishBadge(longUriPinner(suffix), {
        image: { alreadyPinnedUri: "ipfs://bafkimage" },
        metadata: input.metadata,
      });
      expect(Buffer.byteLength(result.metadataUri, "utf8")).toBe(MAX_URI_BYTES);
    });

    it("leaves a plain ipfs://<cid> far under the cap", async () => {
      const result = await publishBadge(new MemoryPinner(), input);
      expect(Buffer.byteLength(result.metadataUri, "utf8")).toBeLessThan(80);
    });
  });
});
