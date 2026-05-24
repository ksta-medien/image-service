/**
 * Face detection Worker thread — ONNX Runtime / UltraFace edition.
 *
 * Replaces the previous TensorFlow.js + MediaPipe + COCO-SSD stack with a
 * single ~1 MB UltraFace-Slim-320 ONNX model (~10–50 ms inference vs 100–500 ms).
 *
 * Protocol (via postMessage) — unchanged from the TF.js version:
 *   Main → Worker:  { id: number; buffer: ArrayBuffer; width?: number; height?: number }
 *   Worker → Main:  { id: number; faces: FaceBox[] }   — success
 *                   { id: number; error: string }       — failure
 *
 * Primary model: UltraFace (ultraface-slim-320.onnx, ~1.1 MB)
 *   Input  "input"  float32 [1, 3, 240, 320]  — RGB, normalised (px − 127) / 128
 *   Output "scores" float32 [1, N, 2]          — [bg_prob, face_prob] per anchor
 *   Output "boxes"  float32 [1, N, 4]          — [x1, y1, x2, y2] normalised 0-1
 *
 * Fallback model: MoveNet Lightning (movenet-lightning.onnx, ~5 MB)
 *   Used when UltraFace finds no faces (person turned away, full-body shot, etc.)
 *   Input  [0]      float32 [1, 192, 192, 3]  — RGB NHWC, range 0-255
 *   Output [0]      float32 [1, 1, 17, 3]     — [y, x, confidence] per keypoint
 *   Keypoint priority: nose/ears → shoulders → hips
 *   Falls back to entropy cropping if no confident keypoints found.
 */

import sharp from "sharp";
import * as ort from "onnxruntime-node";
import { join } from "path";

export interface FaceBox {
  topLeft: [number, number];
  bottomRight: [number, number];
}

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
// Config
// ---------------------------------------------------------------------------

const MODEL_INPUT_W = 320;
const MODEL_INPUT_H = 240;
const CONF_THRESHOLD = parseFloat(process.env.FACE_CONF_THRESHOLD ?? "0.65");
const IOU_THRESHOLD = parseFloat(process.env.FACE_IOU_THRESHOLD ?? "0.4");

// Model paths: prefer explicit env vars, fall back to <cwd>/models/
const MODEL_PATH =
  process.env.FACE_MODEL_PATH ??
  join(process.cwd(), "models", "ultraface-slim-320.onnx");

const POSE_MODEL_PATH =
  process.env.POSE_MODEL_PATH ??
  join(process.cwd(), "models", "movenet-lightning.onnx");

// ---------------------------------------------------------------------------
// ONNX sessions — lazy singletons
// ---------------------------------------------------------------------------

let session: ort.InferenceSession | null = null;
let sessionLoading: Promise<void> | null = null;

async function loadModel(): Promise<void> {
  if (session) return;
  if (sessionLoading) {
    await sessionLoading;
    return;
  }
  sessionLoading = (async () => {
    console.log(`[FaceWorker] Loading UltraFace ONNX model from ${MODEL_PATH}...`);
    session = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      // Restrict to 1 intra-op thread per worker; the pool in face-detector.ts
      // already controls overall parallelism.
      intraOpNumThreads: 1,
    });
    console.log("[FaceWorker] UltraFace model ready.");
  })().catch((err) => {
    // Clear sentinel so the next call can retry.
    sessionLoading = null;
    session = null;
    throw err;
  });
  await sessionLoading;
}

let poseSession: ort.InferenceSession | null = null;
let poseSessionLoading: Promise<void> | null = null;
// Latched true on first load failure so we never retry a missing model file.
let poseModelUnavailable = false;

async function loadPoseModel(): Promise<void> {
  if (poseSession || poseModelUnavailable) return;
  if (poseSessionLoading) {
    await poseSessionLoading;
    return;
  }
  poseSessionLoading = (async () => {
    console.log(`[FaceWorker] Loading MoveNet ONNX model from ${POSE_MODEL_PATH}...`);
    poseSession = await ort.InferenceSession.create(POSE_MODEL_PATH, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      intraOpNumThreads: 1,
    });
    console.log("[FaceWorker] MoveNet model ready.");
  })().catch((err) => {
    poseSessionLoading = null;
    poseModelUnavailable = true;
    console.warn(`[FaceWorker] Pose model unavailable (${err.message}) — person fallback disabled.`);
  });
  await poseSessionLoading;
}

// ---------------------------------------------------------------------------
// Pre-processing: image → NCHW float32 tensor
// ---------------------------------------------------------------------------

async function preprocess(imageBuffer: Buffer): Promise<Float32Array> {
  const { data } = await sharp(imageBuffer)
    .removeAlpha()
    .resize(MODEL_INPUT_W, MODEL_INPUT_H, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data);
  const float32 = new Float32Array(MODEL_INPUT_W * MODEL_INPUT_H * 3);
  const channelSize = MODEL_INPUT_W * MODEL_INPUT_H;

  // HWC uint8 → CHW float32, normalise: (pixel − 127.0) / 128.0
  for (let i = 0; i < channelSize; i++) {
    float32[i]                   = (pixels[i * 3]     - 127.0) / 128.0; // R
    float32[channelSize + i]     = (pixels[i * 3 + 1] - 127.0) / 128.0; // G
    float32[channelSize * 2 + i] = (pixels[i * 3 + 2] - 127.0) / 128.0; // B
  }
  return float32;
}

// ---------------------------------------------------------------------------
// NMS (non-maximum suppression)
// ---------------------------------------------------------------------------

function iou(a: Float32Array | number[], b: Float32Array | number[]): number {
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]);
  const iy2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter === 0) return 0;
  const aArea = (a[2] - a[0]) * (a[3] - a[1]);
  const bArea = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (aArea + bArea - inter);
}

function nms(
  boxes: number[][],
  scores: number[],
  iouThreshold: number,
): number[] {
  // Sort descending by score
  const order = scores
    .map((s, i) => [s, i] as [number, number])
    .sort((a, b) => b[0] - a[0])
    .map(([, i]) => i);

  const suppressed = new Uint8Array(boxes.length);
  const keep: number[] = [];

  for (const i of order) {
    if (suppressed[i]) continue;
    keep.push(i);
    for (const j of order) {
      if (i === j || suppressed[j]) continue;
      if (iou(boxes[i], boxes[j]) > iouThreshold) suppressed[j] = 1;
    }
  }
  return keep;
}

// ---------------------------------------------------------------------------
// MoveNet pose detection — upper-body focal point
// ---------------------------------------------------------------------------

const POSE_INPUT_SIZE = 192; // MoveNet Lightning native resolution
const POSE_SCORE_THRESHOLD = parseFloat(
  process.env.POSE_SCORE_THRESHOLD ?? "0.25",
);

// COCO-order keypoint indices used for focal point priority.
// Try head first (facing camera), then shoulders (turned sideways/away), then hips.
const POSE_PRIORITY_GROUPS = [
  [0, 3, 4],   // nose, left_ear, right_ear
  [5, 6],      // left_shoulder, right_shoulder
  [11, 12],    // left_hip, right_hip
] as const;

async function runPoseDetection(
  imageBuffer: Buffer,
  origWidth: number,
  origHeight: number,
): Promise<FaceBox[]> {
  await loadPoseModel();
  if (!poseSession) return []; // model file missing — skip gracefully

  // Resize to 192×192, keep as uint8 → float32 in [0, 255] (MoveNet NHWC)
  const { data } = await sharp(imageBuffer)
    .removeAlpha()
    .resize(POSE_INPUT_SIZE, POSE_INPUT_SIZE, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data);
  const float32 = new Float32Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) float32[i] = pixels[i];

  // Input name and output name are read from the session to handle any
  // tf2onnx conversion variant (name differs across conversion tools).
  const inputName  = poseSession.inputNames[0];
  const outputName = poseSession.outputNames[0];
  const inputTensor = new ort.Tensor("float32", float32, [
    1, POSE_INPUT_SIZE, POSE_INPUT_SIZE, 3,
  ]);

  const results = await poseSession.run({ [inputName]: inputTensor });
  // Output shape: [1, 1, 17, 3] — values are [y_norm, x_norm, score]
  const outputData = results[outputName].data as Float32Array;

  // Find the highest-priority group that has at least one confident keypoint
  for (const group of POSE_PRIORITY_GROUPS) {
    const valid = group
      .map((i) => ({
        x: outputData[i * 3 + 1] * origWidth,
        y: outputData[i * 3]     * origHeight,
        score: outputData[i * 3 + 2],
      }))
      .filter((kp) => kp.score >= POSE_SCORE_THRESHOLD);

    if (valid.length === 0) continue;

    const fx = valid.reduce((s, kp) => s + kp.x, 0) / valid.length;
    const fy = valid.reduce((s, kp) => s + kp.y, 0) / valid.length;

    // Return a small box centered on the focal point.
    // Only the center matters — computeFaceCenter() uses box midpoints.
    const half = Math.round(Math.min(origWidth, origHeight) * 0.08);
    const result: FaceBox = {
      topLeft: [
        Math.max(0, Math.round(fx - half)),
        Math.max(0, Math.round(fy - half)),
      ],
      bottomRight: [
        Math.min(origWidth,  Math.round(fx + half)),
        Math.min(origHeight, Math.round(fy + half)),
      ],
    };

    const groupName = group === POSE_PRIORITY_GROUPS[0]
      ? "head" : group === POSE_PRIORITY_GROUPS[1] ? "shoulders" : "hips";
    console.log(
      `[FaceWorker] MoveNet | Focal: (${Math.round(fx)}, ${Math.round(fy)}) via ${groupName}`,
    );
    return [result];
  }

  console.log("[FaceWorker] MoveNet | No confident keypoints.");
  return [];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

async function runDetection(
  imageBuffer: Buffer,
  origWidth: number,
  origHeight: number,
): Promise<FaceBox[]> {
  const float32 = await preprocess(imageBuffer);
  const inputTensor = new ort.Tensor("float32", float32, [
    1,
    3,
    MODEL_INPUT_H,
    MODEL_INPUT_W,
  ]);

  const results = await session!.run({ input: inputTensor });
  const scoresData = results["scores"].data as Float32Array;
  const boxesData  = results["boxes"].data  as Float32Array;

  // Number of anchors is dynamic — read from the output shape.
  const numAnchors = results["scores"].dims[1] as number;

  const candidateBoxes: number[][] = [];
  const candidateScores: number[] = [];

  for (let i = 0; i < numAnchors; i++) {
    const faceProb = scoresData[i * 2 + 1];
    if (faceProb < CONF_THRESHOLD) continue;
    candidateBoxes.push([
      boxesData[i * 4],
      boxesData[i * 4 + 1],
      boxesData[i * 4 + 2],
      boxesData[i * 4 + 3],
    ]);
    candidateScores.push(faceProb);
  }

  if (candidateBoxes.length === 0) return [];

  const kept = nms(candidateBoxes, candidateScores, IOU_THRESHOLD);

  // Normalised [0,1] coordinates → original image pixel coordinates
  return kept.map((idx) => {
    const [x1, y1, x2, y2] = candidateBoxes[idx];
    return {
      topLeft: [
        Math.max(0, Math.round(x1 * origWidth)),
        Math.max(0, Math.round(y1 * origHeight)),
      ] as [number, number],
      bottomRight: [
        Math.min(origWidth,  Math.round(x2 * origWidth)),
        Math.min(origHeight, Math.round(y2 * origHeight)),
      ] as [number, number],
    };
  });
}

// ---------------------------------------------------------------------------
// Worker message handler
// ---------------------------------------------------------------------------

async function handleRequest(req: WorkerRequest): Promise<FaceBox[]> {
  await loadModel();

  const imageBuffer = Buffer.from(req.buffer);

  const meta =
    req.width === undefined || req.height === undefined
      ? await sharp(imageBuffer).metadata()
      : null;
  const origWidth  = req.width  ?? meta?.width  ?? MODEL_INPUT_W;
  const origHeight = req.height ?? meta?.height ?? MODEL_INPUT_H;

  const faces = await runDetection(imageBuffer, origWidth, origHeight);

  if (faces.length > 0) {
    const cx = Math.round(
      faces.reduce((s, f) => s + (f.topLeft[0] + f.bottomRight[0]) / 2, 0) /
        faces.length,
    );
    const cy = Math.round(
      faces.reduce((s, f) => s + (f.topLeft[1] + f.bottomRight[1]) / 2, 0) /
        faces.length,
    );
    console.log(`[FaceWorker] UltraFace | Boxes: ${faces.length} | Focal: (${cx}, ${cy})`);
    return faces;
  }

  // No faces found — try MoveNet pose detection to handle turned-away persons.
  console.log("[FaceWorker] No faces → MoveNet pose fallback...");
  return runPoseDetection(imageBuffer, origWidth, origHeight);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    const faces = await handleRequest(req);
    (self as unknown as Worker).postMessage(
      { id: req.id, faces } satisfies WorkerResponse,
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
