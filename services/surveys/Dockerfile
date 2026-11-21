# syntax=docker/dockerfile:1
# SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/

# Build stage: install, generate contract types and compile, keeping the repository layout under /app.
FROM node:22.23.4-bookworm-slim AS build
# The npm release the lockfiles were written with; the base image ships npm 10.
RUN npm install -g npm@11.21.0
WORKDIR /app/services/surveys
COPY platform/package.json platform/package-lock.json platform/.npmrc platform/tsconfig.json /app/platform/
# bin/ holds the opt2-* CLIs the platform manifest declares; without it npm links no CLI into the image.
COPY platform/bin/ /app/platform/bin/
COPY platform/src/ /app/platform/src/
COPY platform/contracts/ /app/platform/contracts/
COPY services/communications/contracts/openapi.yaml /app/services/communications/contracts/
COPY services/programs-sites/contracts/events/programs-sites.site.changed.v1.json /app/services/programs-sites/contracts/events/
COPY services/surveys/package.json services/surveys/package-lock.json services/surveys/.npmrc services/surveys/tsconfig.json ./
COPY services/surveys/contracts/ ./contracts/
COPY services/surveys/src/ ./src/
# Install and prune share one layer: deleting files an earlier layer created costs a whiteout per file.
RUN npm ci \
 && npm run build \
 && npm prune --omit=dev \
 && npm prune --omit=dev --prefix ../../platform

# Runtime stage: compiled output, runtime contracts and production dependencies, at the build stage's paths.
FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/platform/package.json /app/platform/
COPY --from=build --chown=node:node /app/platform/bin/ /app/platform/bin/
COPY --from=build --chown=node:node /app/platform/dist/ /app/platform/dist/
COPY --from=build --chown=node:node /app/platform/contracts/ /app/platform/contracts/
COPY --from=build --chown=node:node /app/platform/node_modules/ /app/platform/node_modules/
COPY --from=build --chown=node:node /app/services/programs-sites/contracts/events/programs-sites.site.changed.v1.json /app/services/programs-sites/contracts/events/
COPY --from=build --chown=node:node /app/services/surveys/package.json /app/services/surveys/
COPY --from=build --chown=node:node /app/services/surveys/dist/ /app/services/surveys/dist/
COPY --from=build --chown=node:node /app/services/surveys/contracts/ /app/services/surveys/contracts/
COPY --from=build --chown=node:node /app/services/surveys/node_modules/ /app/services/surveys/node_modules/
WORKDIR /app/services/surveys
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
