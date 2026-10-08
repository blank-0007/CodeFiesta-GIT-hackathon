#!/bin/sh
# Seed the demo September 2026 data on first start (no-op when the DB already has data),
# then serve the API.
set -e

cd /app
mkdir -p "${DATA_DIR:-/data}"

echo "[entrypoint] seeding demo data if the database is empty…"
python -m scripts.seed_demo --if-empty

echo "[entrypoint] starting uvicorn on :8000"
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*' "$@"
