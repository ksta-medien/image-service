import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { ImageProcessor } from './image-processor';
import type { ImageProcessingParams } from './types';

const app = new Hono();

// Configuration
const GCS_BUCKET_BASE_URL = process.env.GCS_BUCKET_BASE_URL ||
  'https://storage.cloud.google.com/livingdocs-image-live';

/**
 * Build full GCS URL from path
 */
function buildImageUrl(pathOrUrl: string): string {
  // If it's already a full URL, return as-is
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    return pathOrUrl;
  }

  // Remove leading slash if present
  const cleanPath = pathOrUrl.startsWith('/') ? pathOrUrl.slice(1) : pathOrUrl;

  // Build full GCS URL
  return `${GCS_BUCKET_BASE_URL}/${cleanPath}`;
}

// Middleware
app.use('*', logger());
app.use('*', cors());

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    bucket: GCS_BUCKET_BASE_URL
  });
});

// Main image processing endpoint - supports both path and URL
app.get('/:path{.+\\.(jpg|jpeg|png|webp|avif)}', async (c) => {
  try {
    // Get the path from URL
    const imagePath = c.req.param('path');

    // Parse image processing parameters
    const params: ImageProcessingParams = {
      w: c.req.query('w') ? parseInt(c.req.query('w')!, 10) : undefined,
      h: c.req.query('h') ? parseInt(c.req.query('h')!, 10) : undefined,
      fm: c.req.query('fm') as ImageProcessingParams['fm'],
      q: c.req.query('q') ? parseInt(c.req.query('q')!, 10) : undefined,
      fit: c.req.query('fit') as ImageProcessingParams['fit'],
      ar: c.req.query('ar'),
      rect: c.req.query('rect'),
      crop: c.req.query('crop') as ImageProcessingParams['crop']
    };

    // Validate quality parameter
    if (params.q !== undefined && (params.q < 1 || params.q > 100)) {
      return c.json({ error: 'Quality must be between 1 and 100' }, 400);
    }

    // Build full image URL
    const imageUrl = buildImageUrl(imagePath);
    console.log(`Fetching image from: ${imageUrl}`);

    // Fetch the source image
    let imageBuffer: Buffer;
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        console.error(`Failed to fetch image: ${response.status} ${response.statusText} from ${imageUrl}`);
        return c.json({
          error: `Failed to fetch image: ${response.statusText}`,
          url: imageUrl,
          status: response.status
        }, 502);
      }
      const arrayBuffer = await response.arrayBuffer();
      imageBuffer = Buffer.from(arrayBuffer);
      console.log(`Successfully fetched image: ${imageBuffer.length} bytes`);
    } catch (fetchError) {
      console.error(`Fetch error for ${imageUrl}:`, fetchError);
      return c.json({
        error: `Failed to fetch image: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`,
        url: imageUrl
      }, 502);
    }

    // Process the image
    try {
      const processor = new ImageProcessor(imageBuffer);
      const processedImage = await processor.process(params);
      console.log(`Successfully processed image: ${processedImage.length} bytes, format: ${params.fm || 'jpg'}`);

      // Determine content type
      const contentType = ImageProcessor.getMimeType(params.fm);

      // Set caching headers
      c.header('Content-Type', contentType);
      c.header('Cache-Control', 'public, max-age=31536000, immutable');

      return c.body(processedImage as unknown as string);
    } catch (processingError) {
      console.error('Image processing error:', processingError);
      console.error('Processing params:', JSON.stringify(params));
      console.error('Buffer size:', imageBuffer.length);
      return c.json({
        error: `Image processing failed: ${processingError instanceof Error ? processingError.message : 'Unknown error'}`,
        params: params
      }, 500);
    }
  } catch (error) {
    console.error('Unexpected error:', error);
    return c.json({
      error: `Unexpected error: ${error instanceof Error ? error.message : 'Unknown error'}`
    }, 500);
  }
});

// Legacy endpoint with explicit URL parameter
app.get('/image', async (c) => {
  try {
    // Get source URL from query parameter
    const sourceUrl = c.req.query('url');
    if (!sourceUrl) {
      return c.json({ error: 'Missing "url" parameter' }, 400);
    }

    // Parse image processing parameters
    const params: ImageProcessingParams = {
      w: c.req.query('w') ? parseInt(c.req.query('w')!, 10) : undefined,
      h: c.req.query('h') ? parseInt(c.req.query('h')!, 10) : undefined,
      fm: c.req.query('fm') as ImageProcessingParams['fm'],
      q: c.req.query('q') ? parseInt(c.req.query('q')!, 10) : undefined,
      fit: c.req.query('fit') as ImageProcessingParams['fit'],
      ar: c.req.query('ar'),
      rect: c.req.query('rect'),
      crop: c.req.query('crop') as ImageProcessingParams['crop']
    };

    // Validate quality parameter
    if (params.q !== undefined && (params.q < 1 || params.q > 100)) {
      return c.json({ error: 'Quality must be between 1 and 100' }, 400);
    }

    // Build full URL if it's a path
    const imageUrl = buildImageUrl(sourceUrl);

    // Fetch the source image
    let imageBuffer: Buffer;
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        return c.json({ error: `Failed to fetch image: ${response.statusText}` }, 502);
      }
      const arrayBuffer = await response.arrayBuffer();
      imageBuffer = Buffer.from(arrayBuffer);
    } catch (fetchError) {
      return c.json({
        error: `Failed to fetch image: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`
      }, 502);
    }

    // Process the image
    const processor = new ImageProcessor(imageBuffer);
    const processedImage = await processor.process(params);

    // Determine content type
    const contentType = ImageProcessor.getMimeType(params.fm);

    // Set caching headers
    c.header('Content-Type', contentType);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');

    return c.body(processedImage as unknown as string);
  } catch (error) {
    console.error('Image processing error:', error);
    return c.json({
      error: `Image processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    }, 500);
  }
});

// Proxy endpoint (no processing, just returns the image)
app.get('/proxy', async (c) => {
  try {
    const sourceUrl = c.req.query('url');
    if (!sourceUrl) {
      return c.json({ error: 'Missing "url" parameter' }, 400);
    }

    const imageUrl = buildImageUrl(sourceUrl);
    const response = await fetch(imageUrl);
    if (!response.ok) {
      return c.json({ error: `Failed to fetch image: ${response.statusText}` }, 502);
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    c.header('Content-Type', contentType);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');

    return c.body(Buffer.from(arrayBuffer) as unknown as string);
  } catch (error) {
    console.error('Proxy error:', error);
    return c.json({
      error: `Proxy failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    }, 500);
  }
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

export default app;
