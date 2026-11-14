# SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
# Build context is the repository root: docker build -f services/reporting/Dockerfile .
# No `# syntax=` directive: BuildKit honours one only above every comment, and line 1 holds the label.

# Build stage: install with the lockfiles' npm 11.21.0 (the base image ships npm 10), generate contract types and compile, in the repository layout under /app.
FROM node:22.23.4-bookworm-slim AS build
RUN npm install -g npm@11.21.0 && node -v && npm -v
WORKDIR /app/services/reporting
COPY platform/package.json platform/package-lock.json platform/.npmrc platform/tsconfig.json /app/platform/
COPY platform/bin/ /app/platform/bin/
COPY platform/src/ /app/platform/src/
COPY platform/contracts/ /app/platform/contracts/
COPY services/reporting/package.json services/reporting/package-lock.json services/reporting/.npmrc services/reporting/tsconfig.json ./
RUN npm ci
COPY services/finance/contracts/openapi.yaml /app/services/finance/contracts/
COPY services/timesheets/contracts/openapi.yaml /app/services/timesheets/contracts/
COPY services/programs-sites/contracts/events/programs-sites.site.changed.v1.json /app/services/programs-sites/contracts/events/
COPY services/reporting/contracts/ ./contracts/
COPY services/reporting/src/ ./src/
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && npm prune --omit=dev --ignore-scripts --prefix ../../platform

# Runtime stage: compiled output, the contracts read at run time and production dependencies at the build stage's paths, root-owned and read-only to the node user.
FROM node:22.23.4-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/platform/package.json /app/platform/
COPY --from=build /app/platform/bin/ /app/platform/bin/
COPY --from=build /app/platform/dist/ /app/platform/dist/
COPY --from=build /app/platform/contracts/ /app/platform/contracts/
COPY --from=build /app/platform/node_modules/ /app/platform/node_modules/
COPY --from=build /app/services/programs-sites/contracts/events/programs-sites.site.changed.v1.json /app/services/programs-sites/contracts/events/
COPY --from=build /app/services/reporting/package.json /app/services/reporting/
COPY --from=build /app/services/reporting/dist/ /app/services/reporting/dist/
COPY --from=build /app/services/reporting/contracts/ /app/services/reporting/contracts/
COPY --from=build /app/services/reporting/node_modules/ /app/services/reporting/node_modules/
WORKDIR /app/services/reporting
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
