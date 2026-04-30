import sharp from "sharp";
import type { Sharp, FitEnum } from "sharp";
import type {
  ImageProcessingParams,
  ParsedRect,
  ParsedAspectRatio,
} from "./types";
import {
  FaceDetector,
  computeFaceCenter,
  computeFocalCrop,
} from "./face-detector";

export class ImageProcessor {
  private sharp: Sharp;
  private originalBuffer: Buffer;
  /** Rect that was actually applied in Step 1 (clamped, or null if none). */
  private appliedRect: { left: number; top: number; width: number; height: number } | null = null;

  constructor(imageBuffer: Buffer) {
    this.originalBuffer = imageBuffer;
    // Force sharp to detect the format and handle various image types
    // Don't set failOnError to false as it might hide real errors
    this.sharp = sharp(imageBuffer, {
      unlimited: true,
      sequentialRead: true,
    });
  }

  /**
   * Parse rectangle string "x,y,w,h" into coordinates
   */
  private parseRect(rect: string): ParsedRect | null {
    const parts = rect.split(",").map((p) => parseInt(p.trim(), 10));
    if (parts.length !== 4 || parts.some(isNaN)) {
      return null;
    }
    // Skip rect if width or height is zero — Sharp requires positive integers
    if (parts[2] <= 0 || parts[3] <= 0) {
      console.log(`Skipping rect crop with zero dimensions: ${rect}`);
      return null;
    }
    return {
      left: parts[0],
      top: parts[1],
      width: parts[2],
      height: parts[3],
    };
  }

  /**
   * Parse aspect ratio string "16:9" into width/height values
   */
  private parseAspectRatio(ar: string): ParsedAspectRatio | null {
    const parts = ar.split(":").map((p) => parseFloat(p.trim()));
    if (parts.length !== 2 || parts.some(isNaN)) {
      return null;
    }
    return {
      width: parts[0],
      height: parts[1],
    };
  }

  /**
   * Calculate dimensions based on aspect ratio.
   * Accepts pre-read metadata to avoid a redundant sharp.metadata() call.
   */
  private async calculateAspectRatioDimensions(
    ar: ParsedAspectRatio,
    targetWidth?: number,
    targetHeight?: number,
    preReadMeta?: { width?: number; height?: number },
  ): Promise<{ width: number; height: number }> {
    const meta = preReadMeta ?? (await this.sharp.metadata());
    const originalWidth = meta.width || 1;
    const originalHeight = meta.height || 1;
    const aspectRatio = ar.width / ar.height;

    if (targetWidth && targetHeight) {
      // Both specified, use them
      return { width: targetWidth, height: targetHeight };
    } else if (targetWidth) {
      // Width specified, calculate height
      return {
        width: targetWidth,
        height: Math.round(targetWidth / aspectRatio),
      };
    } else if (targetHeight) {
      // Height specified, calculate width
      return {
        width: Math.round(targetHeight * aspectRatio),
        height: targetHeight,
      };
    } else {
      // Neither specified, use original dimensions with aspect ratio
      const newHeight = Math.round(originalWidth / aspectRatio);
      return { width: originalWidth, height: newHeight };
    }
  }

  /**
   * Map fit mode to sharp's fit enum
   */
  private getFitMode(fit: string): keyof FitEnum {
    switch (fit.toLowerCase()) {
      case "cover":
      case "crop":
        return "cover"; // crops to fill the entire area
      case "fill":
      case "scale":
        return "fill"; // scales without cropping, may add padding
      case "contain":
        return "contain";
      case "inside":
        return "inside";
      case "outside":
        return "outside";
      default:
        return "cover";
    }
  }

  /**
   * Returns true if the crop parameter requests face-based cropping
   */
  private static wantsFaceCrop(crop?: string): boolean {
    return !!crop && crop.toLowerCase().includes("faces");
  }

  /**
   * Process the image with all parameters
   */
  async process(params: ImageProcessingParams): Promise<Buffer> {
    try {
      // Verify the image can be read and get metadata
      let metadata;
      try {
        metadata = await this.sharp.metadata();
        console.log("Image metadata:", {
          format: metadata.format,
          width: metadata.width,
          height: metadata.height,
          space: metadata.space,
          channels: metadata.channels,
          hasAlpha: metadata.hasAlpha,
          size: metadata.size,
        });
      } catch (metadataError) {
        console.error("Failed to read image metadata:", metadataError);
        console.error("Buffer size:", this.originalBuffer.length);
        console.error(
          "Buffer start (hex):",
          this.originalBuffer.slice(0, 16).toString("hex"),
        );
        throw new Error(
          `Cannot read image metadata: ${metadataError instanceof Error ? metadataError.message : "Unknown error"}`,
        );
      }

      // Step 1: Apply source rectangle crop if specified
      if (params.rect) {
        const rect = this.parseRect(params.rect);
        if (rect) {
          const imgW = metadata.width ?? 0;
          const imgH = metadata.height ?? 0;

          // Clamp rect to actual image bounds to avoid "bad extract area" from Sharp
          const left   = Math.max(0, Math.min(rect.left,  imgW - 1));
          const top    = Math.max(0, Math.min(rect.top,   imgH - 1));
          const width  = Math.min(rect.width,  imgW - left);
          const height = Math.min(rect.height, imgH - top);

          if (width > 0 && height > 0) {
            const clamped = { left, top, width, height };
            if (left !== rect.left || top !== rect.top || width !== rect.width || height !== rect.height) {
              console.warn(`Rect clamped from ${JSON.stringify(rect)} to ${JSON.stringify(clamped)} (image: ${imgW}x${imgH})`);
            }
            console.log("Applying rect crop:", clamped);
            // Sharp does not support extract().extract().resize() in a single
            // pipeline — libvips reorders the ops internally, producing invalid
            // coordinates for the second extract and throwing "bad extract area".
            // Flushing the rect crop to a buffer here gives subsequent operations
            // (focal-crop extract + resize) a clean pipeline to work with.
            const rectCroppedBuffer = await this.sharp.extract(clamped).toBuffer();
            this.sharp = sharp(rectCroppedBuffer, { unlimited: true, sequentialRead: true });
            this.appliedRect = clamped;
          } else {
            console.warn(`Rect skipped after clamping — zero dimensions (image: ${imgW}x${imgH}, rect: ${JSON.stringify(rect)})`);
          }
        }
      }

      // Step 2: Handle aspect ratio
      let finalWidth = params.w;
      let finalHeight = params.h;

      // When rect is set it has the highest priority: it defines both the
      // image area AND the output aspect ratio. Only w is used from the
      // request; h is always calculated from w and the rect's own AR so
      // Sharp never performs an additional cover-crop that would deviate
      // from the editorial selection.
      if (this.appliedRect) {
        const rectAR = this.appliedRect.width / this.appliedRect.height;
        if (finalWidth) {
          finalHeight = Math.round(finalWidth / rectAR);
          console.log(
            `[rect priority] Overriding h to ${finalHeight} (w=${finalWidth}, rectAR=${rectAR.toFixed(4)})`,
          );
        } else if (finalHeight) {
          // No w given — derive w from h and rect AR instead
          finalWidth = Math.round(finalHeight * rectAR);
          console.log(
            `[rect priority] Overriding w to ${finalWidth} (h=${finalHeight}, rectAR=${rectAR.toFixed(4)})`,
          );
        }
        // If neither w nor h is given, the resize step is skipped entirely
        // and the rect crop dimensions are used as-is.
      } else if (params.ar) {
        const ar = this.parseAspectRatio(params.ar);
        if (ar) {
          // If aspect ratio is specified, it takes precedence
          // Calculate height from width and aspect ratio, or vice versa.
          // Pass pre-read metadata to avoid a redundant sharp.metadata() call.
          if (params.w) {
            const dimensions = await this.calculateAspectRatioDimensions(
              ar,
              params.w,
              undefined,
              metadata,
            );
            finalWidth = dimensions.width;
            finalHeight = dimensions.height;
          } else if (params.h) {
            const dimensions = await this.calculateAspectRatioDimensions(
              ar,
              undefined,
              params.h,
              metadata,
            );
            finalWidth = dimensions.width;
            finalHeight = dimensions.height;
          } else {
            // No target w or h — derive output size from the source dimensions
            // and the requested aspect ratio.
            const dimensions = await this.calculateAspectRatioDimensions(
              ar,
              undefined,
              undefined,
              metadata,
            );
            finalWidth = dimensions.width;
            finalHeight = dimensions.height;
          }
        }
      }

      // Step 3: Resize with fit mode
      if (finalWidth || finalHeight) {
        const fitMode = this.getFitMode(params.fit || "crop");

        let position: number | string = sharp.strategy.entropy;

        console.log(
          `[ImageProcessor] crop param: "${params.crop ?? "(none)"}", wantsFaceCrop: ${ImageProcessor.wantsFaceCrop(params.crop)}`,
        );

        // Real face detection: when crop=faces and no explicit rect is set,
        // locate faces and use their centroid as a focal point for the
        // cover-crop. The region is extracted at the target aspect ratio — no
        // extra zoom.
        //
        // Face detection is intentionally skipped when rect is present:
        // the rect represents an explicit editorial crop that must be preserved
        // as-is. Modifying the cropped region via face detection would override
        // the editor's intent.
        if (ImageProcessor.wantsFaceCrop(params.crop) && !this.appliedRect) {
          try {
            // Pass pre-read metadata so bufferToRgbTensor skips a redundant
            // sharp.metadata() call on the original buffer.
            const faces = await FaceDetector.detect(this.originalBuffer, metadata);
            const center = computeFaceCenter(
              faces,
              metadata.width ?? 0,
              metadata.height ?? 0,
            );

            if (center) {
              const region = computeFocalCrop(
                metadata.width  ?? 0,
                metadata.height ?? 0,
                finalWidth,
                finalHeight,
                center.x,
                center.y,
              );

              if (region) {
                console.log(
                  "[FaceDetector] Focal-point extract region:", region,
                  `(src: ${metadata.width}x${metadata.height}, center: ${center.x},${center.y})`,
                );
                // extract() clips the image to the right AR centered on the
                // face; the following resize() only scales.
                this.sharp = this.sharp.extract(region);
              }
              // position is irrelevant after extract, but set for safety
              position = "centre";
            } else {
              // No faces found → fall back to entropy
              console.log(
                "[FaceDetector] No faces found, falling back to entropy strategy.",
              );
              position = sharp.strategy.entropy;
            }
          } catch (faceErr) {
            console.error(
              "[FaceDetector] Error during detection, falling back:",
              faceErr,
            );
          }
        } else if (this.appliedRect && ImageProcessor.wantsFaceCrop(params.crop)) {
          console.log(
            "[FaceDetector] Skipping face detection — rect param is set (editorial crop takes precedence).",
          );
        }

        this.sharp = this.sharp.resize(finalWidth, finalHeight, {
          fit: fitMode,
          position,
          withoutEnlargement: false,
        });
      }

      // Step 4: Convert format if specified
      const format = params.fm || "jpg";
      const quality = params.q || 80;

      switch (format.toLowerCase()) {
        case "avif":
          // Default libaom speed is 4, which takes 8-12 s on a 2000 px image
          // and causes Cloud Run 503s under load. Speed 6 cuts encode time to
          // ~1-2 s with a negligible file-size increase (~5 %).
          // Configurable via AVIF_SPEED env var (0 = best compression, 9 = fastest).
          this.sharp = this.sharp.avif({
            quality,
            speed: parseInt(process.env.AVIF_SPEED ?? "6", 10),
          });
          break;
        case "webp":
          this.sharp = this.sharp.webp({ quality });
          break;
        case "png":
          this.sharp = this.sharp.png({
            quality,
            compressionLevel: Math.round((100 - quality) / 10),
          });
          break;
        case "jpg":
        case "jpeg":
        default:
          this.sharp = this.sharp.jpeg({
            quality,
            progressive: true,
            // mozjpeg: false (war true) - mozjpeg kostet ~30-50ms zusaetzlich
            // und macht keinen wahrnehmbaren Unterschied bei q=70 (Standardwert).
            // Bilder werden von Akamai gecacht, daher ist Encode-Geschwindigkeit
            // wichtiger als minimale Byte-Einsparung.
            mozjpeg: false,
          });
          break;
      }

      return await this.sharp.toBuffer();
    } catch (error) {
      throw new Error(
        `Image processing failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Get the MIME type for a given format
   */
  static getMimeType(format: string = "jpg"): string {
    switch (format.toLowerCase()) {
      case "avif":
        return "image/avif";
      case "webp":
        return "image/webp";
      case "png":
        return "image/png";
      case "jpg":
      case "jpeg":
      default:
        return "image/jpeg";
    }
  }
}
