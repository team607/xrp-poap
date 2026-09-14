/**
 * The QR reader the vendor counter uses where the browser has none of its own
 * (Chrome on an iPhone). Pictures are drawn here the way a phone camera sees a
 * code on another phone: turned, tilted, blurred, noisy, unevenly lit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { PAGES_DIR } from "./routes/pages.js";

interface Picture { data: Uint8ClampedArray; width: number; height: number }
interface Grid { size: number; modules: ArrayLike<number> }

const reader = (() => {
  const context = vm.createContext({ TextDecoder });
  vm.runInContext(readFileSync(join(PAGES_DIR, "assets", "qr-read.js"), "utf8"), context);
  return (context as unknown as { QRRead: { decode(p: Picture): string | null } }).QRRead;
})();

/** The pass's own encoder, lifted out of attend.html: what the counter will actually be shown. */
const encoder = (() => {
  const html = readFileSync(join(PAGES_DIR, "attend.html"), "utf8");
  const start = html.indexOf("var QR = (function () {");
  const end = html.indexOf("})();", html.indexOf("return { encode: encode"));
  const context = vm.createContext({ TextEncoder });
  vm.runInContext(html.slice(start, end + 5), context);
  return (context as unknown as { QR: { encode(text: string): Grid & { version: number } } }).QR;
})();

/** Codes from Apple's CoreImage generator, which shares nothing with the encoder above. */
const apple = JSON.parse(readFileSync(new URL("./qr-read.fixtures.json", import.meta.url), "utf8")) as Array<{
  text: string;
  level: string;
  rows: string[];
}>;

interface Shot {
  module?: number;
  turn?: number;
  /** Corner offsets as fractions of the code's width: [tlx, tly, trx, try, brx, bry, blx, bly]. */
  tilt?: number[];
  blur?: number;
  noise?: number;
  ink?: number;
  paper?: number;
  shade?: number;
  damage?: [number, number, number];
}

function squareTo(q: number[]): number[] {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q as [number, number, number, number, number, number, number, number];
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}
function invert(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  return [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
}

/** A camera's-eye picture of a module grid. */
function photograph(grid: Grid, shot: Shot = {}): Picture {
  const quiet = 4, n = grid.size + 2 * quiet, px = shot.module ?? 4;
  const side = n * px, width = Math.round(side * 1.5), height = Math.round(side * 1.5);
  const cx = width / 2, cy = height / 2, turn = ((shot.turn ?? 0) * Math.PI) / 180;
  const tilt = shot.tilt ?? [0, 0, 0, 0, 0, 0, 0, 0];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].flatMap(([sx, sy], k) => {
    const x = (sx! * side) / 2 + (tilt[2 * k] ?? 0) * side, y = (sy! * side) / 2 + (tilt[2 * k + 1] ?? 0) * side;
    return [cx + x * Math.cos(turn) - y * Math.sin(turn), cy + x * Math.sin(turn) + y * Math.cos(turn)];
  });
  const back = invert(squareTo(corners));
  const ink = shot.ink ?? 25, paper = shot.paper ?? 235;
  const damage = shot.damage;
  const isDark = (u: number, v: number): boolean => {
    const c = Math.floor(u * n) - quiet, r = Math.floor(v * n) - quiet;
    if (c < 0 || r < 0 || c >= grid.size || r >= grid.size) return false;
    if (damage && r >= damage[0] && r < damage[0] + damage[2] && c >= damage[1] && c < damage[1] + damage[2]) return true;
    return grid.modules[r * grid.size + c] === 1;
  };
  let gray = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const X = x + (sx + 0.5) / 3, Y = y + (sy + 0.5) / 3;
          const z = back[6]! * X + back[7]! * Y + back[8]!;
          const u = (back[0]! * X + back[1]! * Y + back[2]!) / z, v = (back[3]! * X + back[4]! * Y + back[5]!) / z;
          if (u >= 0 && v >= 0 && u < 1 && v < 1 && isDark(u, v)) hits++;
        }
      }
      gray[y * width + x] = paper - ((paper - ink) * hits) / 9;
    }
  }
  for (let pass = 0; pass < (shot.blur ?? 0); pass++) {
    const next = new Float64Array(gray.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < width && yy < height) { sum += gray[yy * width + xx]!; count++; }
        }
        next[y * width + x] = sum / count;
      }
    }
    gray = next;
  }
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const x = i % width;
    const v = gray[i]! * (1 - (shot.shade ?? 0) * (x / width)) + (random() - 0.5) * 2 * (shot.noise ?? 0);
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

const LINK =
  "https://f3ae-122-162-149-27.ngrok-free.app/vendor#collect=2f1c6a4e-8d3b-4a57-9c1e-5b7d9e0f1a2b.1789565037.6r1NExPxvnaaowYe_x0IsA";

describe("QR reader", () => {
  const code = encoder.encode(LINK);

  it("reads a collection link off a straight, sharp picture", () => {
    expect(code.version).toBe(8);
    expect(reader.decode(photograph(code))).toBe(LINK);
  });

  it("reads it turned any way round", () => {
    for (const turn of [17, 45, 90, 135, 180, 250, 315]) {
      expect(reader.decode(photograph(code, { turn })), `turned ${turn}°`).toBe(LINK);
    }
  });

  it("reads a blurred, noisy, unevenly lit, washed-out picture", () => {
    expect(reader.decode(photograph(code, { blur: 2, noise: 25, shade: 0.4, ink: 70, paper: 190, module: 5, turn: 8 }))).toBe(LINK);
  });

  it("reads small modules", () => {
    expect(reader.decode(photograph(code, { module: 3, turn: 5 }))).toBe(LINK);
  });

  it("reads through a smudge the error correction can cover", () => {
    expect(reader.decode(photograph(code, { damage: [30, 30, 6] }))).toBe(LINK);
  });

  it("reads every version the pass draws", () => {
    for (let version = 1; version <= 10; version++) {
      const text = "v".repeat([0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213][version]!);
      const grid = encoder.encode(text);
      expect(grid.version).toBe(version);
      expect(reader.decode(photograph(grid, { turn: 7 })), `version ${version}`).toBe(text);
    }
  });

  it("reads codes from another encoder, at every error-correction level", () => {
    expect(new Set(apple.map((c) => c.level))).toEqual(new Set(["L", "M", "Q", "H"]));
    for (const { text, level, rows } of apple) {
      const grid = { size: rows.length, modules: rows.join("").split("").map(Number) };
      expect(reader.decode(photograph(grid, { turn: 20 })), `${level}, ${rows.length} modules`).toBe(text);
    }
  });

  it("finds nothing where there is no code", () => {
    const blank = { data: new Uint8ClampedArray(200 * 200 * 4).fill(230), width: 200, height: 200 };
    expect(reader.decode(blank)).toBeNull();
    let seed = 3;
    const noise = new Uint8ClampedArray(320 * 240 * 4).map(() => ((seed = (seed * 69069 + 1) % 4294967296) >>> 24));
    expect(reader.decode({ data: noise, width: 320, height: 240 })).toBeNull();
    expect(reader.decode({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toBeNull();
  });
});
