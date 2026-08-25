/**
 * SVG -> PNG for badge artwork.
 *
 * WHY PNG AND NOT THE SVG WE ALREADY HAVE. Wallets render what they like.
 * Measured in Xaman: an `image/svg+xml` badge shows as a blank tile. PNG is the
 * one raster format every NFT viewer handles, and `NFTokenMint`'s URI is
 * immutable — a badge minted pointing at an image a wallet will not draw stays
 * broken forever. The SVG is still the source of truth and is what the pages
 * render locally; this is purely what gets pinned.
 *
 * resvg ships prebuilt binaries, so this adds no system dependency and no
 * headless browser.
 */
import { Resvg } from "@resvg/resvg-js";
import { MetadataError } from "../errors.js";

/**
 * 1024 rather than the SVG's native 512: wallet grids upscale thumbnails, and
 * the art is vector so the cost is bytes rather than fidelity.
 */
export const BADGE_PNG_WIDTH = 1024;

export interface RasteriseOptions {
  /** Output width in pixels. Height follows the source aspect (square). */
  width?: number;
}

/**
 * Rasterise badge SVG to PNG bytes.
 *
 * Deterministic for a given (svg, width): same input, same bytes, which keeps
 * the "the pinned image is byte-identical to what the page renders" property
 * meaningful at the PNG layer too.
 */
export function svgToPng(svg: string, options: RasteriseOptions = {}): Buffer {
  const width = options.width ?? BADGE_PNG_WIDTH;
  try {
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: width },
      // The badge draws its own background; no transparency to composite.
      background: "#0b0d0c",
    });
    return Buffer.from(resvg.render().asPng());
  } catch (err) {
    throw new MetadataError(
      "METADATA_INVALID",
      `Could not rasterise badge artwork to PNG: ${(err as Error).message}`,
      { width },
    );
  }
}
