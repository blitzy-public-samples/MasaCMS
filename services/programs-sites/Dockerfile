# syntax=docker/dockerfile:1

# Build stage: install, generate contract types and compile, keeping the repository layout under /repo.
FROM node:22.23.4-bookworm-slim AS build
# The npm release the lockfiles were written with; the base image ships npm 10.
RUN npm install -g npm@11.21.0
WORKDIR /repo/services/programs-sites
COPY platform/package.json platform/package-lock.json platform/.npmrc platform/tsconfig.json /repo/platform/
# bin/ holds the opt2-* CLIs the platform manifest declares; without it npm links no CLI into the image.
COPY platform/bin/ /repo/platform/bin/
COPY platform/src/ /repo/platform/src/
COPY platform/contracts/ /repo/platform/contracts/
COPY services/programs-sites/package.json services/programs-sites/package-lock.json services/programs-sites/.npmrc services/programs-sites/tsconfig.json ./
RUN npm ci
COPY services/strategies-content/contracts/ /repo/services/strategies-content/contracts/
COPY migration/contracts/ /repo/migration/contracts/
COPY services/programs-sites/contracts/ ./contracts/
COPY services/programs-sites/src/ ./src/
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && npm prune --omit=dev --ignore-scripts --prefix ../../platform

# Runtime stage: compiled output, runtime contracts and production dependencies only.
FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production
COPY --from=build /repo/platform/package.json /repo/platform/
COPY --from=build /repo/platform/bin/ /repo/platform/bin/
COPY --from=build /repo/platform/dist/ /repo/platform/dist/
COPY --from=build /repo/platform/contracts/ /repo/platform/contracts/
COPY --from=build /repo/platform/node_modules/ /repo/platform/node_modules/
COPY --from=build /repo/services/programs-sites/package.json /repo/services/programs-sites/
COPY --from=build /repo/services/programs-sites/dist/ /repo/services/programs-sites/dist/
COPY --from=build /repo/services/programs-sites/contracts/ /repo/services/programs-sites/contracts/
COPY --from=build /repo/services/programs-sites/node_modules/ /repo/services/programs-sites/node_modules/
WORKDIR /repo/services/programs-sites
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/main.js"]
