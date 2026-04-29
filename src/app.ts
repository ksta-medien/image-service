import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { Storage } from "@google-cloud/storage";
import sharp from "sharp";
import { lookup as dnsLookup } from "dns";
import { promisify } from "util";
import { ImageProcessor } from "./image-processor";
import { FaceDetector } from "./face-detector";
import { imageCache, buildCacheKey } from "./image-cache";
import { sourceCache } from "./source-cache";
import { requestCoalescer } from "./request-coalescer";
import {
  FALLBACK_SVG_BUFFER,
  FALLBACK_CONTENT_TYPE,
  renderFallback,
  resolveFallbackDimensions,
} from "./fallback-svg";
import type { ImageProcessingParams } from "./types";
import type { Context } from "hono";

const dnsLookupAsync = promisify(dnsLookup);

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

// Sharp libvips Thread-Pool konfigurieren.
// SHARP_CONCURRENCY sollte gleich containerConcurrency gesetzt werden (z.B. 4),
// damit jeder parallele Request einen eigenen libvips-Thread bekommt und
// CPU-intensive Operationen (insbesondere AVIF-Encoding) echt parallel auf
// mehreren vCPUs laufen. Bei SHARP_CONCURRENCY=1 (Default) wuerden alle
// parallelen Requests sich einen einzigen Thread teilen → Serialisierung →
// AVIF-Encodes stauen sich auf → Timeout → 503.
// AVIF-Encoding-Geschwindigkeit wird zusaetzlich durch AVIF_SPEED gesteuert
// (image-processor.ts, default 6).
const sharpConcurrency = parseInt(process.env.SHARP_CONCURRENCY ?? "1", 10);
sharp.concurrency(sharpConcurrency);
console.log(`[startup] sharp.concurrency set to ${sharpConcurrency}`);

// Pre-warm the face detection Worker so the first request is fast.
FaceDetector.load().catch((err) =>
  console.warn("[FaceDetector] Pre-warm failed (non-fatal):", err),
);

// Initialize Google Cloud Storage client
const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET_NAME);

/**
 * Fetch image from GCS bucket with authentication.
 * Results are stored in the source cache so repeated fetches of the same
 * path (e.g. same image at different output params) skip the GCS round-trip.
 */
async function fetchImageFromGCS(imagePath: string): Promise<Buffer> {
  const cleanPath = imagePath.startsWith("/") ? imagePath.slice(1) : imagePath;

  // Source-cache hit — skip GCS entirely
  const cached = sourceCache.get(cleanPath);
  if (cached) {
    console.log(`[source-cache hit] ${cleanPath}`);
    return cached;
  }

  console.log(`Fetching image from GCS: gs://${GCS_BUCKET_NAME}/${cleanPath}`);
  try {
    const file = bucket.file(cleanPath);
    const [buffer] = await file.download();
    console.log(`Successfully downloaded image: ${buffer.length} bytes`);
    sourceCache.set(cleanPath, buffer);
    return buffer;
  } catch (error) {
    console.error(`Failed to download from GCS:`, error);
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
 * Build full GCS URL from path (for fallback / proxy)
 */
function buildImageUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }
  const cleanPath = pathOrUrl.startsWith("/") ? pathOrUrl.slice(1) : pathOrUrl;
  return `${GCS_BUCKET_BASE_URL}/${cleanPath}`;
}

// Timeout for outbound HTTP fetches in the /image route (ms).
// Configurable via EXTERNAL_FETCH_TIMEOUT_MS env var.
const EXTERNAL_FETCH_TIMEOUT_MS = parseInt(
  process.env.EXTERNAL_FETCH_TIMEOUT_MS ?? "5000",
  10,
);

/**
 * Private IP range detector — returns true for addresses that must not be
 * reached by an operator-controlled URL parameter (SSRF mitigation).
 */
function isPrivateOrLoopbackIp(ip: string): boolean {
  // IPv4 private / loopback / link-local / CGNAT ranges
  const ipv4Private =
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1([01]\d|2[0-7]))\.)/.test(ip);
  // RFC1918 172.16.0.0/12 (172.16.x.x – 172.31.x.x)
  const ipv4Rfc1918_172 = /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  // IPv6 loopback (::1), link-local (fe80::/10), and ULA (fc00::/7: fc** and fd**)
  const ipv6Private =
    ip === "::1" ||
    /^fe[89ab][0-9a-f]:/i.test(ip) ||
    /^f[cd][0-9a-f]{2}:/i.test(ip);
  return ipv4Private || ipv4Rfc1918_172 || ipv6Private;
}

/**
 * Validate that a URL is safe to fetch:
 *  1. Scheme must be http or https.
 *  2. Hostname must not be localhost / 0.0.0.0 or resolve to a private/
 *     loopback IP address (SSRF protection).
 *
 * Throws a descriptive Error if validation fails.
 */
async function validateExternalUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Disallowed URL scheme: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Reject bare loopback / wildcard hostnames before DNS
  if (hostname === "localhost" || hostname === "0.0.0.0") {
    throw new Error(`Disallowed hostname: ${hostname}`);
  }

  // Resolve all addresses for the hostname and reject if any resolves to a
  // private/loopback IP (DNS rebinding / multi-A-record SSRF mitigation).
  try {
    const records = await dnsLookupAsync(hostname, { all: true, verbatim: true });
    for (const { address } of records) {
      if (isPrivateOrLoopbackIp(address)) {
        throw new Error(`Disallowed target IP for hostname ${hostname}: ${address}`);
      }
    }
  } catch (err) {
    // Re-throw our own validation errors unchanged; treat DNS failures as blocked
    if (err instanceof Error && err.message.startsWith("Disallowed")) throw err;
    throw new Error(`DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return parsed;
}

/**
 * Parse an optional integer query param.
 * Returns `undefined` if the value is absent, and `NaN` if it is present but
 * not a valid integer — so callers can detect and reject bad input explicitly.
 */
function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  return Number.parseInt(value, 10);
}

/**
 * Parse image processing query params from a Hono context.
 */
function parseParams(c: Context): ImageProcessingParams {
  return {
    w: parseOptionalInt(c.req.query("w")) || undefined,
    h: parseOptionalInt(c.req.query("h")) || undefined,
    fm: c.req.query("fm") as ImageProcessingParams["fm"],
    q: parseOptionalInt(c.req.query("q")),
    fit: c.req.query("fit") as ImageProcessingParams["fit"],
    ar: c.req.query("ar"),
    rect: c.req.query("rect"),
    crop: c.req.query("crop") as ImageProcessingParams["crop"],
  };
}

/**
 * Core image request handler — shared by the /:path and /image routes.
 *
 * Handles:
 *  1. Immediate fallback trigger (path contains "fallbackImage")
 *  2. Processed-image LRU cache lookup (hit → serve immediately)
 *  3. In-flight deduplication (thundering herd protection)
 *  4. GCS source buffer fetch (with source-level LRU cache)
 *  5. Sharp processing pipeline
 *  6. Storing result in the processed-image cache
 *
 * @param imagePath  Normalized path or URL of the source image
 * @param fetchSource  Async function that returns the raw source buffer.
 *                     Abstracted so the /:path route can use authenticated GCS
 *                     while /image can also handle plain HTTP URLs.
 * @param params  Parsed image processing params
 * @param c  Hono context (for response helpers)
 */
async function handleImageRequest(
  imagePath: string,
  fetchSource: () => Promise<Buffer>,
  params: ImageProcessingParams,
  c: Context,
): Promise<Response> {
  // Immediate fallback trigger — match only when the last path segment
  // (before any file extension) is exactly "fallbackImage", e.g.
  // "fallbackImage.jpg" or "some/path/fallbackImage.png".
  // Using .includes() would also match unintended paths like
  // "real/fallbackImagery.jpg".
  const lastSegment = imagePath.split("/").pop() ?? "";
  const segmentBase = lastSegment.includes(".")
    ? lastSegment.slice(0, lastSegment.lastIndexOf("."))
    : lastSegment;
  if (segmentBase === "fallbackImage") {
    c.header("Content-Type", FALLBACK_CONTENT_TYPE);
    c.header("Cache-Control", "public, max-age=300");
    return c.body(FALLBACK_SVG_BUFFER as unknown as string);
  }

  // Validate quality parameter — also rejects NaN (parseInt("abc") → NaN)
  if (params.q !== undefined && (!Number.isFinite(params.q) || params.q < 1 || params.q > 100)) {
    return c.json({ error: "Quality must be between 1 and 100" }, 400);
  }

  // --- Processed-image cache lookup ---
  const cacheKey = buildCacheKey(imagePath, params as Record<string, unknown>);
  const cached = imageCache.get(cacheKey);
  if (cached) {
    console.log(`[cache hit] ${cacheKey}`);
    c.header("Content-Type", cached.contentType);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    c.header("X-Cache", "HIT");
    return c.body(cached.buffer as unknown as string);
  }
  console.log(`[cache miss] ${cacheKey}`);

  // --- In-flight deduplication (thundering herd protection) ---
  // If an identical request is already in progress, await its result instead
  // of starting a redundant GCS download + Sharp pipeline.
  try {
    const { value } = await requestCoalescer.getOrRun(cacheKey, async () => {
      // Fetch source image (with source-level cache)
      let imageBuffer: Buffer;
      try {
        imageBuffer = await fetchSource();
      } catch (fetchError) {
        if (fetchError instanceof NotFoundError) {
          // Re-throw as a sentinel so the outer try/catch can return a 404 fallback
          throw fetchError;
        }
        throw fetchError;
      }

      // Process
      const processor = new ImageProcessor(imageBuffer);
      const processedImage = await processor.process(params);
      console.log(
        `Successfully processed image: ${processedImage.length} bytes, format: ${params.fm || "jpg"}`,
      );

      const contentType = ImageProcessor.getMimeType(params.fm);
      imageCache.set(cacheKey, processedImage as Buffer, contentType);
      return { buffer: processedImage as Buffer, contentType };
    });

    c.header("Content-Type", value.contentType);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    c.header("X-Cache", "MISS");
    return c.body(value.buffer as unknown as string);
  } catch (err) {
    if (err instanceof NotFoundError) {
      console.warn(`[404] Image not found, returning fallback: ${imagePath}`);
      const { width, height } = resolveFallbackDimensions(params.w, params.h, params.ar);
      const { buffer, contentType } = await renderFallback(width, height, params.fm);
      c.header("Content-Type", contentType);
      c.header("Cache-Control", "public, max-age=300");
      c.status(404);
      return c.body(buffer as unknown as string);
    }

    console.error("Image processing error:", err);
    console.error("Processing params:", JSON.stringify(params));
    return c.json(
      {
        error: `Image processing failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        params,
      },
      500,
    );
  }
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
    sourceCache: sourceCache.stats(),
    inFlight: requestCoalescer.size,
  });
});

// Dedicated fallback route — no file extension required
app.get("/fallbackImage", async (c) => {
  const w = c.req.query("w") ? parseInt(c.req.query("w")!, 10) || undefined : undefined;
  const h = c.req.query("h") ? parseInt(c.req.query("h")!, 10) || undefined : undefined;
  const ar = c.req.query("ar") || undefined;
  const fmt = c.req.query("fm") || undefined;
  const { width, height } = resolveFallbackDimensions(w, h, ar);
  const { buffer, contentType } = await renderFallback(width, height, fmt);
  c.header("Content-Type", contentType);
  c.header("Cache-Control", "public, max-age=300");
  return c.body(buffer as unknown as string);
});

// Primary image processing endpoint — path resolves directly to GCS
app.get("/:path{.+\\.(jpg|jpeg|png|webp|avif)}", async (c) => {
  const imagePath = c.req.param("path");
  const params = parseParams(c);
  return handleImageRequest(
    imagePath,
    () => fetchImageFromGCS(imagePath),
    params,
    c,
  );
});

// Legacy endpoint with explicit URL parameter
app.get("/image", async (c) => {
  const sourceUrl = c.req.query("url");
  if (!sourceUrl) {
    return c.json({ error: 'Missing "url" parameter' }, 400);
  }

  const params = parseParams(c);

  const fetchSource = async (): Promise<Buffer> => {
    if (sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://")) {
      // Validate scheme + SSRF before issuing any network request.
      await validateExternalUrl(sourceUrl);

      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        EXTERNAL_FETCH_TIMEOUT_MS,
      );
      let response: globalThis.Response;
      try {
        response = await fetch(sourceUrl, { signal: controller.signal });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          throw new Error(
            `External fetch timed out after ${EXTERNAL_FETCH_TIMEOUT_MS} ms: ${sourceUrl}`,
          );
        }
        throw err;
      } finally {
        clearTimeout(timeoutHandle);
      }

      // Re-validate the final URL after redirects to prevent SSRF via open
      // redirects (e.g. example.com → 302 → 169.254.169.254).
      if (response.url && response.url !== sourceUrl) {
        await validateExternalUrl(response.url);
      }

      if (!response.ok) {
        if (response.status === 404) {
          throw new NotFoundError(sourceUrl);
        }
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }
      return Buffer.from(await response.arrayBuffer());
    }
    return fetchImageFromGCS(sourceUrl);
  };

  return handleImageRequest(sourceUrl, fetchSource, params, c);
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
