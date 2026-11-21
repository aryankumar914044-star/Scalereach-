FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    PORT=7860 \
    WHISPER_MODEL_SIZE=base \
    WHISPER_DEVICE=cpu \
    WHISPER_COMPUTE_TYPE=int8

# Install FFmpeg (with libass/libx264/libfreetype), Liberation fonts for .ass captions,
# and OpenCV/MediaPipe system libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-liberation \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user required by Hugging Face Spaces (UID 1000)
RUN useradd -m -u 1000 user

WORKDIR /app

# Install exact ScaleReach core stack dependencies
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir \
    "fastapi>=0.115.0" \
    "uvicorn[standard]>=0.32.0" \
    "pydantic>=2.9.0" \
    "yt-dlp>=2024.10.22" \
    "faster-whisper>=1.0.3" \
    "google-genai>=1.0.0" \
    "mediapipe>=0.10.14,<0.10.22" \
    "opencv-python-headless>=4.10.0.84"

# Copy application code and prepare writable temp/outputs/cache directories
COPY --chown=user:user app.py /app/app.py
RUN mkdir -p /app/temp/downloads /app/temp/audio /app/temp/reframed /app/temp/jobs /app/outputs /home/user/.cache \
    && chown -R user:user /app /home/user

USER user
ENV HOME=/home/user \
    PATH="/home/user/.local/bin:${PATH}"

EXPOSE 7860

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
