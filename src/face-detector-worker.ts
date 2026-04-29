/**
 * Face detection Worker thread.
 *
 * Runs the full TF.js WASM inference pipeline in an isolated thread so the
 * main event loop is never blocked by synchronous WASM execution (~60–300 ms).
 *
 * Protocol (via postMessage):
 *   Main → Worker:  { id: number; buffer: ArrayBuffer; width?: number; height?: number }
 *   Worker → Main:  { id: number; faces: FaceBox[] }            — success
 *                   { id: number; error: string }               — failure
 */

import sharp from "sharp";

export interface FaceBox {
  topLeft: [number, number];
  bottomRight: [number, number];
}

// ---------------------------------------------------------------------------
// Worker message types
// ---------------------------------------------------------------------------

export interface WorkerRequest {
  id: number;
  buffer: ArrayBuffer;
  /** Pre-read image width — avoids a redundant sharp.metadata() call */
  width?: number;
  /** Pre-read image height — avoids a redundant sharp.metadata() call */
  height?: number;
}

export type WorkerResponse =
  | { id: number; faces: FaceBox[] }
  | { id: number; error: string };

// ---------------------------------------------------------------------------
// Internal model singletons (per-worker)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let faceModel: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let personModel: any = null;
let modelsLoading: Promise<void> | null = null;

const FACE_DETECTION_MAX_INPUT_WIDTH = parseInt(
  process.env.FACE_DETECTION_MAX_INPUT_WIDTH ?? "640",
  10,
);

async function initBackend(): Promise<void> {
  const tf = await import("@tensorflow/tfjs-core");
  await import("@tensorflow/tfjs-backend-wasm");
  await import("@tensorflow/tfjs-converter");
  await tf.setBackend("wasm");
  await tf.ready();
}

async function loadModels(): Promise<void> {
  if (faceModel && personModel) return;
  if (modelsLoading) {
    await modelsLoading;
    return;
  }
  modelsLoading = (async () => {
    console.log("[FaceWorker] Initialising WASM backend...");
    await initBackend();

    console.log("[FaceWorker] Loading MediaPipe Face Detector...");
    const faceDetection = await import("@tensorflow-models/face-detection");
    faceModel = await faceDetection.createDetector(
      faceDetection.SupportedModels.MediaPipeFaceDetector,
      { runtime: "tfjs", modelType: "full" },
    );
    console.log("[FaceWorker] Face model ready.");

    console.log("[FaceWorker] Loading COCO-SSD...");
    const cocoSsd = await import("@tensorflow-models/coco-ssd");
    personModel = await cocoSsd.load({ base: "mobilenet_v2" });
    console.log("[FaceWorker] COCO-SSD ready.");
  })().catch((err) => {
    // Clear the sentinel so the next call can retry rather than re-throwing
    // from a permanently rejected promise.
    modelsLoading = null;
    faceModel = null;
    personModel = null;
    throw err;
  });
  await modelsLoading;
}

// ---------------------------------------------------------------------------
// Tensor helper
// ---------------------------------------------------------------------------

async function bufferToRgbTensor(
  imageBuffer: Buffer,
  preWidth?: number,
  preHeight?: number,
) {
  const tf = await import("@tensorflow/tfjs-core");

  // Read metadata at most once — only when the caller didn't supply both dimensions.
  const meta =
    preWidth === undefined || preHeight === undefined
      ? await sharp(imageBuffer).metadata()
      : null;
  const origWidth = preWidth ?? meta?.width ?? FACE_DETECTION_MAX_INPUT_WIDTH;
  const origHeight = preHeight ?? meta?.height ?? FACE_DETECTION_MAX_INPUT_WIDTH;

  let inferenceWidth = origWidth;
  let inferenceHeight = origHeight;
  if (origWidth > FACE_DETECTION_MAX_INPUT_WIDTH) {
    const scale = FACE_DETECTION_MAX_INPUT_WIDTH / origWidth;
    inferenceWidth = FACE_DETECTION_MAX_INPUT_WIDTH;
    inferenceHeight = Math.round(origHeight * scale);
  }

  const pipeline = sharp(imageBuffer).removeAlpha();
  if (inferenceWidth !== origWidth) {
    pipeline.resize(inferenceWidth, inferenceHeight, { fit: "fill" });
  }
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });

  return {
    tensor: tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]),
    width: info.width,
    height: info.height,
    scaleX: origWidth / info.width,
    scaleY: origHeight / info.height,
  };
}

// ---------------------------------------------------------------------------
// Detection stages
// ---------------------------------------------------------------------------

async function detectFaces(imageBuffer: Buffer, preWidth?: number, preHeight?: number): Promise<FaceBox[]> {
  const { tensor, width, height, scaleX, scaleY } = await bufferToRgbTensor(imageBuffer, preWidth, preHeight);
  console.log(`[FaceWorker:MediaPipe] Running inference on ${width}x${height} (scaleX=${scaleX.toFixed(2)}, scaleY=${scaleY.toFixed(2)})...`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let predictions: any[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    predictions = await faceModel.estimateFaces(tensor);
  } finally {
    // Always dispose — even if estimateFaces() throws — to avoid tensor memory leaks.
    tensor.dispose();
  }

  if (!predictions || predictions.length === 0) {
    console.log("[FaceWorker:MediaPipe] 0 faces detected.");
    return [];
  }

  console.log(`[FaceWorker:MediaPipe] ${predictions.length} face(s) detected.`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return predictions.map((p: any): FaceBox => {
    const box = p.box ?? p.boundingBox ?? p;
    // Resolve top-left corner (raw, unscaled) — used both for the final topLeft
    // coordinate and as the subtrahend when deriving w/h from bottomRight.
    const rawXMin = box.xMin ?? box.topLeft?.[0] ?? 0;
    const rawYMin = box.yMin ?? box.topLeft?.[1] ?? 0;
    const xMin = Math.max(0, Math.round(rawXMin * scaleX));
    const yMin = Math.max(0, Math.round(rawYMin * scaleY));
    const w = Math.round(
      (box.width !== undefined
        ? box.width
        : box.bottomRight?.[0] !== undefined
          ? box.bottomRight[0] - rawXMin
          : 0) * scaleX,
    );
    const h = Math.round(
      (box.height !== undefined
        ? box.height
        : box.bottomRight?.[1] !== undefined
          ? box.bottomRight[1] - rawYMin
          : 0) * scaleY,
    );
    return { topLeft: [xMin, yMin], bottomRight: [xMin + w, yMin + h] };
  });
}

const PERSON_CLASSES = new Set(["person"]);

async function detectPersons(imageBuffer: Buffer, preWidth?: number, preHeight?: number): Promise<FaceBox[]> {
  const { tensor, width, height, scaleX, scaleY } = await bufferToRgbTensor(imageBuffer, preWidth, preHeight);
  console.log(`[FaceWorker:COCO-SSD] Running inference on ${width}x${height}...`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let predictions: any[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    predictions = await personModel.detect(tensor);
  } finally {
    // Always dispose — even if detect() throws — to avoid tensor memory leaks.
    tensor.dispose();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const persons = predictions.filter((p: any) => PERSON_CLASSES.has(p.class) && p.score >= 0.4);
  if (persons.length === 0) return [];

  console.log(`[FaceWorker:COCO-SSD] ${persons.length} person(s) above threshold.`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return persons.map((p: any): FaceBox => {
    const [x, y, w, h] = (p.bbox as [number, number, number, number]).map(
      (v, idx) => v * (idx % 2 === 0 ? scaleX : scaleY),
    );
    const headH = Math.round(h * 0.4);
    return {
      topLeft: [Math.max(0, Math.round(x)), Math.max(0, Math.round(y))],
      bottomRight: [
        Math.min(Math.round(x + w), Math.round(width * scaleX)),
        Math.min(Math.round(y + headH), Math.round(height * scaleY)),
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Worker message handler
// ---------------------------------------------------------------------------

async function handleRequest(req: WorkerRequest): Promise<FaceBox[]> {
  await loadModels();
  const imageBuffer = Buffer.from(req.buffer);

  const faces = await detectFaces(imageBuffer, req.width, req.height);
  if (faces.length > 0) {
    const cx = Math.round(faces.reduce((s, f) => s + (f.topLeft[0] + f.bottomRight[0]) / 2, 0) / faces.length);
    const cy = Math.round(faces.reduce((s, f) => s + (f.topLeft[1] + f.bottomRight[1]) / 2, 0) / faces.length);
    console.log(`[FaceWorker] MediaPipe | Boxes: ${faces.length} | Focal: (${cx}, ${cy})`);
    return faces;
  }

  console.log("[FaceWorker] No faces → COCO-SSD fallback...");
  const persons = await detectPersons(imageBuffer, req.width, req.height);
  if (persons.length > 0) {
    const cx = Math.round(persons.reduce((s, f) => s + (f.topLeft[0] + f.bottomRight[0]) / 2, 0) / persons.length);
    const cy = Math.round(persons.reduce((s, f) => s + (f.topLeft[1] + f.bottomRight[1]) / 2, 0) / persons.length);
    console.log(`[FaceWorker] COCO-SSD | Boxes: ${persons.length} | Focal: (${cx}, ${cy})`);
    return persons;
  }

  console.log("[FaceWorker] No faces or persons detected.");
  return [];
}

// Bun Worker API: self.onmessage
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    const faces = await handleRequest(req);
    (self as unknown as Worker).postMessage({ id: req.id, faces } satisfies WorkerResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
