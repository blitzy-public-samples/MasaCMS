# syntax=docker/dockerfile:1

# Build stage: install, generate contract types and compile, keeping the repository layout under /repo.
FROM node:22.23.4-bookworm-slim AS build
# The npm release the lockfiles were written with; the base image ships npm 10.
RUN npm install -g npm@11.21.0
WORKDIR /repo/services/stub
COPY platform/package.json platform/package-lock.json platform/.npmrc platform/tsconfig.json /repo/platform/
# bin/ holds the opt2-* CLIs the platform manifest declares; without it npm links no CLI into the image.
COPY platform/bin/ /repo/platform/bin/
COPY platform/src/ /repo/platform/src/
COPY platform/contracts/ /repo/platform/contracts/
COPY services/stub/package.json services/stub/package-lock.json services/stub/.npmrc services/stub/tsconfig.json ./
RUN npm ci
COPY services/programs-sites/contracts/events/programs-sites.site.changed.v1.json /repo/services/programs-sites/contracts/events/
COPY services/stub/contracts/ ./contracts/
COPY services/stub/src/ ./src/
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && npm prune --omit=dev --ignore-scripts --prefix ../../platform

# Runtime stage: compiled output, runtime contracts and production dependencies only.
# db/migrations is not packaged: the migration package's opt2-db bootstrap applies it, and the service never reads it.
FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production
COPY --from=build /repo/platform/package.json /repo/platform/
COPY --from=build /repo/platform/bin/ /repo/platform/bin/
COPY --from=build /repo/platform/dist/ /repo/platform/dist/
COPY --from=build /repo/platform/contracts/ /repo/platform/contracts/
COPY --from=build /repo/platform/node_modules/ /repo/platform/node_modules/
COPY --from=build /repo/services/programs-sites/contracts/events/programs-sites.site.changed.v1.json /repo/services/programs-sites/contracts/events/
COPY --from=build /repo/services/stub/package.json /repo/services/stub/
COPY --from=build /repo/services/stub/dist/ /repo/services/stub/dist/
COPY --from=build /repo/services/stub/contracts/ /repo/services/stub/contracts/
COPY --from=build /repo/services/stub/node_modules/ /repo/services/stub/node_modules/
WORKDIR /repo/services/stub
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/main.js"]
