FROM node:20-slim AS base

# Install dependencies for sharp (image processing library)
# Including support for AVIF, WebP, JPEG, PNG
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libvips-dev \
    libvips-tools \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

# Install dependencies
COPY package.json bun.lockb ./

# Install dependencies with npm to ensure sharp is properly built
RUN npm install --production

# Copy source code
COPY . .

# Expose the port Cloud Run expects
EXPOSE 8080

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Run the application
CMD ["bun", "run", "index.ts"]
