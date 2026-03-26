FROM oven/bun:1-alpine AS base

# Install dependencies for sharp (image processing library)
# Including support for AVIF, WebP, JPEG, PNG
RUN apk add --no-cache \
    libc6-compat \
    python3 \
    make \
    g++ \
    vips-dev \
    vips-heif \
    libheif

WORKDIR /app

# Install dependencies
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# Copy source code
COPY . .

# Expose the port Cloud Run expects
EXPOSE 8080

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Run the application
CMD ["bun", "run", "index.ts"]
