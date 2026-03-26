import sharp from 'sharp';
import type { Sharp, FitEnum } from 'sharp';
import type { ImageProcessingParams, ParsedRect, ParsedAspectRatio } from './types';

export class ImageProcessor {
  private sharp: Sharp;
  private originalBuffer: Buffer;

  constructor(imageBuffer: Buffer) {
    this.originalBuffer = imageBuffer;
    // Force sharp to detect the format and handle various image types
    // Don't set failOnError to false as it might hide real errors
    this.sharp = sharp(imageBuffer, {
      unlimited: true,
      sequentialRead: true
    });
  }

  /**
   * Parse rectangle string "x,y,w,h" into coordinates
   */
  private parseRect(rect: string): ParsedRect | null {
    const parts = rect.split(',').map(p => parseInt(p.trim(), 10));
    if (parts.length !== 4 || parts.some(isNaN)) {
      return null;
    }
    return {
      left: parts[0],
      top: parts[1],
      width: parts[2],
      height: parts[3]
    };
  }

  /**
   * Parse aspect ratio string "16:9" into width/height values
   */
  private parseAspectRatio(ar: string): ParsedAspectRatio | null {
    const parts = ar.split(':').map(p => parseFloat(p.trim()));
    if (parts.length !== 2 || parts.some(isNaN)) {
      return null;
    }
    return {
      width: parts[0],
      height: parts[1]
    };
  }

  /**
   * Calculate dimensions based on aspect ratio
   */
  private async calculateAspectRatioDimensions(
    ar: ParsedAspectRatio,
    targetWidth?: number,
    targetHeight?: number
  ): Promise<{ width: number; height: number }> {
    const metadata = await this.sharp.metadata();
    const originalWidth = metadata.width || 1;
    const originalHeight = metadata.height || 1;
    const aspectRatio = ar.width / ar.height;

    if (targetWidth && targetHeight) {
      // Both specified, use them
      return { width: targetWidth, height: targetHeight };
    } else if (targetWidth) {
      // Width specified, calculate height
      return { width: targetWidth, height: Math.round(targetWidth / aspectRatio) };
    } else if (targetHeight) {
      // Height specified, calculate width
      return { width: Math.round(targetHeight * aspectRatio), height: targetHeight };
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
      case 'cover':
      case 'crop':
        return 'cover'; // crops to fill the entire area
      case 'fill':
      case 'scale':
        return 'fill'; // scales without cropping, may add padding
      case 'contain':
        return 'contain';
      case 'inside':
        return 'inside';
      case 'outside':
        return 'outside';
      default:
        return 'cover';
    }
  }

  /**
   * Get sharp strategy for smart cropping
   */
  private getCropStrategy(crop?: string) {
    if (!crop) {
      return sharp.strategy.attention;
    }

    const normalized = crop.toLowerCase().replace(/\s/g, '');

    if (normalized.includes('faces') && normalized.includes('entropy')) {
      return sharp.strategy.attention; // Best of both worlds
    } else if (normalized.includes('faces')) {
      return sharp.strategy.attention; // Includes face detection
    } else if (normalized.includes('entropy')) {
      return sharp.strategy.entropy; // Focus on high entropy regions
    }

    return sharp.strategy.attention;
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
        console.log('Image metadata:', {
          format: metadata.format,
          width: metadata.width,
          height: metadata.height,
          space: metadata.space,
          channels: metadata.channels,
          hasAlpha: metadata.hasAlpha,
          size: metadata.size
        });
      } catch (metadataError) {
        console.error('Failed to read image metadata:', metadataError);
        console.error('Buffer size:', this.originalBuffer.length);
        console.error('Buffer start (hex):', this.originalBuffer.slice(0, 16).toString('hex'));
        throw new Error(`Cannot read image metadata: ${metadataError instanceof Error ? metadataError.message : 'Unknown error'}`);
      }

      // Step 1: Apply source rectangle crop if specified
      if (params.rect) {
        const rect = this.parseRect(params.rect);
        if (rect) {
          console.log('Applying rect crop:', rect);
          this.sharp = this.sharp.extract(rect);
        }
      }

      // Step 2: Handle aspect ratio
      let finalWidth = params.w;
      let finalHeight = params.h;

      if (params.ar) {
        const ar = this.parseAspectRatio(params.ar);
        if (ar) {
          const dimensions = await this.calculateAspectRatioDimensions(ar, params.w, params.h);
          finalWidth = dimensions.width;
          finalHeight = dimensions.height;
        }
      }

      // Step 3: Resize with fit mode
      if (finalWidth || finalHeight) {
        const fitMode = this.getFitMode(params.fit || 'crop');
        const strategy = this.getCropStrategy(params.crop);

        this.sharp = this.sharp.resize(finalWidth, finalHeight, {
          fit: fitMode,
          position: strategy,
          withoutEnlargement: false
        });
      }

      // Step 4: Convert format if specified
      const format = params.fm || 'jpg';
      const quality = params.q || 80;

      switch (format.toLowerCase()) {
        case 'avif':
          this.sharp = this.sharp.avif({ quality });
          break;
        case 'webp':
          this.sharp = this.sharp.webp({ quality });
          break;
        case 'png':
          this.sharp = this.sharp.png({
            quality,
            compressionLevel: Math.round((100 - quality) / 10)
          });
          break;
        case 'jpg':
        case 'jpeg':
        default:
          this.sharp = this.sharp.jpeg({ quality });
          break;
      }

      return await this.sharp.toBuffer();
    } catch (error) {
      throw new Error(`Image processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get the MIME type for a given format
   */
  static getMimeType(format: string = 'jpg'): string {
    switch (format.toLowerCase()) {
      case 'avif':
        return 'image/avif';
      case 'webp':
        return 'image/webp';
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
      default:
        return 'image/jpeg';
    }
  }
}

