# Cloud Run image of the strategies-content service. Build from the repository root: docker build -f services/strategies-content/Dockerfile .

# Build stage: pin npm to the lockfiles' release, install, generate contract types and compile under the repository layout in /app.
FROM node:22.23.4-bookworm-slim AS build
RUN npm --version | grep -qx 11.21.0 || npm install -g npm@11.21.0
COPY platform/package.json platform/package-lock.json platform/.npmrc platform/tsconfig.json /app/platform/
COPY platform/bin/ /app/platform/bin/
COPY platform/src/ /app/platform/src/
COPY platform/contracts/ /app/platform/contracts/
WORKDIR /app/services/strategies-content
COPY services/strategies-content/package.json services/strategies-content/package-lock.json services/strategies-content/.npmrc services/strategies-content/tsconfig.json ./
RUN npm ci
COPY services/identity/contracts/events/identity.group.changed.v1.json services/identity/contracts/events/identity.permission.changed.v1.json services/identity/contracts/events/identity.membership.changed.v1.json /app/services/identity/contracts/events/
COPY services/programs-sites/contracts/events/programs-sites.site.changed.v1.json /app/services/programs-sites/contracts/events/
COPY services/programs-sites/contracts/openapi.yaml /app/services/programs-sites/contracts/
COPY services/strategies-content/contracts/ ./contracts/
COPY services/strategies-content/src/ ./src/
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && npm prune --omit=dev --ignore-scripts --prefix ../../platform

# Runtime stage: compiled output, run-time files and production dependencies, in the build layout so the @opt2/platform link resolves.
FROM node:22.23.4-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/platform/package.json /app/platform/
COPY --from=build /app/platform/bin/ /app/platform/bin/
COPY --from=build /app/platform/dist/ /app/platform/dist/
COPY --from=build /app/platform/contracts/ /app/platform/contracts/
COPY --from=build /app/platform/node_modules/ /app/platform/node_modules/
COPY --from=build /app/services/identity/contracts/events/ /app/services/identity/contracts/events/
COPY --from=build /app/services/programs-sites/contracts/events/ /app/services/programs-sites/contracts/events/
# The carch and cform routes read Masa's label bundles from the repository root at run time; only their .properties files enter the image.
COPY core/mura/resourceBundle/resources/*.properties /app/core/mura/resourceBundle/resources/
COPY resource_bundles/*.properties /app/resource_bundles/
COPY --from=build /app/services/strategies-content/package.json /app/services/strategies-content/
COPY --from=build /app/services/strategies-content/dist/ /app/services/strategies-content/dist/
COPY --from=build /app/services/strategies-content/contracts/ /app/services/strategies-content/contracts/
COPY --from=build /app/services/strategies-content/node_modules/ /app/services/strategies-content/node_modules/
WORKDIR /app/services/strategies-content
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
