# Cloud Run image of the migration service and the db-bootstrap job. Build from the repository root: docker build -f migration/Dockerfile .

# Build stage: install with the lockfiles' npm 11.21.0 (the base image ships npm 10), generate contract types and compile, in the repository layout under /app.
FROM node:22.23.4-bookworm-slim AS build
RUN npm install -g npm@11.21.0
COPY platform/package.json platform/package-lock.json platform/.npmrc platform/tsconfig.json /app/platform/
COPY platform/bin/ /app/platform/bin/
COPY platform/src/ /app/platform/src/
COPY platform/contracts/ /app/platform/contracts/
WORKDIR /app/migration
COPY migration/package.json migration/package-lock.json migration/.npmrc migration/tsconfig.json ./
RUN npm ci
COPY gateway/contracts/openapi.yaml /app/gateway/contracts/
COPY services/strategies-content/contracts/openapi.yaml /app/services/strategies-content/contracts/
COPY services/finance/contracts/openapi.yaml /app/services/finance/contracts/
COPY migration/contracts/ ./contracts/
COPY migration/src/ ./src/
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && npm prune --omit=dev --ignore-scripts --prefix ../platform

# Runtime stage: production dependencies and compiled output at the build stage's paths, so the @opt2/platform link resolves; the files read by
# relative path (every schema's migrations for opt2-db, cut-over and opt2 inputs, consumer contracts a transition drains by); node-owned reports.
FROM node:22.23.4-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/platform/package.json /app/platform/
COPY --from=build /app/platform/bin/ /app/platform/bin/
COPY --from=build /app/platform/dist/ /app/platform/dist/
COPY --from=build /app/platform/contracts/ /app/platform/contracts/
COPY --from=build /app/platform/node_modules/ /app/platform/node_modules/
COPY --from=build /app/migration/package.json /app/migration/
COPY --from=build /app/migration/dist/ /app/migration/dist/
COPY --from=build /app/migration/node_modules/ /app/migration/node_modules/
COPY migration/contracts/ /app/migration/contracts/
COPY migration/config/ /app/migration/config/
COPY migration/db/migrations/ /app/migration/db/migrations/
COPY migration/sql/ /app/migration/sql/
COPY gateway/db/migrations/ /app/gateway/db/migrations/
COPY services/identity/db/migrations/ /app/services/identity/db/migrations/
COPY services/people/db/migrations/ /app/services/people/db/migrations/
COPY services/programs-sites/db/migrations/ /app/services/programs-sites/db/migrations/
COPY services/strategies-content/db/migrations/ /app/services/strategies-content/db/migrations/
COPY services/communications/db/migrations/ /app/services/communications/db/migrations/
COPY services/reporting/db/migrations/ /app/services/reporting/db/migrations/
COPY services/surveys/db/migrations/ /app/services/surveys/db/migrations/
COPY services/timesheets/db/migrations/ /app/services/timesheets/db/migrations/
COPY services/finance/db/migrations/ /app/services/finance/db/migrations/
COPY services/e-signature/db/migrations/ /app/services/e-signature/db/migrations/
COPY services/stub/db/migrations/ /app/services/stub/db/migrations/
COPY services/identity/contracts/openapi.yaml /app/services/identity/contracts/
COPY services/people/contracts/openapi.yaml /app/services/people/contracts/
COPY services/programs-sites/contracts/openapi.yaml /app/services/programs-sites/contracts/
COPY services/strategies-content/contracts/openapi.yaml /app/services/strategies-content/contracts/
COPY services/communications/contracts/openapi.yaml /app/services/communications/contracts/
COPY services/reporting/contracts/openapi.yaml /app/services/reporting/contracts/
COPY services/surveys/contracts/openapi.yaml /app/services/surveys/contracts/
COPY services/timesheets/contracts/openapi.yaml /app/services/timesheets/contracts/
COPY services/finance/contracts/openapi.yaml /app/services/finance/contracts/
COPY services/e-signature/contracts/openapi.yaml /app/services/e-signature/contracts/
COPY gateway/cutover/ /app/gateway/cutover/
COPY opt2/source-pin.json opt2/table-ownership.json /app/opt2/
COPY opt2/inventory/legacy-inventory.json /app/opt2/inventory/
RUN install -d -o node -g node /app/opt2/reports
WORKDIR /app/migration
USER node
EXPOSE 8080
CMD ["node", "dist/cli.js", "serve"]
