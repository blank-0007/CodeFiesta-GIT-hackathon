# ReconAI backend — FastAPI + pdfplumber + Tesseract OCR fallback.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DATA_DIR=/data

# tesseract-ocr: OCR fallback for scanned PDF statements. curl: container healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (cached layer), then the project itself.
COPY pyproject.toml ./
COPY app ./app
RUN pip install .

# Migrations, seed/demo scripts and any bundled sample data (filtered by .dockerignore).
COPY . .

RUN chmod +x /app/docker-entrypoint.sh \
    && mkdir -p /data \
    && useradd --create-home --uid 10001 reconai \
    && chown -R reconai:reconai /app /data
USER reconai

EXPOSE 8000
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
    CMD curl -fsS http://localhost:8000/api/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
