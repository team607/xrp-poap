/**
 * Deterministic badge artwork.
 *
 * The image is a pure function of (address, eventId): the same attendee at the
 * same event always gets byte-identical art. That matters for more than
 * tidiness — the artwork becomes a visual fingerprint of the holder, it can be
 * regenerated years later without storing anything, and two people can compare
 * badges without trusting a server.
 *
 * Output is SVG. It is resolution-independent, a few KB rather than a few
 * hundred, and it rasterises cleanly when a wallet wants a PNG.
 */
import { createHash } from "node:crypto";

export interface BadgeArtInput {
  address: string;
  eventId: number;
  /** Short label along the bottom edge. Trimmed to fit. */
  eventName?: string;
}

/** A deterministic byte stream from the address, consumed as parameters. */
class Entropy {
  #bytes: Buffer;
  #i = 0;
  constructor(seed: string) {
    // Two rounds chained so we have 64 bytes without reusing any.
    const a = createHash("sha256").update(seed).digest();
    const b = createHash("sha256").update(a).digest();
    this.#bytes = Buffer.concat([a, b]);
  }
  /** Next byte, 0-255. Wraps rather than running dry. */
  byte(): number {
    const v = this.#bytes[this.#i % this.#bytes.length]!;
    this.#i += 1;
    return v;
  }
  /** Next value in [0,1). */
  unit(): number {
    return this.byte() / 256;
  }
  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.unit() * (max - min + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)]!;
  }
}

/**
 * Curated accent pairs. Random hues would make the set look like noise; a
 * fixed palette makes badges read as a family while staying distinguishable.
 */
const PALETTES: ReadonlyArray<readonly [string, string, string]> = [
  ["#5cbc93", "#2f7f60", "jade"],
  ["#e0a24a", "#a86b1e", "amber"],
  ["#4dd0e1", "#1f7f8c", "cyan"],
  ["#b388ff", "#6d43c7", "violet"],
  ["#ff7a7a", "#b0393c", "coral"],
  ["#a8e05f", "#5c8f28", "lime"],
  ["#ff9ecd", "#c04f8c", "rose"],
  ["#7aa2ff", "#3b5bbf", "azure"],
];

/**
 * SVG is XML: an unescaped `&` or `<` in operator-supplied text produces a
 * document no parser will accept. That matters more here than in a web page,
 * because this SVG is pinned to IPFS and its CID goes into NFTokenMint's URI,
 * which cannot be edited afterwards. An event called "Rock & Roll" would mint
 * permanently broken artwork.
 *
 * Escaping happens AFTER any truncation, never before — escaping first and
 * slicing after can cut `&amp;` in half and reintroduce the bug.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const SIZE = 512;
const CENTRE = SIZE / 2;

function polygon(cx: number, cy: number, r: number, sides: number, rot: number): string {
  const pts: string[] = [];
  for (let i = 0; i < sides; i += 1) {
    const a = rot + (i / sides) * Math.PI * 2;
    pts.push(`${(cx + Math.cos(a) * r).toFixed(2)},${(cy + Math.sin(a) * r).toFixed(2)}`);
  }
  return pts.join(" ");
}

/** PCB-style trace: out along a radius, one right-angle dog-leg, then a node. */
function trace(angle: number, inner: number, outer: number, bend: number): string {
  const x1 = CENTRE + Math.cos(angle) * inner;
  const y1 = CENTRE + Math.sin(angle) * inner;
  const mx = CENTRE + Math.cos(angle) * bend;
  const my = CENTRE + Math.sin(angle) * bend;
  const perp = angle + Math.PI / 2;
  const off = (outer - bend) * 0.55;
  const x2 = mx + Math.cos(perp) * off;
  const y2 = my + Math.sin(perp) * off;
  const x3 = CENTRE + Math.cos(angle) * outer + Math.cos(perp) * off;
  const y3 = CENTRE + Math.sin(angle) * outer + Math.sin(perp) * off;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${mx.toFixed(1)} ${my.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)} L ${x3.toFixed(1)} ${y3.toFixed(1)}`;
}

export interface BadgeArt {
  svg: string;
  /** Traits worth surfacing in the metadata so the art is described, not just shown. */
  traits: { palette: string; core: number; traces: number; density: number };
}

export function renderBadgeArt(input: BadgeArtInput): BadgeArt {
  const e = new Entropy(`${input.address}:${input.eventId}`);
  const [accent, accentDim, paletteName] = e.pick(PALETTES);

  const coreSides = e.pick([6, 6, 8, 5, 12] as const);
  const coreRot = e.unit() * Math.PI * 2;
  const traceCount = e.int(5, 9);
  const density = e.int(48, 72);

  // -- data ring: one tick per nibble of the hash, length carries the value --
  const ticks: string[] = [];
  for (let i = 0; i < density; i += 1) {
    const a = (i / density) * Math.PI * 2 - Math.PI / 2;
    const v = e.byte() / 255;
    const r0 = 208;
    const r1 = 208 + 6 + v * 16;
    ticks.push(
      `<line x1="${(CENTRE + Math.cos(a) * r0).toFixed(1)}" y1="${(CENTRE + Math.sin(a) * r0).toFixed(1)}" ` +
        `x2="${(CENTRE + Math.cos(a) * r1).toFixed(1)}" y2="${(CENTRE + Math.sin(a) * r1).toFixed(1)}" ` +
        `stroke="${v > 0.62 ? accent : accentDim}" stroke-width="${v > 0.62 ? 2.4 : 1.4}" opacity="${(0.35 + v * 0.65).toFixed(2)}"/>`,
    );
  }

  // -- circuit traces --------------------------------------------------------
  // Denser than a decorative few: the middle band is most of the badge, and a
  // handful of thin lines there reads as empty rather than technical.
  const traces: string[] = [];
  for (let i = 0; i < traceCount; i += 1) {
    const a = (i / traceCount) * Math.PI * 2 + e.unit() * 0.35;
    const bend = 108 + e.unit() * 26;
    const outer = 156 + e.unit() * 34;
    traces.push(
      `<path d="${trace(a, 96, outer, bend)}" fill="none" stroke="${accentDim}" ` +
        `stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" opacity=".9"/>`,
    );
    // Via at the dog-leg, node at the end — the two things that make a line
    // read as a trace rather than a scratch.
    const vx = CENTRE + Math.cos(a) * bend;
    const vy = CENTRE + Math.sin(a) * bend;
    traces.push(
      `<circle cx="${vx.toFixed(1)}" cy="${vy.toFixed(1)}" r="3.1" fill="#080a0c" stroke="${accent}" stroke-width="1.5"/>`,
    );
    const perp = a + Math.PI / 2;
    const off = (outer - bend) * 0.55;
    const nx = CENTRE + Math.cos(a) * outer + Math.cos(perp) * off;
    const ny = CENTRE + Math.sin(a) * outer + Math.sin(perp) * off;
    traces.push(
      `<rect x="${(nx - 4).toFixed(1)}" y="${(ny - 4).toFixed(1)}" width="8" height="8" ` +
        `fill="${accent}" transform="rotate(${(e.unit() * 90).toFixed(0)} ${nx.toFixed(1)} ${ny.toFixed(1)})"/>`,
    );
  }

  // -- orbital band: arcs and satellites filling the gap the traces leave ----
  const orbit: string[] = [];
  const arcCount = e.int(3, 5);
  for (let i = 0; i < arcCount; i += 1) {
    const r = 122 + i * 21 + e.unit() * 8;
    const start = e.unit() * Math.PI * 2;
    const sweep = 0.5 + e.unit() * 1.5;
    const x1 = CENTRE + Math.cos(start) * r;
    const y1 = CENTRE + Math.sin(start) * r;
    const x2 = CENTRE + Math.cos(start + sweep) * r;
    const y2 = CENTRE + Math.sin(start + sweep) * r;
    orbit.push(
      `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" ` +
        `fill="none" stroke="${accent}" stroke-width="${(1 + e.unit() * 1.6).toFixed(1)}" opacity="${(0.3 + e.unit() * 0.4).toFixed(2)}"/>`,
    );
    orbit.push(
      `<circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="${(1.8 + e.unit() * 2).toFixed(1)}" fill="${accent}" opacity=".9"/>`,
    );
  }
  // Satellites: small hexes on a ring, count and phase from the hash.
  const satCount = e.int(4, 8);
  const satRing = 176 + e.unit() * 12;
  const satPhase = e.unit() * Math.PI * 2;
  for (let i = 0; i < satCount; i += 1) {
    const a = satPhase + (i / satCount) * Math.PI * 2;
    const sx = CENTRE + Math.cos(a) * satRing;
    const sy = CENTRE + Math.sin(a) * satRing;
    orbit.push(
      `<polygon points="${polygon(sx, sy, 5.5 + e.unit() * 3, 6, e.unit() * 1.2)}" ` +
        `fill="none" stroke="${accentDim}" stroke-width="1.4" opacity=".85"/>`,
    );
  }

  // -- inner glyph: nested polygons, rotation and scale from the hash --------
  const glyph: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const r = 76 - i * 21;
    glyph.push(
      `<polygon points="${polygon(CENTRE, CENTRE, r, coreSides, coreRot + i * 0.34)}" ` +
        `fill="none" stroke="${i === 0 ? accent : accentDim}" stroke-width="${(2.6 - i * 0.6).toFixed(1)}" opacity="${(1 - i * 0.22).toFixed(2)}"/>`,
    );
  }

  const head = escapeXml(input.address.slice(0, 6));
  const tail = escapeXml(input.address.slice(-6));
  // Uppercase and truncate first, then escape. Addresses are base58 so they
  // carry nothing to escape, but the event name is operator input.
  const label = escapeXml(
    (input.eventName ?? `EVENT ${input.eventId}`).toUpperCase().slice(0, 22),
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="Attendance badge for ${head}…${tail}">
<defs>
<radialGradient id="v" cx="50%" cy="44%" r="72%">
  <stop offset="0%" stop-color="#161b1f"/><stop offset="100%" stop-color="#080a0c"/>
</radialGradient>
<pattern id="g" width="32" height="32" patternUnits="userSpaceOnUse">
  <path d="M32 0H0V32" fill="none" stroke="${accent}" stroke-width=".5" opacity=".07"/>
</pattern>
</defs>
<rect width="${SIZE}" height="${SIZE}" fill="url(#v)"/>
<rect width="${SIZE}" height="${SIZE}" fill="url(#g)"/>
<circle cx="${CENTRE}" cy="${CENTRE}" r="243" fill="none" stroke="${accentDim}" stroke-width="1" opacity=".5"/>
<circle cx="${CENTRE}" cy="${CENTRE}" r="236" fill="none" stroke="${accent}" stroke-width="2.5"/>
${ticks.join("\n")}
${orbit.join("\n")}
${traces.join("\n")}
<circle cx="${CENTRE}" cy="${CENTRE}" r="97" fill="#080a0c" opacity=".92"/>
<circle cx="${CENTRE}" cy="${CENTRE}" r="97" fill="none" stroke="${accentDim}" stroke-width="1.3" opacity=".75"/>
<circle cx="${CENTRE}" cy="${CENTRE}" r="91" fill="none" stroke="${accent}" stroke-width="1" opacity=".35"/>
${glyph.join("\n")}
<circle cx="${CENTRE}" cy="${CENTRE}" r="5" fill="${accent}"/>
<g font-family="ui-monospace,SFMono-Regular,Menlo,monospace" text-anchor="middle">
  <text x="${CENTRE}" y="${CENTRE - 108}" fill="${accent}" font-size="15" letter-spacing="5" opacity=".95">${label}</text>
  <text x="${CENTRE}" y="${CENTRE + 126}" fill="#e8e2d6" font-size="19" letter-spacing="2.5">${head}…${tail}</text>
  <text x="${CENTRE}" y="${CENTRE + 150}" fill="${accentDim}" font-size="11" letter-spacing="3.5">XRPL · EVENT ${input.eventId}</text>
</g>
</svg>`;

  return { svg, traits: { palette: paletteName, core: coreSides, traces: traceCount, density } };
}
