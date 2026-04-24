import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { Storage } from "@google-cloud/storage";
import sharp from "sharp";
import { ImageProcessor } from "./image-processor";
import { FaceDetector } from "./face-detector";
import { imageCache, buildCacheKey } from "./image-cache";
import {
  FALLBACK_SVG_BUFFER,
  FALLBACK_CONTENT_TYPE,
  renderFallback,
  resolveFallbackDimensions,
} from "./fallback-svg";
import type { ImageProcessingParams } from "./types";

const app = new Hono();

/** Signals that a requested resource does not exist (maps to HTTP 404). */
class NotFoundError extends Error {
  constructor(path: string) {
    super(`Image not found: ${path}`);
    this.name = "NotFoundError";
  }
}

// Configuration
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || "livingdocs-image-live";
const GCS_BUCKET_BASE_URL =
  process.env.GCS_BUCKET_BASE_URL ||
  "https://storage.cloud.google.com/livingdocs-image-live";

// Sharp libvips Thread-Pool begrenzen.
// Bei containerConcurrency=5 wuerden 5 parallele Requests sonst jeweils
// alle verfuegbaren libvips-Threads beanspruchen und sich gegenseitig blockieren.
// Mit concurrency=1 arbeitet jeder Request single-threaded durch libvips,
// die 6 vCPUs werden ueber die 5 parallelen Container-Requests genutzt.
// AVIF-Encoding-Latenz wird durch den speed-Parameter in image-processor.ts
// gesteuert, nicht durch concurrency.
const sharpConcurrency = parseInt(process.env.SHARP_CONCURRENCY ?? "1", 10);
sharp.concurrency(sharpConcurrency);
console.log(`[startup] sharp.concurrency set to ${sharpConcurrency}`);

// Pre-warm the BlazeFace model in the background so the first request is fast
FaceDetector.load().catch((err) =>
  console.warn("[FaceDetector] Pre-warm failed (non-fatal):", err),
);

// Initialize Google Cloud Storage client
const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET_NAME);

/**
 * Fetch image from GCS bucket with authentication
 */
async function fetchImageFromGCS(imagePath: string): Promise<Buffer> {
  // Remove leading slash if present
  const cleanPath = imagePath.startsWith("/") ? imagePath.slice(1) : imagePath;

  console.log(`Fetching image from GCS: gs://${GCS_BUCKET_NAME}/${cleanPath}`);

  try {
    const file = bucket.file(cleanPath);
    const [buffer] = await file.download();
    console.log(`Successfully downloaded image: ${buffer.length} bytes`);
    return buffer;
  } catch (error) {
    console.error(`Failed to download from GCS:`, error);
    // GCS throws a structured error with code 404 when the object does not exist
    const code = (error as { code?: number }).code;
    if (code === 404) {
      throw new NotFoundError(cleanPath);
    }
    throw new Error(
      `Failed to download image from GCS: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Build full GCS URL from path (for fallback)
 */
function buildImageUrl(pathOrUrl: string): string {
  // If it's already a full URL, return as-is
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }

  // Remove leading slash if present
  const cleanPath = pathOrUrl.startsWith("/") ? pathOrUrl.slice(1) : pathOrUrl;

  // Build full GCS URL
  return `${GCS_BUCKET_BASE_URL}/${cleanPath}`;
}

// Middleware
app.use("*", logger());
app.use("*", cors());

// Health check endpoint
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    bucket: GCS_BUCKET_BASE_URL,
    faceDetection: FaceDetector.isLoaded() ? "ready" : "loading",
    imageCache: imageCache.stats(),
  });
});

// Dedicated fallback route — no file extension required
// Matches /fallbackImage and anything starting with /fallbackImage
app.get("/fallbackImage", async (c) => {
  const w = c.req.query("w")
    ? parseInt(c.req.query("w")!, 10) || undefined
    : undefined;
  const h = c.req.query("h")
    ? parseInt(c.req.query("h")!, 10) || undefined
    : undefined;
  const ar = c.req.query("ar") || undefined;
  const fmt = c.req.query("fm") || undefined;
  const { width, height } = resolveFallbackDimensions(w, h, ar);
  const { buffer, contentType } = await renderFallback(width, height, fmt);
  c.header("Content-Type", contentType);
  c.header("Cache-Control", "public, max-age=300");
  return c.body(buffer as unknown as string);
});

// Main image processing endpoint - supports both path and URL
app.get("/:path{.+\\.(jpg|jpeg|png|webp|avif)}", async (c) => {
  try {
    // Get the path from URL
    const imagePath = c.req.param("path");

    // Explicit fallback trigger: return the placeholder SVG immediately
    if (imagePath.includes("fallbackImage")) {
      c.header("Content-Type", FALLBACK_CONTENT_TYPE);
      c.header("Cache-Control", "public, max-age=300");
      return c.body(FALLBACK_SVG_BUFFER as unknown as string);
    }

    // Parse image processing parameters
    const params: ImageProcessingParams = {
      w: c.req.query("w")
        ? parseInt(c.req.query("w")!, 10) || undefined
        : undefined,
      h: c.req.query("h")
        ? parseInt(c.req.query("h")!, 10) || undefined
        : undefined,
      fm: c.req.query("fm") as ImageProcessingParams["fm"],
      q: c.req.query("q") ? parseInt(c.req.query("q")!, 10) : undefined,
      fit: c.req.query("fit") as ImageProcessingParams["fit"],
      ar: c.req.query("ar"),
      rect: c.req.query("rect"),
      crop: c.req.query("crop") as ImageProcessingParams["crop"],
    };

    // Validate quality parameter
    if (params.q !== undefined && (params.q < 1 || params.q > 100)) {
      return c.json({ error: "Quality must be between 1 and 100" }, 400);
    }

    // --- Cache lookup ---
    const cacheKey = buildCacheKey(
      imagePath,
      params as Record<string, unknown>,
    );
    const cached = imageCache.get(cacheKey);
    if (cached) {
      console.log(`[cache hit] ${cacheKey}`);
      c.header("Content-Type", cached.contentType);
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      c.header("X-Cache", "HIT");
      return c.body(cached.buffer as unknown as string);
    }
    console.log(`[cache miss] ${cacheKey}`);

    // Fetch the source image from GCS
    let imageBuffer: Buffer;
    try {
      imageBuffer = await fetchImageFromGCS(imagePath);
    } catch (fetchError) {
      if (fetchError instanceof NotFoundError) {
        console.warn(`[404] Image not found, returning fallback: ${imagePath}`);
        const { width, height } = resolveFallbackDimensions(
          params.w,
          params.h,
          params.ar,
        );
        const { buffer, contentType } = await renderFallback(
          width,
          height,
          params.fm,
        );
        c.header("Content-Type", contentType);
        c.header("Cache-Control", "public, max-age=300");
        return c.body(buffer as unknown as string);
      }
      console.error(`Failed to fetch image from GCS:`, fetchError);
      return c.json(
        {
          error: `Failed to fetch image: ${fetchError instanceof Error ? fetchError.message : "Unknown error"}`,
          path: imagePath,
        },
        502,
      );
    }

    // Process the image
    try {
      const processor = new ImageProcessor(imageBuffer);
      const processedImage = await processor.process(params);
      console.log(
        `Successfully processed image: ${processedImage.length} bytes, format: ${params.fm || "jpg"}`,
      );

      // Determine content type
      const contentType = ImageProcessor.getMimeType(params.fm);

      // Store in cache for subsequent requests
      imageCache.set(cacheKey, processedImage as Buffer, contentType);

      // Set caching headers
      c.header("Content-Type", contentType);
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      c.header("X-Cache", "MISS");

      return c.body(processedImage as unknown as string);
    } catch (processingError) {
      console.error("Image processing error:", processingError);
      console.error("Processing params:", JSON.stringify(params));
      console.error("Buffer size:", imageBuffer.length);
      return c.json(
        {
          error: `Image processing failed: ${processingError instanceof Error ? processingError.message : "Unknown error"}`,
          params: params,
        },
        500,
      );
    }
  } catch (error) {
    console.error("Unexpected error:", error);
    return c.json(
      {
        error: `Unexpected error: ${error instanceof Error ? error.message : "Unknown error"}`,
      },
      500,
    );
  }
});

// Legacy endpoint with explicit URL parameter
app.get("/image", async (c) => {
  try {
    // Get source URL from query parameter
    const sourceUrl = c.req.query("url");
    if (!sourceUrl) {
      return c.json({ error: 'Missing "url" parameter' }, 400);
    }

    // Explicit fallback trigger: return the placeholder SVG immediately
    if (sourceUrl.includes("fallbackImage")) {
      c.header("Content-Type", FALLBACK_CONTENT_TYPE);
      c.header("Cache-Control", "public, max-age=300");
      return c.body(FALLBACK_SVG_BUFFER as unknown as string);
    }

    // Parse image processing parameters
    const params: ImageProcessingParams = {
      w: c.req.query("w")
        ? parseInt(c.req.query("w")!, 10) || undefined
        : undefined,
      h: c.req.query("h")
        ? parseInt(c.req.query("h")!, 10) || undefined
        : undefined,
      fm: c.req.query("fm") as ImageProcessingParams["fm"],
      q: c.req.query("q") ? parseInt(c.req.query("q")!, 10) : undefined,
      fit: c.req.query("fit") as ImageProcessingParams["fit"],
      ar: c.req.query("ar"),
      rect: c.req.query("rect"),
      crop: c.req.query("crop") as ImageProcessingParams["crop"],
    };

    // Validate quality parameter
    if (params.q !== undefined && (params.q < 1 || params.q > 100)) {
      return c.json({ error: "Quality must be between 1 and 100" }, 400);
    }

    // --- Cache lookup ---
    const cacheKey = buildCacheKey(
      sourceUrl,
      params as Record<string, unknown>,
    );
    const cached = imageCache.get(cacheKey);
    if (cached) {
      console.log(`[cache hit] ${cacheKey}`);
      c.header("Content-Type", cached.contentType);
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      c.header("X-Cache", "HIT");
      return c.body(cached.buffer as unknown as string);
    }
    console.log(`[cache miss] ${cacheKey}`);

    // Fetch the source image from GCS
    let imageBuffer: Buffer;
    try {
      // Check if it's a full URL or a path
      if (sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://")) {
        // External URL - use fetch
        const response = await fetch(sourceUrl);
        if (!response.ok) {
          return c.json(
            { error: `Failed to fetch image: ${response.statusText}` },
            502,
          );
        }
        const arrayBuffer = await response.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuffer);
      } else {
        // GCS path - use authenticated download
        imageBuffer = await fetchImageFromGCS(sourceUrl);
      }
    } catch (fetchError) {
      if (fetchError instanceof NotFoundError) {
        console.warn(`[404] Image not found, returning fallback: ${sourceUrl}`);
        const { width, height } = resolveFallbackDimensions(
          params.w,
          params.h,
          params.ar,
        );
        const { buffer, contentType } = await renderFallback(
          width,
          height,
          params.fm,
        );
        c.header("Content-Type", contentType);
        c.header("Cache-Control", "public, max-age=300");
        return c.body(buffer as unknown as string);
      }
      return c.json(
        {
          error: `Failed to fetch image: ${fetchError instanceof Error ? fetchError.message : "Unknown error"}`,
        },
        502,
      );
    }

    // Process the image
    const processor = new ImageProcessor(imageBuffer);
    const processedImage = await processor.process(params);

    // Determine content type
    const contentType = ImageProcessor.getMimeType(params.fm);

    // Store in cache for subsequent requests
    imageCache.set(cacheKey, processedImage as Buffer, contentType);

    // Set caching headers
    c.header("Content-Type", contentType);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    c.header("X-Cache", "MISS");

    return c.body(processedImage as unknown as string);
  } catch (error) {
    console.error("Image processing error:", error);
    return c.json(
      {
        error: `Image processing failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      },
      500,
    );
  }
});

// Proxy endpoint (no processing, just returns the image)
app.get("/proxy", async (c) => {
  try {
    const sourceUrl = c.req.query("url");
    if (!sourceUrl) {
      return c.json({ error: 'Missing "url" parameter' }, 400);
    }

    const imageUrl = buildImageUrl(sourceUrl);
    const response = await fetch(imageUrl);
    if (!response.ok) {
      return c.json(
        { error: `Failed to fetch image: ${response.statusText}` },
        502,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType =
      response.headers.get("content-type") || "application/octet-stream";

    c.header("Content-Type", contentType);
    c.header("Cache-Control", "public, max-age=31536000, immutable");

    return c.body(Buffer.from(arrayBuffer) as unknown as string);
  } catch (error) {
    console.error("Proxy error:", error);
    return c.json(
      {
        error: `Proxy failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      },
      500,
    );
  }
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

export default app;
