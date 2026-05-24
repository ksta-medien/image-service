FROM node:20-slim AS base

# Runtime deps for Sharp (libvips) and curl for model download
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libvips-dev \
    libvips-tools \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

# Install Node/Bun dependencies
COPY package.json bun.lockb ./
RUN npm install --production

# Download UltraFace ONNX model (~1.1 MB) during build so the container is self-contained
COPY scripts/download-models.sh scripts/
RUN bash scripts/download-models.sh

# Copy source code
COPY . .

# Expose the port Cloud Run expects
EXPOSE 8080

ENV NODE_ENV=production
ENV PORT=8080

CMD ["bun", "run", "index.ts"]
