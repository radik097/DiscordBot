FROM nvidia/cuda:12.3.2-cudnn9-runtime-ubuntu22.04

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /worker

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg libspeexdsp1 curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip3 install -r requirements.txt

COPY app.py ./

HEALTHCHECK --interval=30s --timeout=10s --start-period=600s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/health || exit 1

CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
