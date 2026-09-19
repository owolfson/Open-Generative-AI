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
# sync-upstream.sh refuses to start on a dirty tree, so its merge commit is clean by construction and it
# sets OGAI_ASSUME_CLEAN. Manual builds still get the -dirty marker, with the offending paths shown.
if [ "${OGAI_ASSUME_CLEAN:-0}" != 1 ] && [ -n "$(git status --porcelain)" ]; then
  CUSTOM_SHA="${CUSTOM_SHA}-dirty"
  echo "tree is dirty, labelling image ${CUSTOM_SHA}:" >&2
  git status --porcelain | head -10 >&2
fi

docker build -t open-generative-ai:upstream-build -f Dockerfile .
# Overlay needs no build context, so feed the Dockerfile on stdin.
docker build -t "$TAG" \
  --build-arg BASE=open-generative-ai:upstream-build \
  --build-arg UPSTREAM_SHA="$UPSTREAM_SHA" --build-arg CUSTOM_SHA="$CUSTOM_SHA" \
  - < custom/Dockerfile.overlay
echo "built $TAG (upstream ${UPSTREAM_SHA}, custom ${CUSTOM_SHA})"
