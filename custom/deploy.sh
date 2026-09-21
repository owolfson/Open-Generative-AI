#!/usr/bin/env bash
# Recreate the live container from an image tag the way Unraid's dockerMan does (same labels, env),
# wait for the healthcheck, and roll back to the previous image if the new one never goes healthy.
# Usage: custom/deploy.sh [image]      (default open-generative-ai:latest)
# Env:   OGAI_PORT (3002)  OGAI_DATA (/mnt/user/appdata/open-generative-ai)  OGAI_ICON
#        OGAI_LOCAL_URL  base URL of the ogai-local service (enables the ⚡ Local studio; empty = feature hidden). The bearer token is
#        read by the app from $DATA/.mcp-token (shared /data volume). Host-only values may live in $DATA/deploy.env.
set -euo pipefail
NAME=Open-Generative-AI
IMG=${1:-open-generative-ai:latest}
PORT=${OGAI_PORT:-3002}
DATA=${OGAI_DATA:-/mnt/user/appdata/open-generative-ai}
. "$(dirname "$0")/local-service/lib-env.sh"; load_host_env "$DATA/deploy.env"   # host-only settings; real env vars win

# Keep whatever icon/TZ the running container already has; fall back to generic values on a fresh install.
label() { docker inspect -f "{{index .Config.Labels \"$1\"}}" "$NAME" 2>/dev/null || true; }
ICON=${OGAI_ICON:-$(label net.unraid.docker.icon)}
ICON=${ICON:-https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/svg/openai.svg}
TZ_VAL=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" 2>/dev/null | sed -n 's/^TZ=//p')
TZ_VAL=${TZ_VAL:-America/New_York}

run_container() {
  docker run -d --name "$NAME" --restart unless-stopped \
    -p "$PORT:3000" -v "$DATA:/data" \
    -e TZ="$TZ_VAL" -e NODE_ENV=production \
    -e HOST_OS=Unraid -e HOST_HOSTNAME="$(hostname)" -e HOST_CONTAINERNAME="$NAME" \
    -e OGAI_LOCAL_URL="${OGAI_LOCAL_URL:-}" \
    -l net.unraid.docker.managed=dockerman -l "net.unraid.docker.icon=$ICON" \
    -l 'net.unraid.docker.webui=http://[IP]:[PORT:3000]/' \
    "$1" >/dev/null
}

wait_healthy() {
  local i s
  for i in $(seq 1 60); do
    s=$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo none)
    [ "$s" = healthy ] && return 0
    sleep 2
  done
  return 1
}

mkdir -p "$DATA"

# Pin the currently-running image as :prev BEFORE retagging :latest, so rollback always has a target.
PREV_ID=$(docker inspect -f '{{.Image}}' "$NAME" 2>/dev/null || true)
[ -n "$PREV_ID" ] && docker tag "$PREV_ID" open-generative-ai:prev
[ "$IMG" != open-generative-ai:latest ] && docker tag "$IMG" open-generative-ai:latest

docker stop -t 15 "$NAME" >/dev/null 2>&1 || true
docker rm "$NAME" >/dev/null 2>&1 || true
run_container open-generative-ai:latest

if wait_healthy; then
  echo "deployed $IMG -> $NAME (healthy, :$PORT)"
  exit 0
fi

echo "new image never went healthy - rolling back" >&2
docker logs --tail 20 "$NAME" >&2 || true
docker rm -f "$NAME" >/dev/null 2>&1 || true
if [ -n "$PREV_ID" ]; then
  docker tag open-generative-ai:prev open-generative-ai:latest
  run_container open-generative-ai:prev
  wait_healthy && echo "rolled back to previous image" >&2 || echo "ROLLBACK ALSO UNHEALTHY" >&2
fi
exit 1
