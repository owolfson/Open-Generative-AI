#!/usr/bin/env bash
# Runs INSIDE the builder container (see build-sdcpp.sh).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Only install a toolchain if the image lacks one. dpkg fsyncs every file, which on this host's contended
# loop-backed docker.img made the install take ~30 min, so skip fsync (the container is disposable).
need_apt=0
for tool in cmake g++ git objdump; do command -v "$tool" >/dev/null 2>&1 || need_apt=1; done
if [ "$need_apt" = 1 ]; then
  echo 'force-unsafe-io' > /etc/dpkg/dpkg.cfg.d/99-unsafe-io
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends git cmake build-essential ca-certificates libgomp1 >/dev/null
fi
export TMPDIR=/work/tmp    # compiler temp files on the appdata mount, not docker.img
mkdir -p "$TMPDIR"

cd /work
[ -d sd.cpp/.git ] || git clone -q https://github.com/leejet/stable-diffusion.cpp sd.cpp
cd sd.cpp
git fetch -q --tags
git checkout -q "$REF"
git submodule update -q --init --recursive

# CPU side: AVX only (host has no AVX2/FMA/F16C/BMI2/AVX512). GPU side: Pascal (61) + Volta (70).
# SD_WEBP=OFF/SD_WEBM=OFF (WebM requires WebP): we only write PNG, and libwebp ships runtime-dispatched *_AVX2 functions (never called without
# CPUID support, but they would trip the strict instruction guard below and make it impossible to reason about).
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DSD_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="61;70" \
  -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_BMI2=OFF -DGGML_AVX512=OFF \
  -DSD_WEBP=OFF -DSD_WEBM=OFF
nice -n 19 cmake --build build --config Release --target sd-cli -j "$JOBS"

BIN=$(find build -type f -name sd-cli | head -1)
[ -n "$BIN" ] || { echo "sd-cli was not produced" >&2; exit 1; }
cp "$BIN" /out/sd-cli

# Illegal-instruction guard: the CPU code must not contain AVX2/FMA/F16C/BMI2 instructions.
BAD=$(objdump -d --no-show-raw-insn /out/sd-cli | grep -cE '\b(vfmadd[0-9a-z]*|vfnmadd[0-9a-z]*|vpermd|vperm2i128|vpbroadcast[bdwq]|vinserti128|vextracti128|vpgatherd[dq]|vcvtph2ps|vcvtps2ph|shlx|shrx|sarx|pdep|pext)\b' || true)
echo "AVX2/FMA/F16C/BMI2 instructions in sd-cli: $BAD"
if [ "$BAD" != 0 ]; then
  echo "sd-cli contains instructions this CPU cannot run; offending functions:" >&2
  objdump -d --no-show-raw-insn /out/sd-cli | awk '/^[0-9a-f]+ <.*>:$/ { fn=$2 } /\t(vfmadd[0-9a-z]*|vfnmadd[0-9a-z]*|vpermd|vperm2i128|vpbroadcast[bdwq]|vinserti128|vextracti128|vpgatherd[dq]|vcvtph2ps|vcvtps2ph|shlx|shrx|sarx|pdep|pext)[ \t]/ { c[fn]++ } END { for (f in c) printf "%3d  %s\n", c[f], f }' | sort -rn | head -15 >&2
  exit 1
fi

# Runtime libs the binary links against (the NVIDIA runtime injects libcuda at container start). libnccl is linked because
# ggml-cuda auto-detects it (GGML_USE_NCCL is a global define, so disabling it would mean recompiling every CUDA kernel);
# single-GPU jobs never initialise it, we just have to ship it so the dynamic loader finds it.
ldd /out/sd-cli | awk '/=> \//{print $3}' | grep -E 'libcudart|libcublas|libgomp|libnccl' | while read -r lib; do cp -L "$lib" /out/; done
CUDA_VER=$(nvcc --version | sed -n 's/.*release \([0-9.]*\),.*/\1/p')
echo "$REF cuda$CUDA_VER sm61+sm70 avx-only" > /out/BUNDLE_VERSION
chmod -R a+rX /out
echo "--- linked libs ---"; ldd /out/sd-cli
