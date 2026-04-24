import sharp from "sharp";

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
// Interne Modell-Singletons
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let faceModel: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let personModel: any = null;
let modelsLoading: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Inference semaphore
// ---------------------------------------------------------------------------
// TF.js WASM runs synchronously on the JS event loop. Allowing N concurrent
// inferences (where N = containerConcurrency) just serializes them in the WASM
// engine anyway, but stacks up tensor allocations and blocks the loop for
// N × inferenceTime milliseconds — causing Cloud Run to see "connection errors"
// (503). A semaphore of 1 queues excess requests rather than piling them up.
const INFERENCE_CONCURRENCY = parseInt(
  process.env.FACE_DETECTION_CONCURRENCY ?? "1",
  10,
);

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
    next(); // hand the slot to the next waiter (inferenceActive stays the same)
  } else {
    inferenceActive--;
  }
}

// Maximum milliseconds to wait for models + inference before falling back to
// the entropy strategy.  Must stay well below Cloud Run's timeoutSeconds (20 s).
const FACE_DETECTION_TIMEOUT_MS = parseInt(
  process.env.FACE_DETECTION_TIMEOUT_MS ?? "8000",
  10,
);

async function initBackend(): Promise<void> {
  const tf = await import("@tensorflow/tfjs-core");
  await import("@tensorflow/tfjs-backend-wasm");
  await import("@tensorflow/tfjs-converter");
  await tf.setBackend("wasm");
  await tf.ready();
}

/**
 * Lädt beide Modelle einmalig (gecacht).
 * - MediaPipe Face Detector (Full Range) — Stufe 1
 * - COCO-SSD — Stufe 2 (Person-Fallback)
 */
async function loadModels(): Promise<void> {
  if (faceModel && personModel) return;

  if (modelsLoading) {
    await modelsLoading;
    return;
  }

  modelsLoading = (async () => {
    console.log("[FaceDetector] Initialising WASM backend...");
    await initBackend();

    console.log(
      "[FaceDetector] Loading MediaPipe Face Detector (full range)...",
    );
    const faceDetection = await import("@tensorflow-models/face-detection");
    faceModel = await faceDetection.createDetector(
      faceDetection.SupportedModels.MediaPipeFaceDetector,
      {
        runtime: "tfjs",
        modelType: "full", // erkennt kleine, entfernte Gesichter besser als 'short'
      },
    );
    console.log("[FaceDetector] Face model ready.");

    console.log("[FaceDetector] Loading COCO-SSD (person fallback)...");
    const cocoSsd = await import("@tensorflow-models/coco-ssd");
    personModel = await cocoSsd.load({ base: "mobilenet_v2" });
    console.log("[FaceDetector] COCO-SSD ready.");
  })();

  await modelsLoading;
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: Sharp-Buffer → RGB Tensor
// ---------------------------------------------------------------------------

// Maximale Eingangsbreite fuer TensorFlow-Inferenz.
// Groessere Bilder werden proportional verkleinert bevor sie dem Modell
// uebergeben werden. Gesichtspositionen werden zurueckskaliert.
// Konfigurierbar ueber FACE_DETECTION_MAX_INPUT_WIDTH (Default: 640).
const FACE_DETECTION_MAX_INPUT_WIDTH = parseInt(
  process.env.FACE_DETECTION_MAX_INPUT_WIDTH ?? "640",
  10,
);

async function bufferToRgbTensor(imageBuffer: Buffer): Promise<{
  tensor: Awaited<
    ReturnType<(typeof import("@tensorflow/tfjs-core"))["tensor3d"]>
  >;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
}> {
  const tf = await import("@tensorflow/tfjs-core");

  // Originaldimensionen lesen ohne vollstaendiges Dekodieren
  const meta = await sharp(imageBuffer).metadata();
  const origWidth = meta.width ?? FACE_DETECTION_MAX_INPUT_WIDTH;
  const origHeight = meta.height ?? FACE_DETECTION_MAX_INPUT_WIDTH;

  // Bild auf Maximalbreite begrenzen um Inferenzzeit zu reduzieren.
  // Auf einem 4MP-Bild (2000x2000px) dauert MediaPipe ~300ms,
  // auf 640px ~60ms. Gesichter sind auch auf 640px zuverlaessig erkennbar.
  let inferenceWidth = origWidth;
  let inferenceHeight = origHeight;
  if (origWidth > FACE_DETECTION_MAX_INPUT_WIDTH) {
    const scale = FACE_DETECTION_MAX_INPUT_WIDTH / origWidth;
    inferenceWidth = FACE_DETECTION_MAX_INPUT_WIDTH;
    inferenceHeight = Math.round(origHeight * scale);
  }

  const resizePipeline = sharp(imageBuffer).removeAlpha();
  if (inferenceWidth !== origWidth) {
    resizePipeline.resize(inferenceWidth, inferenceHeight, { fit: "fill" });
  }

  const { data, info } = await resizePipeline
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    tensor: tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]),
    width: info.width,
    height: info.height,
    // Skalierungsfaktoren um erkannte Boxen auf Originalkoordinaten zurueckzurechnen
    scaleX: origWidth / info.width,
    scaleY: origHeight / info.height,
  };
}

// ---------------------------------------------------------------------------
// Stufe 1 – MediaPipe Face Detector
// ---------------------------------------------------------------------------

async function detectFaces(imageBuffer: Buffer): Promise<FaceBox[]> {
  const { tensor, width, height, scaleX, scaleY } =
    await bufferToRgbTensor(imageBuffer);
  console.log(
    `[FaceDetector:MediaPipe] Running inference on ${width}x${height} image (scaleX=${scaleX.toFixed(2)}, scaleY=${scaleY.toFixed(2)})...`,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const predictions: any[] = await faceModel.estimateFaces(tensor);
  tensor.dispose();

  if (!predictions || predictions.length === 0) {
    console.log("[FaceDetector:MediaPipe] Result: 0 faces detected.");
    return [];
  }

  console.log(
    `[FaceDetector:MediaPipe] Result: ${predictions.length} face(s) detected.`,
  );

  const boxes = predictions.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p: any, i: number): FaceBox => {
      const box = p.box ?? p.boundingBox ?? p;
      const xMin = Math.max(
        0,
        Math.round((box.xMin ?? box.topLeft?.[0] ?? 0) * scaleX),
      );
      const yMin = Math.max(
        0,
        Math.round((box.yMin ?? box.topLeft?.[1] ?? 0) * scaleY),
      );
      const w = Math.round(
        (box.width !== undefined
          ? box.width
          : box.bottomRight?.[0] !== undefined
            ? box.bottomRight[0] - (box.xMin ?? 0)
            : 0) * scaleX,
      );
      const h = Math.round(
        (box.height !== undefined
          ? box.height
          : box.bottomRight?.[1] !== undefined
            ? box.bottomRight[1] - (box.yMin ?? 0)
            : 0) * scaleY,
      );
      const result: FaceBox = {
        topLeft: [xMin, yMin],
        bottomRight: [xMin + w, yMin + h],
      };
      const score = p.score ?? p.probability ?? "n/a";
      console.log(
        `[FaceDetector:MediaPipe]   Face ${i + 1}: topLeft=(${result.topLeft}) bottomRight=(${result.bottomRight}) score=${typeof score === "number" ? score.toFixed(3) : score}`,
      );
      return result;
    },
  );

  return boxes;
}

// ---------------------------------------------------------------------------
// Stufe 2 – COCO-SSD Person-Fallback
// ---------------------------------------------------------------------------

const PERSON_CLASSES = new Set(["person"]);

async function detectPersons(imageBuffer: Buffer): Promise<FaceBox[]> {
  const { tensor, width, height, scaleX, scaleY } =
    await bufferToRgbTensor(imageBuffer);
  console.log(
    `[FaceDetector:COCO-SSD] Running inference on ${width}x${height} image...`,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const predictions: any[] = await personModel.detect(tensor);
  tensor.dispose();

  console.log(
    `[FaceDetector:COCO-SSD] Raw detections: ${predictions.length} total → ` +
      predictions
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((p: any) => `${p.class}(${p.score.toFixed(2)})`)
        .join(", ") || "(none)",
  );

  const persons = predictions.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p: any) => PERSON_CLASSES.has(p.class) && p.score >= 0.4,
  );

  if (persons.length === 0) {
    console.log(
      "[FaceDetector:COCO-SSD] Result: 0 persons above threshold (score >= 0.4).",
    );
    return [];
  }

  console.log(
    `[FaceDetector:COCO-SSD] Result: ${persons.length} person(s) above threshold.`,
  );

  return persons.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p: any, i: number): FaceBox => {
      // COCO-SSD: bbox = [x, y, width, height] - auf Originalkoordinaten skalieren
      const [x, y, w, h] = (p.bbox as [number, number, number, number]).map(
        (v, idx) => v * (idx % 2 === 0 ? scaleX : scaleY),
      );
      // Use upper 40% of person bounding box as the "head" focal region
      const headH = Math.round(h * 0.4);
      const result: FaceBox = {
        topLeft: [Math.max(0, Math.round(x)), Math.max(0, Math.round(y))],
        bottomRight: [
          Math.min(Math.round(x + w), Math.round(width * scaleX)),
          Math.min(Math.round(y + headH), Math.round(height * scaleY)),
        ],
      };
      console.log(
        `[FaceDetector:COCO-SSD]   Person ${i + 1}: score=${p.score.toFixed(3)} fullBox=[${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}] headRegion topLeft=(${result.topLeft}) bottomRight=(${result.bottomRight})`,
      );
      return result;
    },
  );
}

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------

/**
 * Kaskadierende Gesichts- und Personenerkennung:
 *
 * 1. MediaPipe Face Detector (Full Range) – erkennt Gesichter inkl. kleiner,
 *    entfernter und leicht seitlicher Aufnahmen
 * 2. COCO-SSD Person-Detector – Fallback wenn keine Gesichter erkannt wurden;
 *    verwendet den oberen Bereich der Personen-Box als Fokusregion
 *
 * Gibt [] zurück wenn weder Gesichter noch Personen gefunden werden.
 * Gibt immer [] bei Fehlern zurück (Service bleibt stabil).
 */
export class FaceDetector {
  static async load(): Promise<void> {
    await loadModels();
  }

  static async detect(imageBuffer: Buffer): Promise<FaceBox[]> {
    // Race the full detection pipeline against a hard timeout so that slow
    // model loads or queued inferences never let a request exceed Cloud Run's
    // timeoutSeconds limit.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<FaceBox[]>((resolve) => {
      timeoutHandle = setTimeout(() => {
        console.warn(
          `[FaceDetector] Detection timed out after ${FACE_DETECTION_TIMEOUT_MS} ms — falling back to entropy.`,
        );
        resolve([]);
      }, FACE_DETECTION_TIMEOUT_MS);
    });

    const detectionPromise = FaceDetector._detect(imageBuffer).finally(() => {
      clearTimeout(timeoutHandle);
    });

    return Promise.race([detectionPromise, timeoutPromise]);
  }

  /** Internal implementation — called by detect() under the timeout guard. */
  private static async _detect(imageBuffer: Buffer): Promise<FaceBox[]> {
    // Acquire inference slot — queues this call if INFERENCE_CONCURRENCY is
    // already reached, rather than stacking concurrent WASM executions.
    await acquireInference();
    try {
      await loadModels();

      console.log(
        `[FaceDetector] detect() called — buffer size: ${imageBuffer.length} bytes`,
      );

      // Stufe 1: MediaPipe Face Detector
      const faces = await detectFaces(imageBuffer);
      if (faces.length > 0) {
        const cx = Math.round(
          faces.reduce((s, f) => s + (f.topLeft[0] + f.bottomRight[0]) / 2, 0) /
            faces.length,
        );
        const cy = Math.round(
          faces.reduce((s, f) => s + (f.topLeft[1] + f.bottomRight[1]) / 2, 0) /
            faces.length,
        );
        console.log(
          `[FaceDetector] ✓ Model used: MediaPipe | Boxes: ${faces.length} | Focal point: (${cx}, ${cy})`,
        );
        return faces;
      }

      // Stufe 2: COCO-SSD Person-Fallback
      console.log(
        "[FaceDetector] → No faces found, switching to COCO-SSD person detection...",
      );
      const persons = await detectPersons(imageBuffer);
      if (persons.length > 0) {
        const cx = Math.round(
          persons.reduce(
            (s, f) => s + (f.topLeft[0] + f.bottomRight[0]) / 2,
            0,
          ) / persons.length,
        );
        const cy = Math.round(
          persons.reduce(
            (s, f) => s + (f.topLeft[1] + f.bottomRight[1]) / 2,
            0,
          ) / persons.length,
        );
        console.log(
          `[FaceDetector] ✓ Model used: COCO-SSD (person fallback) | Boxes: ${persons.length} | Focal point: (${cx}, ${cy})`,
        );
        return persons;
      }

      console.log(
        "[FaceDetector] ✗ No faces or persons detected → entropy fallback will be used.",
      );
      return [];
    } catch (err) {
      console.error("[FaceDetector] Detection error, falling back:", err);
      return [];
    } finally {
      releaseInference();
    }
  }

  static isLoaded(): boolean {
    return faceModel !== null && personModel !== null;
  }
}
