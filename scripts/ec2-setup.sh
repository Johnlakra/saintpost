#!/bin/bash
set -e

echo "🚀 Starting 1-Click SaintPost AWS EC2 Setup..."

# 1. Update OS packages and install Docker, Git, FFmpeg, Python3
if command -v dnf &> /dev/null; then
    # Amazon Linux 2023 / Fedora
    sudo dnf update -y
    sudo dnf install -y docker git ffmpeg python3 python3-pip
elif command -v apt &> /dev/null; then
    # Ubuntu / Debian
    sudo apt-get update -y
    sudo apt-get install -y docker.io docker-compose git ffmpeg python3 python3-pip
fi

# 2. Enable and start Docker service
sudo systemctl enable --now docker
sudo usermod -aG docker $USER || true

# 3. Install Edge-TTS for voiceover
pip3 install --break-system-packages edge-tts || pip3 install edge-tts

# 4. Clone SaintPost repo if not present
if [ ! -d "saintpost" ]; then
    git clone https://github.com/Johnlakra/saintpost.git
fi

cd saintpost

# 5. Create .env file if missing
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "⚠️ Please edit saintpost/.env with your API keys!"
fi

# 6. Build and Start Docker Container
echo "🐳 Building Docker Container and Starting SaintPost..."
sudo docker-compose up -d --build

echo "✅ SaintPost is now running on AWS EC2!"
echo "🔗 Health check: http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4):10000/health"
