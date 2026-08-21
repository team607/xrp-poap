import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetadataError, XrplLayerError } from "../errors.js";
import { MAX_URI_BYTES, type BadgeMetadata, type IpfsPinner, type PinResult } from "../types.js";
import { MemoryPinner } from "./memory-pinner.js";
import {
  PinningBadgeUriResolver,
  StaticBadgeUriResolver,
  TRAIT_ART_DENSITY,
  TRAIT_ART_PALETTE,
  TRAIT_ATTENDEE,
  artLabel,
  badgeManifestPath,
  emptyBadgeManifest,
  loadBadgeManifest,
  saveBadgeManifest,
  type BadgeManifest,
} from "./badge-uri-resolver.js";
import { TRAIT_EVENT_ID, TRAIT_EVENT_NAME } from "./schema.js";

const EVENT = 900_001;
const ALICE = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const BOB = "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w";
const CAROL = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";

/**
 * MemoryPinner with a call counter and an optional stall, so a test can prove
 * that two simultaneous claims produced ONE pin rather than two identical ones.
 */
class CountingPinner implements IpfsPinner {
  files = 0;
  jsons = 0;
  readonly inner = new MemoryPinner();
  /** Resolves after a macrotask when set, widening the concurrency window. */
  stall = false;
  /** When set, the next N pinFile calls reject. */
  failFileCalls = 0;

  get calls(): number {
    return this.files + this.jsons;
  }

  async pinFile(input: Parameters<IpfsPinner["pinFile"]>[0]): Promise<PinResult> {
    this.files += 1;
    await this.pause();
    if (this.failFileCalls > 0) {
      this.failFileCalls -= 1;
      throw new XrplLayerError("PIN_FAILED", "Pinata said 503");
    }
    return this.inner.pinFile(input);
  }

  async pinJson(input: Parameters<IpfsPinner["pinJson"]>[0]): Promise<PinResult> {
    this.jsons += 1;
    await this.pause();
    return this.inner.pinJson(input);
  }

  private async pause(): Promise<void> {
    if (this.stall) await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function jsonAt(pinner: CountingPinner, uri: string): BadgeMetadata {
  return pinner.inner.getByUri(uri)?.json as BadgeMetadata;
}

function svgAt(pinner: CountingPinner, uri: string): string {
  return new TextDecoder().decode(pinner.inner.getByUri(uri)?.data);
}

let dir: string;
let manifestPath: string;
let warnings: string[];
const onWarn = (message: string): void => {
  warnings.push(message);
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "poap-badge-manifest-"));
  manifestPath = join(dir, "badge-manifest.json");
  warnings = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("badgeManifestPath", () => {
  it("is the one place the script and the API agree on", () => {
    expect(badgeManifestPath(EVENT)).toBe(join("out", `badge-manifest-${EVENT}.json`));
    expect(badgeManifestPath(EVENT, "/srv/data")).toBe(`/srv/data/badge-manifest-${EVENT}.json`);
  });
});

describe("loadBadgeManifest / saveBadgeManifest", () => {
  it("round-trips a manifest", async () => {
    const manifest = emptyBadgeManifest(EVENT);
    manifest.entries[ALICE] = {
      metadataUri: "ipfs://bafkmeta",
      imageUri: "ipfs://bafkimage",
      pinnedAt: "2026-08-21T00:00:00.000Z",
    };
    await saveBadgeManifest(manifestPath, manifest);
    await expect(loadBadgeManifest(manifestPath, { eventId: EVENT, onWarn })).resolves.toEqual(
      manifest,
    );
    expect(warnings).toEqual([]);
  });

  it("creates the directory and leaves no temp file behind", async () => {
    const nested = join(dir, "deep", "badge-manifest.json");
    await saveBadgeManifest(nested, emptyBadgeManifest(EVENT));
    expect(await readdir(join(dir, "deep"))).toEqual(["badge-manifest.json"]);
  });

  it("treats a missing file as empty, without complaining", async () => {
    const manifest = await loadBadgeManifest(join(dir, "nope.json"), { eventId: EVENT, onWarn });
    expect(manifest.entries).toEqual({});
    expect(manifest.eventId).toBe(EVENT);
    expect(warnings).toEqual([]);
  });

  it("treats a corrupt file as empty rather than throwing", async () => {
    // Exactly what a crash mid-write used to leave behind.
    await writeFile(manifestPath, '{"eventId":900001,"entries":{"rHb9CJ', "utf8");
    const manifest = await loadBadgeManifest(manifestPath, { eventId: EVENT, onWarn });
    expect(manifest.entries).toEqual({});
    expect(warnings.join(" ")).toContain("not valid JSON");
  });

  it("refuses to reuse another event's manifest", async () => {
    const other = emptyBadgeManifest(900_999);
    other.entries[ALICE] = { metadataUri: "ipfs://wrong", imageUri: "ipfs://wrong", pinnedAt: "" };
    await saveBadgeManifest(manifestPath, other);

    const manifest = await loadBadgeManifest(manifestPath, { eventId: EVENT, onWarn });
    expect(manifest.entries).toEqual({});
    expect(warnings.join(" ")).toContain("belongs to event 900999");
  });

  it("drops malformed entries and keeps the rest", async () => {
    await writeFile(
      manifestPath,
      JSON.stringify({
        eventId: EVENT,
        createdAt: "2026-08-21T00:00:00.000Z",
        entries: {
          [ALICE]: { metadataUri: "ipfs://good", imageUri: "ipfs://img", pinnedAt: "x" },
          [BOB]: { imageUri: "ipfs://img" },
          [CAROL]: null,
        },
      }),
      "utf8",
    );
    const manifest = await loadBadgeManifest(manifestPath, { eventId: EVENT, onWarn });
    expect(Object.keys(manifest.entries)).toEqual([ALICE]);
    expect(warnings.join(" ")).toContain("dropped 2 malformed entries");
  });

  it("treats a JSON document that is not a manifest as empty", async () => {
    await writeFile(manifestPath, "[1,2,3]", "utf8");
    await expect(
      loadBadgeManifest(manifestPath, { eventId: EVENT, onWarn }),
    ).resolves.toMatchObject({ entries: {} });
    expect(warnings.join(" ")).toContain("not a badge manifest");
  });

  it("reports a write it could not make, with a typed error", async () => {
    // A directory where the file should be: rename cannot replace it.
    await expect(saveBadgeManifest(dir, emptyBadgeManifest(EVENT))).rejects.toBeInstanceOf(
      MetadataError,
    );
  });
});

describe("PinningBadgeUriResolver", () => {
  function resolver(
    pinner: IpfsPinner,
    options: Partial<ConstructorParameters<typeof PinningBadgeUriResolver>[0]> = {},
  ): PinningBadgeUriResolver {
    return new PinningBadgeUriResolver({ pinner, manifestPath, onWarn, ...options });
  }

  describe("the pre-pinned path", () => {
    it("returns a manifest hit without touching the pinner", async () => {
      const manifest = emptyBadgeManifest(EVENT);
      manifest.entries[ALICE] = {
        metadataUri: "ipfs://bafkmeta",
        imageUri: "ipfs://bafkimage",
        pinnedAt: "2026-08-20T09:00:00.000Z",
      };
      await saveBadgeManifest(manifestPath, manifest);

      const pinner = new CountingPinner();
      const uri = await resolver(pinner).resolve({ eventId: EVENT, address: ALICE });

      expect(uri).toEqual({
        metadataUri: "ipfs://bafkmeta",
        imageUri: "ipfs://bafkimage",
        pinnedOnDemand: false,
      });
      expect(pinner.calls).toBe(0);
    });

    it("reads the manifest once for a burst of first claims", async () => {
      const manifest = emptyBadgeManifest(EVENT);
      for (const address of [ALICE, BOB, CAROL]) {
        manifest.entries[address] = { metadataUri: `ipfs://m-${address}`, imageUri: "ipfs://i", pinnedAt: "" };
      }
      await saveBadgeManifest(manifestPath, manifest);

      const pinner = new CountingPinner();
      const r = resolver(pinner);
      const results = await Promise.all(
        [ALICE, BOB, CAROL].map((address) => r.resolve({ eventId: EVENT, address })),
      );
      expect(results.map((x) => x.metadataUri)).toEqual([
        `ipfs://m-${ALICE}`,
        `ipfs://m-${BOB}`,
        `ipfs://m-${CAROL}`,
      ]);
      expect(pinner.calls).toBe(0);
    });
  });

  describe("the walk-up path", () => {
    it("pins on demand and writes the entry back", async () => {
      const pinner = new CountingPinner();
      const r = resolver(pinner);
      const uri = await r.resolve({ eventId: EVENT, address: ALICE });

      expect(uri.pinnedOnDemand).toBe(true);
      expect(uri.metadataUri).toMatch(/^ipfs:\/\//);
      expect(uri.imageUri).toMatch(/^ipfs:\/\//);
      expect(uri.metadataUri).not.toBe(uri.imageUri);
      expect(pinner.files).toBe(1);
      expect(pinner.jsons).toBe(1);

      const onDisk = JSON.parse(await readFile(manifestPath, "utf8")) as BadgeManifest;
      expect(onDisk.eventId).toBe(EVENT);
      expect(onDisk.entries[ALICE]).toMatchObject({
        metadataUri: uri.metadataUri,
        imageUri: uri.imageUri,
      });
      expect(Date.parse(onDisk.entries[ALICE]?.pinnedAt ?? "")).not.toBeNaN();
    });

    it("is a hit the second time, in the same process", async () => {
      const pinner = new CountingPinner();
      const r = resolver(pinner);
      const first = await r.resolve({ eventId: EVENT, address: ALICE });
      const second = await r.resolve({ eventId: EVENT, address: ALICE });

      expect(second).toEqual({ ...first, pinnedOnDemand: false });
      expect(pinner.calls).toBe(2); // one file + one json, from the first call
    });

    it("is a hit after a restart, because the manifest is on disk", async () => {
      const first = await resolver(new CountingPinner()).resolve({ eventId: EVENT, address: ALICE });

      const rebooted = new CountingPinner();
      const second = await resolver(rebooted).resolve({ eventId: EVENT, address: ALICE });

      expect(second.metadataUri).toBe(first.metadataUri);
      expect(second.pinnedOnDemand).toBe(false);
      expect(rebooted.calls).toBe(0);
    });

    it("pins each attendee separately", async () => {
      const pinner = new CountingPinner();
      const r = resolver(pinner);
      const [a, b] = await Promise.all([
        r.resolve({ eventId: EVENT, address: ALICE }),
        r.resolve({ eventId: EVENT, address: BOB }),
      ]);
      expect(a?.metadataUri).not.toBe(b?.metadataUri);
      expect(pinner.files).toBe(2);

      const onDisk = JSON.parse(await readFile(manifestPath, "utf8")) as BadgeManifest;
      expect(Object.keys(onDisk.entries).sort()).toEqual([ALICE, BOB].sort());
    });

    it("re-pins after a corrupt manifest rather than refusing to start", async () => {
      await writeFile(manifestPath, "{ this is not json", "utf8");
      const pinner = new CountingPinner();
      const uri = await resolver(pinner).resolve({ eventId: EVENT, address: ALICE });

      expect(uri.pinnedOnDemand).toBe(true);
      expect(warnings.join(" ")).toContain("not valid JSON");
      // And the corrupt file is replaced by a usable one.
      const onDisk = JSON.parse(await readFile(manifestPath, "utf8")) as BadgeManifest;
      expect(onDisk.entries[ALICE]?.metadataUri).toBe(uri.metadataUri);
    });

    it("keeps serving badges when the manifest cannot be written", async () => {
      // manifestPath is a directory: every write fails, every claim still works.
      const r = new PinningBadgeUriResolver({ pinner: new CountingPinner(), manifestPath: dir, onWarn });
      const uri = await r.resolve({ eventId: EVENT, address: ALICE });
      await r.flush();
      expect(uri.pinnedOnDemand).toBe(true);
      expect(warnings.join(" ")).toContain("the badge is pinned and usable");
    });

    it("does not persist a dry run", async () => {
      const pinner = new CountingPinner();
      const uri = await resolver(pinner, { persist: false }).resolve({
        eventId: EVENT,
        address: ALICE,
      });
      expect(uri.pinnedOnDemand).toBe(true);
      expect(await readdir(dir)).toEqual([]);
    });

    it("reports each pin exactly once through onPin", async () => {
      const onPin = vi.fn();
      const r = resolver(new CountingPinner(), { onPin });
      await r.resolve({ eventId: EVENT, address: ALICE });
      await r.resolve({ eventId: EVENT, address: ALICE });
      await r.resolve({ eventId: EVENT, address: BOB });

      expect(onPin).toHaveBeenCalledTimes(2);
      expect(onPin.mock.calls[0]?.[0]).toBe(ALICE);
      expect(onPin.mock.calls[1]?.[0]).toBe(BOB);
    });
  });

  describe("concurrency", () => {
    it("collapses simultaneous claims for one attendee into a single pin", async () => {
      const pinner = new CountingPinner();
      pinner.stall = true;
      const r = resolver(pinner);

      const results = await Promise.all([
        r.resolve({ eventId: EVENT, address: ALICE }),
        r.resolve({ eventId: EVENT, address: ALICE }),
        r.resolve({ eventId: EVENT, address: ALICE }),
      ]);

      expect(pinner.files).toBe(1);
      expect(pinner.jsons).toBe(1);
      expect(new Set(results.map((x) => x.metadataUri)).size).toBe(1);
      expect(results.every((x) => x.pinnedOnDemand)).toBe(true);
    });

    it("collapses a claim that arrives while the first is still in flight", async () => {
      const pinner = new CountingPinner();
      pinner.stall = true;
      const r = resolver(pinner);

      const first = r.resolve({ eventId: EVENT, address: ALICE });
      await new Promise((resolve) => setTimeout(resolve, 1)); // mid-pin
      const second = r.resolve({ eventId: EVENT, address: ALICE });

      expect(await second).toEqual(await first);
      expect(pinner.files).toBe(1);
    });

    it("still pins different attendees concurrently", async () => {
      const pinner = new CountingPinner();
      pinner.stall = true;
      const r = resolver(pinner);
      const results = await Promise.all(
        [ALICE, BOB, CAROL].map((address) => r.resolve({ eventId: EVENT, address })),
      );
      expect(pinner.files).toBe(3);
      expect(new Set(results.map((x) => x.metadataUri)).size).toBe(3);

      // Every concurrent write landed: none was clobbered by a stale snapshot.
      await r.flush();
      const onDisk = JSON.parse(await readFile(manifestPath, "utf8")) as BadgeManifest;
      expect(Object.keys(onDisk.entries).sort()).toEqual([ALICE, BOB, CAROL].sort());
    });

    it("lets a failed pin be retried instead of caching the failure", async () => {
      const pinner = new CountingPinner();
      pinner.failFileCalls = 1;
      const r = resolver(pinner);

      await expect(r.resolve({ eventId: EVENT, address: ALICE })).rejects.toMatchObject({
        code: "PIN_FAILED",
      });
      const uri = await r.resolve({ eventId: EVENT, address: ALICE });
      expect(uri.pinnedOnDemand).toBe(true);
      expect(pinner.files).toBe(2);
    });
  });

  describe("what gets pinned", () => {
    it("pins the SVG as image/svg+xml and points the metadata at it", async () => {
      const pinner = new CountingPinner();
      const uri = await resolver(pinner, { eventName: "Feooh 2026" }).resolve({
        eventId: EVENT,
        address: ALICE,
      });

      const image = pinner.inner.getByUri(uri.imageUri);
      expect(image?.contentType).toBe("image/svg+xml");
      expect(image?.filename).toBe(`badge-${EVENT}-${ALICE}.svg`);
      expect(svgAt(pinner, uri.imageUri)).toContain("<svg ");
      expect(svgAt(pinner, uri.imageUri)).toContain("FEOOH 2026");

      const metadata = jsonAt(pinner, uri.metadataUri);
      expect(metadata.image).toBe(uri.imageUri);
      expect(metadata.nftType).toBe("art.v0");
      expect(metadata.name).toContain("Feooh 2026");
      expect(metadata.description).toContain(ALICE);
    });

    it("describes the artwork with its traits, not just a link to it", async () => {
      const pinner = new CountingPinner();
      const uri = await resolver(pinner, { eventName: "Feooh 2026" }).resolve({
        eventId: EVENT,
        address: ALICE,
      });
      const traits = Object.fromEntries(
        jsonAt(pinner, uri.metadataUri).attributes.map((a) => [a.trait_type, a.value]),
      );
      expect(traits[TRAIT_EVENT_ID]).toBe(EVENT);
      expect(traits[TRAIT_EVENT_NAME]).toBe("Feooh 2026");
      expect(traits[TRAIT_ATTENDEE]).toBe(ALICE);
      // Matches renderBadgeArt's pinned traits for this address and event.
      expect(traits[TRAIT_ART_PALETTE]).toBe("jade");
      expect(traits[TRAIT_ART_DENSITY]).toBe(51);
    });

    it("keeps the metadata URI inside NFTokenMint's 256-byte cap", async () => {
      const pinner = new CountingPinner();
      const uri = await resolver(pinner).resolve({ eventId: EVENT, address: ALICE });
      expect(Buffer.byteLength(uri.metadataUri, "utf8")).toBeLessThanOrEqual(MAX_URI_BYTES);
      expect(Buffer.byteLength(uri.metadataUri, "utf8")).toBeLessThan(80);
    });

    it("strips XML metacharacters from an event name before it reaches the SVG", async () => {
      const pinner = new CountingPinner();
      const uri = await resolver(pinner, { eventName: 'Rock & <Roll> "26"' }).resolve({
        eventId: EVENT,
        address: ALICE,
      });
      const svg = svgAt(pinner, uri.imageUri);
      expect(svg).not.toMatch(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/);
      expect(svg).toContain("ROCK ROLL 26");
      // The unmodified name still describes the badge in the metadata.
      const metadata = jsonAt(pinner, uri.metadataUri);
      expect(metadata.attributes).toContainEqual({
        trait_type: TRAIT_EVENT_NAME,
        value: 'Rock & <Roll> "26"',
      });
    });

    it("falls back to the event id when a name is nothing but metacharacters", async () => {
      const pinner = new CountingPinner();
      const uri = await resolver(pinner, { eventName: "<<&&>>" }).resolve({
        eventId: EVENT,
        address: ALICE,
      });
      // Captionless would be worse than the default caption.
      expect(svgAt(pinner, uri.imageUri)).toContain(`EVENT ${EVENT}`);
    });
  });

  describe("input guards", () => {
    it("refuses an address that is not a classic address", async () => {
      const pinner = new CountingPinner();
      await expect(
        resolver(pinner).resolve({ eventId: EVENT, address: "not-an-address" }),
      ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
      expect(pinner.calls).toBe(0);
    });

    it("refuses a taxon outside the protocol range", async () => {
      await expect(
        resolver(new CountingPinner()).resolve({ eventId: 2_147_483_648, address: ALICE }),
      ).rejects.toMatchObject({ code: "INVALID_TAXON" });
    });
  });

  it("names the file it will read for an event", () => {
    expect(resolver(new CountingPinner()).manifestPathFor(EVENT)).toBe(manifestPath);
    expect(
      new PinningBadgeUriResolver({ pinner: new CountingPinner() }).manifestPathFor(EVENT),
    ).toBe(badgeManifestPath(EVENT));
  });

  it("counts what the roster already covers", async () => {
    const manifest = emptyBadgeManifest(EVENT);
    manifest.entries[ALICE] = { metadataUri: "ipfs://m", imageUri: "ipfs://i", pinnedAt: "" };
    await saveBadgeManifest(manifestPath, manifest);
    await expect(resolver(new CountingPinner()).entryCount(EVENT)).resolves.toBe(1);
  });
});

describe("artLabel", () => {
  it("removes what would break the SVG and leaves the rest alone", () => {
    expect(artLabel("Feooh 2026")).toBe("Feooh 2026");
    expect(artLabel('Rock & <Roll> "26"')).toBe("Rock Roll 26");
    expect(artLabel("  spaced   out  ")).toBe("spaced out");
  });

  it("trims on a code point boundary so a slice cannot split a character", () => {
    const label = artLabel("🎟🎟🎟🎟🎟🎟🎟🎟🎟🎟🎟🎟🎟🎟🎟");
    expect(label.length).toBeLessThanOrEqual(22);
    expect([...label].every((ch) => ch === "🎟")).toBe(true);
    // A trailing HIGH surrogate would be half a character — invalid XML.
    expect(label).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe("StaticBadgeUriResolver", () => {
  it("returns one fixed URI for every attendee", async () => {
    const r = new StaticBadgeUriResolver("ipfs://bafkoneforall");
    const a = await r.resolve({ eventId: EVENT, address: ALICE });
    const b = await r.resolve({ eventId: EVENT, address: BOB });
    expect(a).toEqual({ metadataUri: "ipfs://bafkoneforall", imageUri: "", pinnedOnDemand: false });
    expect(b).toEqual(a);
  });

  it("carries the image URI when the caller knows it", async () => {
    const r = new StaticBadgeUriResolver({ metadataUri: "ipfs://meta", imageUri: "ipfs://img" });
    await expect(r.resolve({ eventId: EVENT, address: ALICE })).resolves.toMatchObject({
      imageUri: "ipfs://img",
    });
  });

  it("refuses to stand in for a URI that was never configured", () => {
    expect(() => new StaticBadgeUriResolver("")).toThrow(MetadataError);
    expect(() => new StaticBadgeUriResolver("   ")).toThrow(/EVENT_METADATA_URI/);
  });

  it("refuses a URI the mint field cannot carry", () => {
    expect(() => new StaticBadgeUriResolver(`ipfs://${"a".repeat(MAX_URI_BYTES)}`)).toThrow(
      /256/,
    );
  });
});
