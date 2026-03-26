# imgx-clone

A high-performance image processing service built with Bun, TypeScript, and Sharp. Designed to replace imgx with full compatibility for Nuxt Image integration and optimized for deployment on Google Cloud Run.

## Features

- Fast image processing with Sharp
- Support for modern formats (AVIF, WebP, JPEG, PNG)
- Smart cropping with face detection and entropy analysis
- Aspect ratio handling
- Source rectangle extraction
- Quality optimization
- Direct Google Cloud Storage bucket integration
- Path-based routing (no need for `url` parameter)
- Cloud Run ready with automatic scaling
- CI/CD with GitHub Actions

## Query Parameters

The service supports the following 9 query parameters:

| Parameter | Description | Example Values |
|-----------|-------------|----------------|
| `url` | Source image URL (required) | `https://example.com/image.jpg` |
| `w` | Output width in pixels | `800`, `1920` |
| `h` | Output height in pixels | `600`, `1080` |
| `fm` | Output format | `avif`, `webp`, `jpg`, `png` |
| `q` | Quality (1-100) | `80`, `90`, `100` |
| `fit` | Fit mode | `crop`, `cover`, `fill`, `scale` |
| `ar` | Aspect ratio | `16:9`, `1:1`, `2:1` |
| `rect` | Source rectangle crop (x,y,w,h) | `100,100,500,500` |
| `crop` | Crop gravity | `faces`, `entropy`, `faces,entropy` |

### Fit Modes

- **crop/cover**: Crops the image to fill the dimensions completely
- **fill/scale**: Scales the image to fit within dimensions (may add padding)

### Crop Gravity

- **faces**: Focuses on detected faces when cropping
- **entropy**: Focuses on areas with highest detail/contrast
- **faces,entropy**: Combines both strategies

## Usage Examples

### Path-based routing (recommended for GCS bucket)

The service automatically resolves paths to your configured Google Cloud Storage bucket:

```
GET /2026/03/25/bf2407b1-1998-4fdb-9243-c92d05069698.jpeg?q=75&rect=0,46,4000,2250&w=2000&h=1126&fm=avif
```

This will fetch from:
```
https://storage.cloud.google.com/livingdocs-image-live/2026/03/25/bf2407b1-1998-4fdb-9243-c92d05069698.jpeg
```

### More examples

**Basic resize:**
```
GET /2026/03/25/image.jpg?w=800&h=600
```

**Convert to WebP with quality:**
```
GET /2026/03/25/image.jpg?w=800&fm=webp&q=85
```

**Crop to aspect ratio with smart cropping:**
```
GET /2026/03/25/image.jpg?ar=16:9&w=1920&crop=faces,entropy
```

**Extract region then resize:**
```
GET /2026/03/25/image.jpg?rect=100,100,500,500&w=400&h=400
```

### Legacy URL parameter method

You can also use the explicit URL parameter (supports both full URLs and paths):

```
GET /image?url=2026/03/25/image.jpg&w=800&fm=webp
GET /image?url=https://example.com/photo.jpg&w=800&h=600
```

### Proxy (no processing)
```
GET /proxy?url=2026/03/25/image.jpg
```

## Nuxt Image Integration

Configure Nuxt Image to use imgx-clone as a provider:

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  image: {
    provider: 'imgx',
    providers: {
      imgx: {
        baseURL: 'https://your-service.run.app'
      }
    }
  }
})
```

Then use paths directly in your components:

```vue
<template>
  <NuxtImg 
    src="/2026/03/25/bf2407b1-1998-4fdb-9243-c92d05069698.jpeg"
    width="2000"
    height="1126"
    format="avif"
    quality="75"
    fit="cover"
  />
</template>
```

## Local Development

### Prerequisites

- [Bun](https://bun.sh) v1.1.0 or higher
- Docker (optional, for container testing)

### Install dependencies

```bash
bun install
```

### Run locally

```bash
bun run index.ts
```

The service will start on `http://localhost:8080`

### Test the service

```bash
# Health check
curl http://localhost:8080/health

# Process an image from GCS bucket (using path)
curl "http://localhost:8080/2026/03/25/test.jpg?w=400&fm=webp&q=85" -o output.webp

# Process an external image (using URL parameter)
curl "http://localhost:8080/image?url=https://example.com/test.jpg&w=400&fm=webp&q=85" -o output.webp
```

## Docker

### Build

```bash
docker build -t imgx-clone .
```

### Run

```bash
docker run -p 8080:8080 imgx-clone
```

## Deployment to Cloud Run

### Prerequisites

1. Google Cloud account with billing enabled
2. gcloud CLI installed and configured
3. GitHub repository secrets configured:
   - `GCP_PROJECT_ID`: Your Google Cloud project ID
   - `GCP_SA_KEY`: Service account key JSON with Cloud Run and Container Registry permissions

### Manual Deployment

```bash
# Build and push
gcloud builds submit --tag gcr.io/PROJECT_ID/imgx-clone

# Deploy with GCS bucket configuration
gcloud run deploy imgx-clone \
  --image gcr.io/PROJECT_ID/imgx-clone \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --set-env-vars="GCS_BUCKET_BASE_URL=https://storage.cloud.google.com/livingdocs-image-live"
```

### Automated CI/CD

The project includes a GitHub Actions workflow that automatically:

1. Runs tests on every push and PR
2. Builds and deploys to Cloud Run on pushes to `main`

Configure the following secrets in your GitHub repository:
- `GCP_PROJECT_ID`
- `GCP_SA_KEY`

## Configuration

Environment variables:

- `PORT`: Server port (default: 8080)
- `NODE_ENV`: Environment (production/development)
- `GCS_BUCKET_BASE_URL`: Base URL for Google Cloud Storage bucket (default: `https://storage.cloud.google.com/livingdocs-image-live`)

## Performance

- Built with Bun for maximum performance
- Sharp for fast native image processing
- Efficient caching headers for CDN integration
- Scales automatically on Cloud Run (0 to 10 instances)

## API Endpoints

### `GET /{path}.{ext}`

**Path-based image processing (recommended)**. Automatically resolves paths to the configured GCS bucket.

**Example**: `GET /2026/03/25/image.jpeg?w=800&fm=avif&q=75`

**Query Parameters**: All 9 processing parameters (w, h, fm, q, fit, ar, rect, crop)

**Response**: Processed image binary with appropriate `Content-Type` header

### `GET /image`

**URL-based image processing**. Supports both full URLs and bucket paths via `url` parameter.

**Example**: `GET /image?url=2026/03/25/image.jpeg&w=800`

**Query Parameters**: `url` (required) plus all 9 processing parameters

**Response**: Processed image binary with appropriate `Content-Type` header

### `GET /proxy`

Image proxy without processing. Useful for simple URL proxying.

**Query Parameters**: `url` (required, can be path or full URL)

**Response**: Original image binary

### `GET /health`

Health check endpoint.

**Response**: `{ "status": "ok", "timestamp": "...", "bucket": "..." }`

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.
