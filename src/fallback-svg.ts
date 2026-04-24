import sharp from "sharp";
import { ImageProcessor } from "./image-processor";

/**
 * SVG fallback image returned when a source image is not found in GCS.
 * Displayed as a 1280×1024 placeholder with a "not available" message.
 *
 * The SVG has a viewBox so it scales cleanly to any requested dimension.
 */

const SVG_TEMPLATE = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" x="0px" y="0px" viewBox="0 0 1280 1024" preserveAspectRatio="xMidYMid slice" __DIMS__>
<style type="text/css">
	.st0{fill:#F9F9F9;}
	.st1{fill:#E6E6E6;}
	.st2{fill:none;}
	.st3{fill:#B3B3B3;}
	.st4{font-family:'ArialMT';}
	.st5{font-size:68px;}
</style>
<g id="Ebene_2">
	<rect class="st0" width="1280" height="1024"/>
</g>
<g id="Ebene_1">
	<g>
		<path class="st1" d="M479,391v267h377V391H479z M845,402v162.7l-60.4-76.9L724,560.5L623.5,463L490,588.7V402H845z M490,647v-43.2&#10;   l133.4-125.7l101.5,98.5l59.4-71.3l60.6,77.3V647H490z"/>
		<path class="st1" d="M714.5,490c17.9,0,32.5-14.6,32.5-32.5S732.4,425,714.5,425S682,439.6,682,457.5S696.6,490,714.5,490z&#10;    M714.5,436c11.9,0,21.5,9.6,21.5,21.5s-9.6,21.5-21.5,21.5s-21.5-9.6-21.5-21.5S702.6,436,714.5,436z"/>
	</g>
	<rect y="505" class="st2" width="1280" height="89.6"/>
	<text transform="matrix(1 0 0 1 261.5737 556.1191)" class="st3 st4 st5">Bild nicht mehr verf&#xFC;gbar</text>
</g>
</svg>`;

/** Build an SVG buffer with optional explicit pixel dimensions injected. */
function buildSvgBuffer(width?: number, height?: number): Buffer {
  const dims = [
    width ? `width="${width}"` : "",
    height ? `height="${height}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return Buffer.from(SVG_TEMPLATE.replace("__DIMS__", dims), "utf-8");
}

export const FALLBACK_CONTENT_TYPE = "image/svg+xml";

/** Default (unsized) SVG fallback — pre-encoded once at startup. */
export const FALLBACK_SVG_BUFFER = buildSvgBuffer();

/**
 * Derive target pixel dimensions from w / h / ar query params,
 * mirroring the logic in ImageProcessor without importing Sharp.
 */
export function resolveFallbackDimensions(
  w?: number,
  h?: number,
  ar?: string,
): { width?: number; height?: number } {
  let width = w;
  let height = h;

  if (ar) {
    const parts = ar.split(":").map(Number);
    if (parts.length === 2 && parts[0] && parts[1]) {
      const ratio = parts[0] / parts[1];
      if (width && !height) height = Math.round(width / ratio);
      if (height && !width) width = Math.round(height * ratio);
      if (!width && !height) width = 1280; // SVG native width as default
    }
  }

  return { width, height };
}

/**
 * Renders the SVG placeholder as a rasterized image in the requested format.
 *
 * Falls back to raw SVG if Sharp cannot rasterize (e.g. librsvg not available).
 *
 * @param width   Target pixel width
 * @param height  Target pixel height
 * @param format  Image format: 'jpg'|'jpeg'|'webp'|'png'|'avif' (default: 'jpg')
 * @returns       { buffer, contentType }
 */
export async function renderFallback(
  width?: number,
  height?: number,
  format?: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const svgBuffer = buildSvgBuffer(width, height);

  // If no raster format is requested, return the SVG as-is
  const fmt = (format ?? "jpg").toLowerCase();
  if (fmt === "svg") {
    return { buffer: svgBuffer, contentType: FALLBACK_CONTENT_TYPE };
  }

  try {
    let pipeline = sharp(svgBuffer);

    // Explicitly resize so Sharp reads the SVG at the right resolution
    if (width || height) {
      pipeline = pipeline.resize(width, height, { fit: "fill" });
    }

    const quality = 80;
    let buffer: Buffer;
    let contentType: string;

    switch (fmt) {
      case "avif":
        buffer = await pipeline.avif({ quality }).toBuffer();
        contentType = "image/avif";
        break;
      case "webp":
        buffer = await pipeline.webp({ quality }).toBuffer();
        contentType = "image/webp";
        break;
      case "png":
        buffer = await pipeline.png({ quality }).toBuffer();
        contentType = "image/png";
        break;
      case "jpg":
      case "jpeg":
      default:
        buffer = await pipeline
          .jpeg({ quality, progressive: true, mozjpeg: false })
          .toBuffer();
        contentType = ImageProcessor.getMimeType("jpg");
        break;
    }

    return { buffer, contentType };
  } catch (err) {
    // librsvg not available or other rasterization error — serve SVG as fallback
    console.warn(
      "[FallbackSvg] Could not rasterize SVG, returning raw SVG:",
      err,
    );
    return { buffer: svgBuffer, contentType: FALLBACK_CONTENT_TYPE };
  }
}
