# GlowDerma Store — production image.
# NOTE: written and reviewed, but NOT built in the original sandbox (no Docker daemon / registry access).
# Build: docker build -t glowderma-store .

# ---- build stage ----
FROM node:22.12-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# Use `npm ci` once package-lock.json is committed (generate it with `npm install` on a networked machine).
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json ./
COPY types ./types
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY public ./public
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM node:22.12-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PRESCRIPTION_STORAGE_DIR=/data/prescriptions
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/migrations ./migrations
COPY package.json ./
RUN mkdir -p /data/prescriptions && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Run migrations as a separate release step: docker run --rm --env-file .env glowderma-store node dist/migrate.mjs
CMD ["node", "dist/server.mjs"]
