import { describe, expect, it } from "vitest";
import { MetadataError, XrplLayerError } from "../errors.js";
import { MAX_TAXON } from "../types.js";
import {
  BADGE_NFT_TYPE,
  TRAIT_EVENT_DATE,
  TRAIT_EVENT_ID,
  TRAIT_EVENT_NAME,
  TRAIT_VENUE,
  XLS24D_SCHEMA_URI,
  assertValidBadgeMetadata,
  buildBadgeMetadata,
  isValidBadgeMetadata,
  type BuildBadgeMetadataInput,
} from "./schema.js";

const base: BuildBadgeMetadataInput = {
  name: "Feooh Meetup Badge",
  description: "Proof of attendance for the Feooh launch meetup.",
  imageUri: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  eventId: 4242,
};

function attrValue(attributes: { trait_type: string; value: string | number }[], trait: string) {
  return attributes.find((a) => a.trait_type === trait)?.value;
}

describe("buildBadgeMetadata", () => {
  it("produces a document that validates against the schema", () => {
    const metadata = buildBadgeMetadata(base);
    expect(() => assertValidBadgeMetadata(metadata)).not.toThrow();
    expect(assertValidBadgeMetadata(metadata)).toEqual(metadata);
    expect(isValidBadgeMetadata(metadata)).toBe(true);
  });

  it("pins the XLS-24d schema CID and nftType", () => {
    const metadata = buildBadgeMetadata(base);
    expect(metadata.schema).toBe(XLS24D_SCHEMA_URI);
    expect(metadata.schema.startsWith("ipfs://")).toBe(true);
    expect(metadata.nftType).toBe(BADGE_NFT_TYPE);
    expect(metadata.nftType).toBe("art.v0");
  });

  it("always carries the event id (the taxon) as an attribute", () => {
    const metadata = buildBadgeMetadata(base);
    expect(attrValue(metadata.attributes, TRAIT_EVENT_ID)).toBe(4242);
    // Self-describing: the taxon is recoverable from the JSON alone.
    expect(metadata.attributes[0]).toEqual({ trait_type: TRAIT_EVENT_ID, value: 4242 });
  });

  it("keeps the event id attribute even for event 0", () => {
    const metadata = buildBadgeMetadata({ ...base, eventId: 0 });
    expect(attrValue(metadata.attributes, TRAIT_EVENT_ID)).toBe(0);
  });

  it("adds only the optional attributes that were supplied", () => {
    const metadata = buildBadgeMetadata({ ...base, eventName: "Launch Night", venue: "Berlin" });
    expect(attrValue(metadata.attributes, TRAIT_EVENT_NAME)).toBe("Launch Night");
    expect(attrValue(metadata.attributes, TRAIT_VENUE)).toBe("Berlin");
    expect(attrValue(metadata.attributes, TRAIT_EVENT_DATE)).toBeUndefined();
    expect(metadata.attributes).toHaveLength(3);
  });

  it("appends extraAttributes after the derived ones", () => {
    const metadata = buildBadgeMetadata({
      ...base,
      eventDate: "2026-08-20",
      extraAttributes: [{ trait_type: "tier", value: "speaker" }],
    });
    expect(metadata.attributes.map((a) => a.trait_type)).toEqual([
      TRAIT_EVENT_ID,
      TRAIT_EVENT_DATE,
      "tier",
    ]);
    expect(() => assertValidBadgeMetadata(metadata)).not.toThrow();
  });

  it("passes collection through and omits it when absent", () => {
    expect(buildBadgeMetadata(base).collection).toBeUndefined();
    const withCollection = buildBadgeMetadata({
      ...base,
      collection: { name: "Feooh POAP", family: "Feooh" },
    });
    expect(withCollection.collection).toEqual({ name: "Feooh POAP", family: "Feooh" });
    expect(() => assertValidBadgeMetadata(withCollection)).not.toThrow();
  });

  it("rejects an event id that is not a usable taxon", () => {
    for (const eventId of [-1, 1.5, MAX_TAXON + 1, Number.NaN]) {
      expect(() => buildBadgeMetadata({ ...base, eventId })).toThrow(MetadataError);
    }
    expect(() => buildBadgeMetadata({ ...base, eventId: MAX_TAXON })).not.toThrow();
  });
});

describe("assertValidBadgeMetadata", () => {
  it("rejects a non-ipfs image uri", () => {
    const metadata = buildBadgeMetadata({ ...base, imageUri: "https://cdn.example.com/badge.png" });
    expect(() => assertValidBadgeMetadata(metadata)).toThrow(MetadataError);
    expect(isValidBadgeMetadata(metadata)).toBe(false);

    try {
      assertValidBadgeMetadata(metadata);
      expect.unreachable("should have thrown");
    } catch (err) {
      const error = err as XrplLayerError;
      expect(error).toBeInstanceOf(XrplLayerError);
      expect(error.code).toBe("METADATA_INVALID");
      const issues = error.details?.["issues"] as { path: string; message: string }[];
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe("image");
      expect(issues[0]?.message).toMatch(/ipfs/i);
      // Details must survive a round trip: they get logged by the caller.
      expect(JSON.parse(JSON.stringify(error.details))).toEqual({ issues });
    }
  });

  it("rejects an http image uri that merely contains ipfs", () => {
    const metadata = buildBadgeMetadata({
      ...base,
      imageUri: "https://gateway.pinata.cloud/ipfs/bafyfake",
    });
    expect(() => assertValidBadgeMetadata(metadata)).toThrow(/ipfs/i);
  });

  it("reports every issue at once", () => {
    try {
      assertValidBadgeMetadata({ schema: "", nftType: "art.v1", name: "", image: "x" });
      expect.unreachable("should have thrown");
    } catch (err) {
      const issues = (err as XrplLayerError).details?.["issues"] as { path: string }[];
      expect(issues.map((i) => i.path).sort()).toEqual([
        "attributes",
        "description",
        "image",
        "name",
        "nftType",
        "schema",
      ]);
    }
  });

  it("rejects non-objects and the wrong nftType", () => {
    expect(() => assertValidBadgeMetadata(null)).toThrow(MetadataError);
    expect(() => assertValidBadgeMetadata("ipfs://nope")).toThrow(MetadataError);
    expect(() =>
      assertValidBadgeMetadata({ ...buildBadgeMetadata(base), nftType: "art.v1" }),
    ).toThrow(MetadataError);
  });

  it("rejects a malformed attribute", () => {
    const metadata = {
      ...buildBadgeMetadata(base),
      attributes: [{ trait_type: "tier", value: { nested: true } }],
    };
    expect(() => assertValidBadgeMetadata(metadata)).toThrow(MetadataError);
  });

  it("keeps unknown top-level keys, since XLS-24d allows them", () => {
    const parsed = assertValidBadgeMetadata({
      ...buildBadgeMetadata(base),
      external_url: "https://feooh.example",
    });
    expect((parsed as unknown as Record<string, unknown>)["external_url"]).toBe(
      "https://feooh.example",
    );
  });
});
