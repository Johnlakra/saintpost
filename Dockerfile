FROM node:22-slim

# Install system dependencies: FFmpeg, Python3, pip, curl, git
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Edge-TTS globally for voiceover narration
RUN pip3 install --no-cache-dir --break-system-packages edge-tts

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
