# Cloud Run image of the identity service. Build from the repository root: docker build -f services/identity/Dockerfile .

# Build stage: install, generate contract types and compile, keeping the repository layout under /app.
FROM node:22.23.4-bookworm-slim AS build
# Pins npm to the release the lockfiles were written with.
RUN npm --version | grep -qx 11.21.0 || npm install -g npm@11.21.0
COPY platform/package.json platform/package-lock.json platform/.npmrc platform/tsconfig.json /app/platform/
# bin/ holds the opt2-* CLIs the platform manifest declares; without it npm links no CLI into the image.
COPY platform/bin/ /app/platform/bin/
COPY platform/src/ /app/platform/src/
COPY platform/contracts/ /app/platform/contracts/
WORKDIR /app/services/identity
COPY services/identity/package.json services/identity/package-lock.json services/identity/.npmrc services/identity/tsconfig.json ./
RUN npm ci
# Producer contracts `npm run generate` compiles; the two event schemas are also read at run time.
COPY services/strategies-content/contracts/openapi.yaml /app/services/strategies-content/contracts/
COPY services/programs-sites/contracts/events/programs-sites.site.changed.v1.json /app/services/programs-sites/contracts/events/
COPY services/people/contracts/events/people.person.changed.v1.json /app/services/people/contracts/events/
COPY services/identity/contracts/ ./contracts/
COPY services/identity/config/ ./config/
COPY services/identity/src/ ./src/
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && npm prune --omit=dev --ignore-scripts --prefix ../../platform

# Runtime stage: compiled output, runtime contracts and production dependencies only.
# db/migrations is not packaged: the migration package's opt2-db bootstrap applies it, and the service never reads it.
FROM node:22.23.4-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/platform/package.json /app/platform/
COPY --from=build /app/platform/bin/ /app/platform/bin/
COPY --from=build /app/platform/dist/ /app/platform/dist/
COPY --from=build /app/platform/contracts/ /app/platform/contracts/
COPY --from=build /app/platform/node_modules/ /app/platform/node_modules/
COPY --from=build /app/services/programs-sites/contracts/events/ /app/services/programs-sites/contracts/events/
COPY --from=build /app/services/people/contracts/events/ /app/services/people/contracts/events/
COPY --from=build /app/services/identity/package.json /app/services/identity/
COPY --from=build /app/services/identity/dist/ /app/services/identity/dist/
COPY --from=build /app/services/identity/contracts/ /app/services/identity/contracts/
COPY --from=build /app/services/identity/config/ /app/services/identity/config/
# Same relative layout as the build stage, so the node_modules/@opt2/platform link still resolves to /app/platform.
COPY --from=build /app/services/identity/node_modules/ /app/services/identity/node_modules/
WORKDIR /app/services/identity
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
