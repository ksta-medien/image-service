import sharp from "sharp";

/**
 * Bounding box einer erkannten Gesichtsregion (in Pixeln, relativ zum Eingabebild).
 */
export interface FaceBox {
  topLeft: [number, number];
  bottomRight: [number, number];
}

/**
 * Berechnet das Zentrum (x, y) aller erkannten Gesichter als gewichteten Mittelpunkt.
 * Gibt null zurück wenn keine Gesichter gefunden wurden.
 */
export function computeFaceCenter(
  faces: FaceBox[],
  imageWidth: number,
  imageHeight: number
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
 * Das Ergebnis kann direkt als Sharp `.extract()` Region verwendet werden.
 * Das nachfolgende `.resize()` skaliert dann nur noch – kein erneutes Cropping.
 *
 * Falls targetW oder targetH fehlt, wird null zurückgegeben (Fallback auf Sharp-Strategie).
 */
export function computeFocalCrop(
  imgW: number,
  imgH: number,
  targetW: number | undefined,
  targetH: number | undefined,
  fx: number,
  fy: number
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
export class FaceDetector {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static model: any = null;
  private static loading: Promise<void> | null = null;

  /**
   * Lädt das BlazeFace-Modell (einmalig, gecacht).
   */
  static async load(): Promise<void> {
    if (FaceDetector.model) return;

    if (FaceDetector.loading) {
      await FaceDetector.loading;
      return;
    }

    FaceDetector.loading = (async () => {
      console.log("[FaceDetector] Loading BlazeFace model (WASM backend)...");

      // WASM backend registrieren
      const tf = await import("@tensorflow/tfjs-core");
      await import("@tensorflow/tfjs-backend-wasm");
      await tf.setBackend("wasm");
      await tf.ready();

      const blazeface = await import("@tensorflow-models/blazeface");
      FaceDetector.model = await blazeface.load();

      console.log("[FaceDetector] Model loaded successfully.");
    })();

    await FaceDetector.loading;
  }

  /**
   * Erkennt Gesichter im übergebenen Bild-Buffer.
   * Gibt die Bounding Boxes zurück, oder [] wenn keine gefunden wurden.
   *
   * Fallback auf [] bei Fehlern (Service bleibt stabil).
   */
  static async detect(imageBuffer: Buffer): Promise<FaceBox[]> {
    try {
      await FaceDetector.load();

      const tf = await import("@tensorflow/tfjs-core");

      // Sharp → unkomprimierter RGB-Buffer (BlazeFace erwartet RGB-Tensor)
      const { data, info } = await sharp(imageBuffer)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const tensor = tf.tensor3d(new Uint8Array(data), [
        info.height,
        info.width,
        3,
      ]);

      // returnTensors: false → gibt plain JS-Objekte zurück
      const predictions = await FaceDetector.model.estimateFaces(
        tensor,
        false
      );

      tensor.dispose();

      if (!predictions || predictions.length === 0) {
        console.log("[FaceDetector] No faces detected.");
        return [];
      }

      console.log(`[FaceDetector] ${predictions.length} face(s) detected.`);

      return predictions.map(
        (p: {
          topLeft: [number, number] | Float32Array;
          bottomRight: [number, number] | Float32Array;
        }) => ({
          topLeft: [
            Math.round(
              Array.isArray(p.topLeft) ? p.topLeft[0] : p.topLeft[0]
            ),
            Math.round(
              Array.isArray(p.topLeft) ? p.topLeft[1] : p.topLeft[1]
            ),
          ] as [number, number],
          bottomRight: [
            Math.round(
              Array.isArray(p.bottomRight)
                ? p.bottomRight[0]
                : p.bottomRight[0]
            ),
            Math.round(
              Array.isArray(p.bottomRight)
                ? p.bottomRight[1]
                : p.bottomRight[1]
            ),
          ] as [number, number],
        })
      );
    } catch (err) {
      console.error("[FaceDetector] Detection failed, falling back:", err);
      return [];
    }
  }

  /**
   * Gibt true zurück wenn das Modell bereits geladen ist.
   */
  static isLoaded(): boolean {
    return FaceDetector.model !== null;
  }
}
