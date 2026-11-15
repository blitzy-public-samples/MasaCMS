# SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
# Build context is the repository root: docker build -f services/e-signature/Dockerfile .
# No `# syntax=` directive: BuildKit honours one only above every comment, and line 1 holds the label.

# Build stage: install with the lockfiles' npm 11.21.0 (the base image ships npm 10), generate contract types and compile, in the repository layout under /app.
FROM node:22.23.4-bookworm-slim AS build
RUN npm install -g npm@11.21.0
WORKDIR /app/services/e-signature
COPY platform/package.json platform/package-lock.json platform/.npmrc platform/tsconfig.json /app/platform/
# bin/ holds the opt2-* CLIs the platform manifest declares; npm links them only when it is present.
COPY platform/bin/ /app/platform/bin/
COPY platform/src/ /app/platform/src/
COPY platform/contracts/ /app/platform/contracts/
COPY services/e-signature/package.json services/e-signature/package-lock.json services/e-signature/.npmrc services/e-signature/tsconfig.json ./
RUN npm ci
COPY services/people/contracts/openapi.yaml /app/services/people/contracts/
COPY services/programs-sites/contracts/events/programs-sites.site.changed.v1.json /app/services/programs-sites/contracts/events/
COPY services/e-signature/contracts/ ./contracts/
COPY services/e-signature/src/ ./src/
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && npm prune --omit=dev --ignore-scripts --prefix ../../platform

# Runtime stage: compiled output, contracts and production dependencies, at the build stage's paths.
FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/platform/package.json /app/platform/
COPY --from=build /app/platform/bin/ /app/platform/bin/
COPY --from=build /app/platform/dist/ /app/platform/dist/
COPY --from=build /app/platform/contracts/ /app/platform/contracts/
COPY --from=build /app/platform/node_modules/ /app/platform/node_modules/
COPY --from=build /app/services/programs-sites/contracts/events/programs-sites.site.changed.v1.json /app/services/programs-sites/contracts/events/
COPY --from=build /app/services/e-signature/package.json /app/services/e-signature/
COPY --from=build /app/services/e-signature/dist/ /app/services/e-signature/dist/
COPY --from=build /app/services/e-signature/contracts/ /app/services/e-signature/contracts/
COPY --from=build /app/services/e-signature/node_modules/ /app/services/e-signature/node_modules/
WORKDIR /app/services/e-signature
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
