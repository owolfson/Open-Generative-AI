#!/usr/bin/env bash
# Build the deployable image: upstream's Dockerfile verbatim, then our overlay.
# Usage: custom/build.sh [image-tag]     (default open-generative-ai:candidate)
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${1:-open-generative-ai:candidate}"

# The three workspace packages are git submodules; the upstream Dockerfile COPYs them from the tree.
git submodule update --init --recursive

UPSTREAM_SHA=$(git merge-base HEAD upstream/main 2>/dev/null | cut -c1-9 || echo unknown)
CUSTOM_SHA=$(git rev-parse --short=9 HEAD)
[ -n "$(git status --porcelain)" ] && CUSTOM_SHA="${CUSTOM_SHA}-dirty"

docker build -t open-generative-ai:upstream-build -f Dockerfile .
# Overlay needs no build context, so feed the Dockerfile on stdin.
docker build -t "$TAG" \
  --build-arg BASE=open-generative-ai:upstream-build \
  --build-arg UPSTREAM_SHA="$UPSTREAM_SHA" --build-arg CUSTOM_SHA="$CUSTOM_SHA" \
  - < custom/Dockerfile.overlay
echo "built $TAG (upstream ${UPSTREAM_SHA}, custom ${CUSTOM_SHA})"
