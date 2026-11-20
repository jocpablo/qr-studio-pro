# QR Studio Pro — imagen para cualquier hosting con contenedores (Render, Fly.io, Railway, un VPS…)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_FILE=/data/qr-data.json
# Solo los archivos que sirve el servidor
COPY package.json qr-server.js qr-studio-pro.html sw.js manifest.webmanifest ./
COPY icons ./icons
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1
CMD ["node", "qr-server.js"]
