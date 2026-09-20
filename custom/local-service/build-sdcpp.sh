#!/usr/bin/env bash
# Compile stable-diffusion.cpp (sd-cli) with CUDA for the V100 (sm_70) and the GTX 1080 (sm_61) inside a
# resource-limited builder container; stage the binary + the libs it needs under vendor/sdcpp/.
#
# Why we build it ourselves: upstream's Linux release zips are CPU/Vulkan/ROCm only, and this host's Xeon E5-2689
# has no AVX2/FMA/F16C, so ggml's CPU code must be built AVX-only. CUDA must be 12.x: CUDA 13 dropped sm_61/sm_70.
#
#   custom/local-service/build-sdcpp.sh [git-ref]        default ref: master-881-17860c0
#   OGAI_BUILD_IMAGE  builder image with nvcc 12.x (default nvidia/cuda:12.6.3-devel-ubuntu22.04). An image that already
#                     ships nvcc + g++ + cmake + git + objdump skips the package install, which is very slow on a busy host.
#   OGAI_BUILD_JOBS (3)   OGAI_BUILD_DIR (build tree; keep it off docker.img)
set -euo pipefail
cd "$(dirname "$0")"
REF=${1:-master-881-17860c0}
IMAGE=${OGAI_BUILD_IMAGE:-nvidia/cuda:12.6.3-devel-ubuntu22.04}
OUT=$PWD/vendor/sdcpp
WORK=${OGAI_BUILD_DIR:-/mnt/user/appdata/open-generative-ai/build/sdcpp}
JOBS=${OGAI_BUILD_JOBS:-3}

mkdir -p "$WORK"
rm -rf "$OUT"; mkdir -p "$OUT"

# Memory/CPU caps: nvcc instantiates huge ggml-cuda templates; on this box a runaway build starves everything else.
docker run --rm --name ogai-sdcpp-build \
  --memory=8g --memory-swap=8g --cpus=6 --cpu-shares=128 \
  -v "$WORK:/work" -v "$OUT:/out" -v "$PWD/sdcpp-inner.sh:/inner.sh:ro" \
  -e REF="$REF" -e JOBS="$JOBS" \
  --entrypoint bash "$IMAGE" /inner.sh

echo "staged in $OUT:"; ls -la "$OUT"
