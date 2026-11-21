FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    WHISPER_MODEL_SIZE=base \
    WHISPER_DEVICE=cpu \
    WHISPER_COMPUTE_TYPE=int8 \
    MAX_CONCURRENT_JOBS=2 \
    MAX_RENDER_WORKERS=2

# System dependencies: FFmpeg, OpenCV/MediaPipe libs, curl, Node.js (for yt-dlp JS challenges), and Devanagari/Latin fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    curl \
    nodejs \
    npm \
    fontconfig \
    fonts-liberation \
    fonts-noto-core \
    fonts-noto-extra \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /app/requirements.txt

COPY . /app
RUN if [ -f /app/scripts/package.json ]; then npm --prefix /app/scripts install --omit=dev --no-audit --no-fund; fi

RUN mkdir -p /app/outputs /app/uploads /app/temp/downloads /app/temp/jobs /app/data /app/assets/backgrounds

EXPOSE 8080

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
