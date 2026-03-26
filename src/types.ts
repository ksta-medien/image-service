export type ImageFormat = 'avif' | 'jpg' | 'jpeg' | 'webp' | 'png';
export type FitMode = 'crop' | 'cover' | 'fill' | 'scale';
export type CropGravity = 'faces' | 'entropy' | 'faces,entropy' | 'entropy,faces';

export interface ImageProcessingParams {
  w?: number;           // width
  h?: number;           // height
  fm?: ImageFormat;     // format
  q?: number;           // quality
  fit?: FitMode;        // fit mode
  ar?: string;          // aspect ratio (e.g., "16:9", "1:1")
  rect?: string;        // rectangle crop (x,y,w,h)
  crop?: CropGravity;   // crop gravity
}

export interface ParsedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ParsedAspectRatio {
  width: number;
  height: number;
}
