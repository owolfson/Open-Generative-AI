# ogai-local: runs upstream's Electron engine modules behind a stand-in (see custom/local-service/README.md).
# Build from the REPO ROOT: docker build -f custom/local-service/Dockerfile -t ogai-local:latest .
FROM node:22-bookworm-slim
WORKDIR /srv
# Bundle first (~1.3GB, rarely changes): code edits below must not invalidate this layer.
# sd.cpp built with CUDA by build-sdcpp.sh (run it first). The stand-in presents this directory to upstream's
# engine as its "bundled binary", so the upstream CPU-only download is never used.
COPY custom/local-service/vendor/sdcpp/ /opt/ogai/resources/local-ai/linux-x64/bin/
COPY electron/lib /app/electron/lib
COPY custom/local-service/package.json ./package.json
COPY custom/local-service/src ./src
ENV OGAI_UPSTREAM_DIR=/app OGAI_DATA_DIR=/data OGAI_LOCAL_PORT=8790 OGAI_RESOURCES_PATH=/opt/ogai/resources NODE_ENV=production NVIDIA_DRIVER_CAPABILITIES=compute,utility
EXPOSE 8790
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
