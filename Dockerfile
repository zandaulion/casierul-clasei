FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY web ./web
COPY assets ./assets
COPY scripts ./scripts

# The public server listens on all container interfaces; the admin API stays on loopback
# inside the container and is reached with `docker compose exec app node scripts/admin.mjs …`.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8018 ADMIN_HOST=127.0.0.1 ADMIN_PORT=8118 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8018
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8018/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/index.mjs"]
