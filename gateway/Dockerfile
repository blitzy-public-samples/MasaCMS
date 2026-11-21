# Cloud Run image of the gateway. Build from the repository root: docker build -f gateway/Dockerfile .

# Build stage: install, generate contract types and compile, keeping the repository layout under /app.
FROM node:22.23.4-bookworm-slim AS build
# Pins npm to the release the lockfiles were written with; the base image ships npm 10.
RUN npm install -g npm@11.21.0
COPY platform/package.json platform/package-lock.json platform/.npmrc platform/tsconfig.json /app/platform/
# bin/ holds the opt2-* CLIs the platform manifest declares; without it npm links no CLI into the image.
COPY platform/bin/ /app/platform/bin/
COPY platform/src/ /app/platform/src/
COPY platform/contracts/ /app/platform/contracts/
WORKDIR /app/gateway
COPY gateway/package.json gateway/package-lock.json gateway/.npmrc gateway/tsconfig.json ./
RUN npm ci
# Producer contracts `npm run generate` compiles into typed clients; neither is read at run time.
COPY services/identity/contracts/openapi.yaml /app/services/identity/contracts/
COPY migration/contracts/openapi.yaml /app/migration/contracts/
COPY gateway/contracts/ ./contracts/
COPY gateway/src/ ./src/
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && npm prune --omit=dev --ignore-scripts --prefix ../platform

# Runtime stage: compiled output, packaged cut-over and opt2 inputs, and production dependencies only.
# legacy-bridge/ runs inside the legacy web root, and db/migrations is applied by the migration package's opt2-db bootstrap.
FROM node:22.23.4-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 OPT2_CUTOVER_DIR=/app/gateway/cutover
COPY --from=build /app/platform/package.json /app/platform/
COPY --from=build /app/platform/bin/ /app/platform/bin/
COPY --from=build /app/platform/dist/ /app/platform/dist/
COPY --from=build /app/platform/contracts/ /app/platform/contracts/
COPY --from=build /app/platform/node_modules/ /app/platform/node_modules/
COPY --from=build /app/gateway/package.json /app/gateway/
COPY --from=build /app/gateway/dist/ /app/gateway/dist/
COPY --from=build /app/gateway/contracts/ /app/gateway/contracts/
# Same relative layout as the build stage, so the node_modules/@opt2/platform link still resolves to /app/platform.
COPY --from=build /app/gateway/node_modules/ /app/gateway/node_modules/
COPY gateway/cutover/ /app/gateway/cutover/
COPY opt2/source-pin.json opt2/table-ownership.json opt2/decision-list.json opt2/exceptions-list.json /app/opt2/
COPY opt2/inventory/legacy-inventory.json /app/opt2/inventory/
# Activating a version that returns groups to legacy reads the reconciliation reports its rollbackRefs name.
COPY opt2/reports/reconciliation/*.json /app/opt2/reports/reconciliation/
WORKDIR /app/gateway
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
