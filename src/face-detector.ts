import sharp from "sharp";
import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { WorkerRequest, WorkerResponse } from "./face-detector-worker";

/**
 * Bounding box einer erkannten Region (Gesicht oder Person) in Pixeln.
 */
export interface FaceBox {
  topLeft: [number, number];
  bottomRight: [number, number];
}

/**
 * Berechnet den gewichteten Mittelpunkt aller erkannten Boxen.
 * Gibt null zurück wenn keine Boxen vorhanden.
 */
export function computeFaceCenter(
  faces: FaceBox[],
  _imageWidth: number,
  _imageHeight: number,
): { x: number; y: number } | null {
  if (faces.length === 0) return null;

  let sumX = 0;
  let sumY = 0;

  for (const face of faces) {
    const cx = (face.topLeft[0] + face.bottomRight[0]) / 2;
    const cy = (face.topLeft[1] + face.bottomRight[1]) / 2;
    sumX += cx;
    sumY += cy;
  }

  return {
    x: Math.round(sumX / faces.length),
    y: Math.round(sumY / faces.length),
  };
}

/**
 * Berechnet eine Extraktions-Region aus dem Originalbild, die:
 * - das gewünschte Zielseitenverhältnis (targetW / targetH) hat,
 * - maximal die Originalgröße ausnutzt (kein Zoom),
 * - den Fokuspunkt (fx, fy) so zentral wie möglich platziert.
 *
 * Gibt null zurück wenn targetW oder targetH fehlt (Fallback auf Sharp-Strategie).
 */
export function computeFocalCrop(
  imgW: number,
  imgH: number,
  targetW: number | undefined,
  targetH: number | undefined,
  fx: number,
  fy: number,
): { left: number; top: number; width: number; height: number } | null {
  if (!targetW || !targetH) return null;

  const targetAR = targetW / targetH;
  const srcAR = imgW / imgH;

  let cropW: number;
  let cropH: number;

  if (srcAR > targetAR) {
    // Bild breiter als Ziel → Breite beschneiden, volle Höhe behalten
    cropH = imgH;
    cropW = Math.round(imgH * targetAR);
  } else {
    // Bild höher als Ziel → Höhe beschneiden, volle Breite behalten
    cropW = imgW;
    cropH = Math.round(imgW / targetAR);
  }

  // Crop-Region auf Fokuspunkt zentrieren, innerhalb der Bildgrenzen klemmen
  const left = Math.max(0, Math.min(Math.round(fx - cropW / 2), imgW - cropW));
  const top = Math.max(0, Math.min(Math.round(fy - cropH / 2), imgH - cropH));

  return { left, top, width: cropW, height: cropH };
}

// ---------------------------------------------------------------------------
// Worker thread pool
// ---------------------------------------------------------------------------
// TF.js WASM runs synchronously and blocks the JS event loop for the full
// inference duration (~60–300 ms). Moving inference into a Worker thread lets
// the main event loop continue serving other requests while the GPU-less WASM
// engine works in the background.
//
// Pool size is controlled by FACE_DETECTION_CONCURRENCY (default 1).
// A semaphore limits concurrent dispatches to the pool size.
// ---------------------------------------------------------------------------

const INFERENCE_CONCURRENCY = parseInt(
  process.env.FACE_DETECTION_CONCURRENCY ?? "1",
  10,
);

const FACE_DETECTION_TIMEOUT_MS = parseInt(
  process.env.FACE_DETECTION_TIMEOUT_MS ?? "8000",
  10,
);

// Resolve absolute path to the worker file.
// Works for both `bun src/face-detector.ts` and after `bun build`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_PATH = join(__dirname, "face-detector-worker.ts");

/** Create a fresh Worker and attach a one-time error/exit guard. */
function createWorker(): Worker {
  return new Worker(WORKER_PATH, {
    // Bun supports running .ts workers directly.
    // Node 22+ also supports --experimental-strip-types but Bun is the target.
  });
}

// Lazy singleton worker — created on first use, recycled thereafter.
let workerInstance: Worker | null = null;
let workerReady = false;

function getWorker(): Worker {
  if (!workerInstance || !workerReady) {
    workerInstance = createWorker();
    workerReady = true;
    workerInstance.on("error", (err) => {
      console.error("[FaceDetector] Worker error:", err);
      workerReady = false;
      workerInstance = null;
    });
    workerInstance.on("exit", (code) => {
      if (code !== 0) {
        console.warn(`[FaceDetector] Worker exited with code ${code}`);
      }
      workerReady = false;
      workerInstance = null;
    });
  }
  return workerInstance;
}

// Semaphore — limits concurrent dispatches to INFERENCE_CONCURRENCY slots.
let inferenceActive = 0;
const inferenceWaiters: Array<() => void> = [];

function acquireInference(): Promise<void> {
  if (inferenceActive < INFERENCE_CONCURRENCY) {
    inferenceActive++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => inferenceWaiters.push(resolve));
}

function releaseInference(): void {
  const next = inferenceWaiters.shift();
  if (next) {
    next();
  } else {
    inferenceActive--;
  }
}

// Monotonically increasing request ID for matching responses to promises.
let nextRequestId = 0;
const pendingRequests = new Map<
  number,
  { resolve: (faces: FaceBox[]) => void; reject: (err: Error) => void }
>();

function attachResponseHandler(worker: Worker): void {
  // Only attach once — guard with a flag on the worker object.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((worker as any).__listenerAttached) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (worker as any).__listenerAttached = true;

  worker.on("message", (msg: WorkerResponse) => {
    const pending = pendingRequests.get(msg.id);
    if (!pending) return;
    pendingRequests.delete(msg.id);

    if ("error" in msg) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.faces as FaceBox[]);
    }
  });
}

// ---------------------------------------------------------------------------
// Pre-warm: load TF models inside the worker at startup.
// We send a tiny 1×1 PNG so model loading happens before the first real request.
// ---------------------------------------------------------------------------

let preWarmDone = false;

async function preWarmWorker(): Promise<void> {
  if (preWarmDone) return;
  preWarmDone = true;
  try {
    // 1×1 transparent PNG — minimal valid image to trigger model load
    const tinyPng = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    await FaceDetector.detect(tinyPng, { width: 1, height: 1 });
    console.log("[FaceDetector] Worker pre-warm complete.");
  } catch (err) {
    console.warn("[FaceDetector] Worker pre-warm failed (non-fatal):", err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class FaceDetector {
  /** Pre-warm the worker so the first real request doesn't pay model-load cost. */
  static async load(): Promise<void> {
    await preWarmWorker();
  }

  static isLoaded(): boolean {
    return workerInstance !== null && workerReady;
  }

  /**
   * Detect faces/persons in `imageBuffer`.
   * Runs in a Worker thread — never blocks the main event loop.
   * Falls back to [] on timeout or error.
   *
   * @param imageBuffer  Raw image buffer (any format Sharp can read)
   * @param preReadMeta  Optional pre-read { width, height } to skip a metadata call in the worker
   */
  static async detect(
    imageBuffer: Buffer,
    preReadMeta?: { width?: number; height?: number },
  ): Promise<FaceBox[]> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<FaceBox[]>((resolve) => {
      timeoutHandle = setTimeout(() => {
        console.warn(
          `[FaceDetector] Detection timed out after ${FACE_DETECTION_TIMEOUT_MS} ms — falling back to entropy.`,
        );
        resolve([]);
      }, FACE_DETECTION_TIMEOUT_MS);
    });

    const detectionPromise = FaceDetector._detect(imageBuffer, preReadMeta).finally(() => {
      clearTimeout(timeoutHandle);
    });

    return Promise.race([detectionPromise, timeoutPromise]);
  }

  private static async _detect(
    imageBuffer: Buffer,
    preReadMeta?: { width?: number; height?: number },
  ): Promise<FaceBox[]> {
    await acquireInference();
    try {
      console.log(`[FaceDetector] detect() — buffer: ${imageBuffer.length} bytes`);

      const worker = getWorker();
      attachResponseHandler(worker);

      const id = nextRequestId++;
      const req: WorkerRequest = {
        id,
        buffer: imageBuffer.buffer.slice(
          imageBuffer.byteOffset,
          imageBuffer.byteOffset + imageBuffer.byteLength,
        ) as ArrayBuffer,
        width: preReadMeta?.width,
        height: preReadMeta?.height,
      };

      return await new Promise<FaceBox[]>((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
        // Transfer the ArrayBuffer to avoid copying (zero-copy)
        worker.postMessage(req, [req.buffer]);
      });
    } catch (err) {
      console.error("[FaceDetector] Detection error, falling back:", err);
      return [];
    } finally {
      releaseInference();
    }
  }
}
