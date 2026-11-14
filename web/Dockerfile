# Cloud Run image of the web admin front end. Build from the repository root: docker build -f web/Dockerfile .

# Build stage: install, generate contract clients and resource bundles, then `next build`, keeping the repository layout under /repo.
FROM node:22.23.4-bookworm-slim AS build
# The npm release the lockfiles were written with; the base image ships npm 10.
RUN npm install -g npm@11.21.0
ENV NEXT_TELEMETRY_DISABLED=1
COPY platform/package.json platform/package-lock.json platform/.npmrc platform/tsconfig.json /repo/platform/
COPY platform/src/ /repo/platform/src/
COPY platform/contracts/ /repo/platform/contracts/
WORKDIR /repo/web
COPY web/package.json web/package-lock.json web/.npmrc ./
RUN npm ci
# Service contracts `generate:clients` compiles.
COPY services/identity/contracts/openapi.yaml /repo/services/identity/contracts/
COPY services/people/contracts/openapi.yaml /repo/services/people/contracts/
COPY services/programs-sites/contracts/openapi.yaml /repo/services/programs-sites/contracts/
COPY services/strategies-content/contracts/openapi.yaml /repo/services/strategies-content/contracts/
COPY services/communications/contracts/openapi.yaml /repo/services/communications/contracts/
COPY services/reporting/contracts/openapi.yaml /repo/services/reporting/contracts/
COPY services/surveys/contracts/openapi.yaml /repo/services/surveys/contracts/
COPY services/timesheets/contracts/openapi.yaml /repo/services/timesheets/contracts/
COPY services/finance/contracts/openapi.yaml /repo/services/finance/contracts/
COPY services/e-signature/contracts/openapi.yaml /repo/services/e-signature/contracts/
# Legacy resource bundles `generate:rb` reads: the admin, core-assets and global layers.
COPY core/mura/resourceBundle/resources/ /repo/core/mura/resourceBundle/resources/
COPY core/modules/v1/core_assets/resource_bundles/ /repo/core/modules/v1/core_assets/resource_bundles/
COPY resource_bundles/ /repo/resource_bundles/
COPY web/tsconfig.json web/next.config.ts ./
COPY web/app/ ./app/
COPY web/src/ ./src/
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && npm prune --omit=dev --ignore-scripts --prefix ../platform

# Runtime stage: the `next build` output and production dependencies only; bundles and client types are compiled into .next.
FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080
COPY --from=build --chown=node:node /repo/platform/package.json /repo/platform/
COPY --from=build --chown=node:node /repo/platform/dist/ /repo/platform/dist/
COPY --from=build --chown=node:node /repo/platform/contracts/ /repo/platform/contracts/
COPY --from=build --chown=node:node /repo/platform/node_modules/ /repo/platform/node_modules/
# next.config.ts reads ../platform/package.json at start-up; the sibling layout keeps node_modules/@opt2/platform resolving to /repo/platform.
COPY --from=build --chown=node:node /repo/web/package.json /repo/web/next.config.ts /repo/web/
COPY --from=build --chown=node:node /repo/web/.next/ /repo/web/.next/
COPY --from=build --chown=node:node /repo/web/node_modules/ /repo/web/node_modules/
WORKDIR /repo/web
USER node
EXPOSE 8080
CMD ["node_modules/.bin/next", "start"]
