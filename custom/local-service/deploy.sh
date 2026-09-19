#!/usr/bin/env bash
# Build (optional) and (re)create the ogai-local container.
#   custom/local-service/deploy.sh [--build]
# Host-specific values come from the environment; nothing host-specific is committed:
#   OGAI_ARBITER_URL   gpu-arbiter base URL (empty = V100 jobs are refused)
#   OGAI_GPU_ENABLED   1 to allow GPU jobs (default 0 - keep 0 until a GPU test window is approved)
#   OGAI_LOCAL_PORT (8790)   OGAI_DATA (/mnt/user/appdata/open-generative-ai)
set -euo pipefail
cd "$(dirname "$0")/../.."
NAME=ogai-local
IMG=ogai-local:latest
PORT=${OGAI_LOCAL_PORT:-8790}
DATA=${OGAI_DATA:-/mnt/user/appdata/open-generative-ai}

[ "${1:-}" = --build ] && docker build -t "$IMG" -f custom/local-service/Dockerfile .

mkdir -p "$DATA"
TOKEN_FILE="$DATA/.mcp-token"
[ -s "$TOKEN_FILE" ] || (umask 077; openssl rand -hex 24 > "$TOKEN_FILE")

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped -p "$PORT:8790" -v "$DATA:/data" \
  -e OGAI_TOKEN="$(cat "$TOKEN_FILE")" \
  -e OGAI_ARBITER_URL="${OGAI_ARBITER_URL:-}" \
  -e OGAI_GPU_ENABLED="${OGAI_GPU_ENABLED:-0}" \
  -e TZ="${TZ:-America/New_York}" \
  -l net.unraid.docker.managed=dockerman \
  -l "net.unraid.docker.icon=${OGAI_LOCAL_ICON:-https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/svg/openai.svg}" \
  -l 'net.unraid.docker.webui=http://[IP]:[PORT:8790]/health' \
  "$IMG" >/dev/null

for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null)" = healthy ] && { echo "ogai-local healthy on :$PORT (token in $TOKEN_FILE)"; exit 0; }
  sleep 2
done
echo "ogai-local did not become healthy" >&2
docker logs --tail 20 "$NAME" >&2
exit 1
