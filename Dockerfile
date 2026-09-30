FROM node:22-slim

# System deps (FFmpeg/ffprobe come from the ffmpeg-static npm packages; Edge TTS is pure Node)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests and install node dependencies
COPY package*.json ./
RUN npm ci

# Copy source code and build TypeScript
COPY . .
RUN npm run build

EXPOSE 10000

ENV NODE_ENV=production
ENV PORT=10000

CMD ["npm", "start"]
