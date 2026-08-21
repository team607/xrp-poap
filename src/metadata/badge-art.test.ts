import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderBadgeArt } from "./badge-art.js";

/**
 * The artwork is minted into an immutable URI, so two properties matter more
 * than anything the image looks like:
 *
 *   1. It is a pure function of (address, eventId). Regenerating a badge years
 *      later has to produce the same bytes, or the "visual fingerprint" claim
 *      in the module header is false.
 *   2. It is well-formed XML. A stray `&` makes the document unparseable, and
 *      by the time anyone notices, the CID is on a ledger that cannot be
 *      edited.
 */

const ADDRESS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const OTHER_ADDRESS = "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w";
const EVENT = 900_001;

// ---------------------------------------------------------------------------
// A small XML well-formedness check. No parser is available offline, and the
// interesting failure (an unescaped character from an address or a label) is
// exactly what a stack-based tag walk catches.
// ---------------------------------------------------------------------------

const TAG = /<(\/?)([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/** `&` that is not the start of a character or named entity. */
const BARE_AMPERSAND = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;

interface ParsedSvg {
  /** Elements opened at depth zero. Well-formed XML has exactly one. */
  rootCount: number;
  rootName?: string;
  /** Tags still open at the end of the document. */
  unclosed: string[];
  /** First close tag that did not match the open tag it closed. */
  mismatch?: string;
  /** Everything between tags, i.e. the text nodes. */
  text: string;
}

function parseSvg(svg: string): ParsedSvg {
  const re = new RegExp(TAG.source, "g");
  const stack: string[] = [];
  const chunks: string[] = [];
  let rootCount = 0;
  let rootName: string | undefined;
  let mismatch: string | undefined;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(svg)) !== null) {
    chunks.push(svg.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const name = match[2] as string;
    if (match[1] === "/") {
      const open = stack.pop();
      if (open !== name && mismatch === undefined) {
        mismatch = `</${name}> closes <${open ?? "nothing"}>`;
      }
      continue;
    }
    if (stack.length === 0) {
      rootCount += 1;
      rootName ??= name;
    }
    if (match[4] !== "/") stack.push(name);
  }
  chunks.push(svg.slice(cursor));

  return {
    rootCount,
    ...(rootName === undefined ? {} : { rootName }),
    unclosed: stack,
    ...(mismatch === undefined ? {} : { mismatch }),
    text: chunks.join(""),
  };
}

function expectWellFormed(svg: string): void {
  const parsed = parseSvg(svg);
  expect(parsed.mismatch).toBeUndefined();
  expect(parsed.unclosed).toEqual([]);
  expect(parsed.rootCount).toBe(1);
  expect(parsed.rootName).toBe("svg");
  // Nothing between tags may contain a raw `<`, and no `&` anywhere may be
  // left dangling. Both are the shapes an unescaped label produces.
  expect(parsed.text).not.toContain("<");
  expect(svg).not.toMatch(BARE_AMPERSAND);
  expect(svg.trimStart().startsWith("<svg ")).toBe(true);
  expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
}

/** Deterministic base58-shaped stand-ins, for sweeping the parameter space. */
const BASE58 = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
function pseudoAddress(seed: string, length = 34): string {
  const bytes = createHash("sha256").update(seed).digest();
  let out = "r";
  for (let i = 0; out.length < length; i += 1) {
    out += BASE58[(bytes[i % bytes.length] as number) % BASE58.length];
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("renderBadgeArt", () => {
  describe("determinism", () => {
    it("gives byte-identical SVG for the same address and event", () => {
      const a = renderBadgeArt({ address: ADDRESS, eventId: EVENT });
      const b = renderBadgeArt({ address: ADDRESS, eventId: EVENT });
      expect(a.svg).toBe(b.svg);
      expect(a.traits).toEqual(b.traits);
      expect(Buffer.from(a.svg).equals(Buffer.from(b.svg))).toBe(true);
    });

    it("gives the same attendee different art at a different event", () => {
      const a = renderBadgeArt({ address: ADDRESS, eventId: EVENT });
      const b = renderBadgeArt({ address: ADDRESS, eventId: EVENT + 1 });
      expect(a.svg).not.toBe(b.svg);
      expect(a.traits).not.toEqual(b.traits);
    });

    it("gives two attendees at the same event different art", () => {
      const a = renderBadgeArt({ address: ADDRESS, eventId: EVENT });
      const b = renderBadgeArt({ address: OTHER_ADDRESS, eventId: EVENT });
      expect(a.svg).not.toBe(b.svg);
    });

    it("is unaffected by anything outside (address, eventId) except the label", () => {
      const bare = renderBadgeArt({ address: ADDRESS, eventId: EVENT });
      const named = renderBadgeArt({ address: ADDRESS, eventId: EVENT, eventName: "Feooh 2026" });
      // Same geometry, different caption: the only difference is the label.
      expect(named.traits).toEqual(bare.traits);
      expect(named.svg).toContain("FEOOH 2026");
      expect(bare.svg).toContain(`EVENT ${EVENT}`);
      expect(named.svg.replace("FEOOH 2026", `EVENT ${EVENT}`)).toBe(bare.svg);
    });
  });

  describe("traits", () => {
    /**
     * Pinned values, not a range check. The traits are written into the badge
     * metadata, so a change to the entropy consumption order would silently
     * make every already-minted badge's JSON describe a different image.
     */
    it("are stable for a fixed address and event", () => {
      expect(renderBadgeArt({ address: ADDRESS, eventId: EVENT }).traits).toEqual({
        palette: "jade",
        core: 5,
        traces: 5,
        density: 51,
      });
      expect(renderBadgeArt({ address: ADDRESS, eventId: 900_002 }).traits).toEqual({
        palette: "azure",
        core: 12,
        traces: 9,
        density: 70,
      });
      expect(renderBadgeArt({ address: OTHER_ADDRESS, eventId: EVENT }).traits).toEqual({
        palette: "cyan",
        core: 5,
        traces: 8,
        density: 60,
      });
    });

    it("stay inside their documented ranges across the address space", () => {
      const palettes = new Set<string>();
      for (let i = 0; i < 60; i += 1) {
        const { traits } = renderBadgeArt({ address: pseudoAddress(`sweep-${i}`), eventId: EVENT });
        palettes.add(traits.palette);
        expect([5, 6, 8, 12]).toContain(traits.core);
        expect(traits.traces).toBeGreaterThanOrEqual(5);
        expect(traits.traces).toBeLessThanOrEqual(9);
        expect(traits.density).toBeGreaterThanOrEqual(48);
        expect(traits.density).toBeLessThanOrEqual(72);
      }
      // A palette that never varies would make the whole set look identical.
      expect(palettes.size).toBeGreaterThan(3);
    });

    it("describes the image that was drawn", () => {
      const art = renderBadgeArt({ address: ADDRESS, eventId: EVENT });
      // density ticks are the only <line> elements in the document.
      expect(art.svg.match(/<line /g) ?? []).toHaveLength(art.traits.density);
      // One via circle plus one node rect per trace.
      expect(art.svg.match(/<rect x=/g) ?? []).toHaveLength(art.traits.traces);
    });
  });

  describe("output shape", () => {
    it("is a single well-formed SVG root", () => {
      expectWellFormed(renderBadgeArt({ address: ADDRESS, eventId: EVENT }).svg);
    });

    it("stays well-formed across the address space", () => {
      for (let i = 0; i < 25; i += 1) {
        expectWellFormed(renderBadgeArt({ address: pseudoAddress(`shape-${i}`), eventId: EVENT }).svg);
      }
    });

    it("puts nothing unescaped in the document from a classic address", () => {
      const art = renderBadgeArt({ address: ADDRESS, eventId: EVENT });
      // Classic addresses are base58: no &, <, >, " or ' can reach the SVG.
      expect(ADDRESS).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
      expect(art.svg).not.toMatch(BARE_AMPERSAND);
      expect(art.svg).toContain(`${ADDRESS.slice(0, 6)}…${ADDRESS.slice(-6)}`);
      expect(art.svg).toContain(`aria-label="Attendance badge for ${ADDRESS.slice(0, 6)}…`);
    });

    it("renders both ends of the classic-address length range", () => {
      // Classic addresses run 25 to 35 characters. Both ends have to draw.
      for (const length of [25, 35]) {
        const address = pseudoAddress(`len-${length}`, length);
        expect(address).toHaveLength(length);
        const art = renderBadgeArt({ address, eventId: EVENT });
        expectWellFormed(art.svg);
        expect(art.svg).toContain(`${address.slice(0, 6)}…${address.slice(-6)}`);
      }
    });

    it("carries the event id where a human can read it", () => {
      const art = renderBadgeArt({ address: ADDRESS, eventId: EVENT });
      expect(art.svg).toContain(`TAXON ${EVENT}`);
      expect(art.svg).toContain("SOULBOUND");
      expect(art.svg).toContain('viewBox="0 0 512 512"');
    });

    it("stays small enough to pin per attendee", () => {
      const bytes = Buffer.byteLength(renderBadgeArt({ address: ADDRESS, eventId: EVENT }).svg);
      expect(bytes).toBeGreaterThan(1_000);
      expect(bytes).toBeLessThan(64_000);
    });
  });

  it("escapes XML metacharacters in an operator-supplied event name", () => {
    // "Rock & Roll" would otherwise emit a bare & and produce a document no
    // XML parser accepts — pinned to IPFS and named by an immutable URI, so
    // the broken artwork could never be corrected.
    const { svg } = renderBadgeArt({
      address: ADDRESS,
      eventId: EVENT,
      eventName: `Rock & Roll <script> "q" 'p'`,
    });

    expect(svg).toContain("&amp;");
    // No bare ampersand anywhere: every & must open a real entity.
    expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#)/);
    // The angle brackets from the name must not have become markup.
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;SCRIPT&gt;");
    // Tag count is unchanged from a benign name, i.e. nothing was injected.
    const benign = renderBadgeArt({ address: ADDRESS, eventId: EVENT, eventName: "SAFE" }).svg;
    expect((svg.match(/</g) ?? []).length).toBe((benign.match(/</g) ?? []).length);
  });
});
