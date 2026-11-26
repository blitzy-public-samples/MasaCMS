# Cloud Run image of the people service. Build from the repository root: docker build -f services/people/Dockerfile .

# Build stage: install, generate contract types and compile under the repository layout; platform/bin lets npm link the opt2-* CLIs.
FROM node:22.23.4-bookworm-slim AS build
RUN npm --version | grep -qx 11.21.0 || npm install -g npm@11.21.0
COPY platform/package.json platform/package-lock.json platform/.npmrc platform/tsconfig.json /app/platform/
COPY platform/bin/ /app/platform/bin/
COPY platform/src/ /app/platform/src/
COPY platform/contracts/ /app/platform/contracts/
WORKDIR /app/services/people
COPY services/people/package.json services/people/package-lock.json services/people/.npmrc services/people/tsconfig.json ./
RUN npm ci
COPY services/identity/contracts/openapi.yaml /app/services/identity/contracts/
COPY services/identity/contracts/events/identity.group.changed.v1.json /app/services/identity/contracts/events/
COPY services/strategies-content/contracts/openapi.yaml /app/services/strategies-content/contracts/
COPY services/programs-sites/contracts/events/programs-sites.site.changed.v1.json /app/services/programs-sites/contracts/events/
COPY services/people/contracts/ ./contracts/
COPY services/people/src/ ./src/
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && npm prune --omit=dev --ignore-scripts --prefix ../../platform

# Runtime stage: compiled output, the event schemas read at start-up and production dependencies; db/migrations is not shipped because opt2-db bootstrap applies it.
FROM node:22.23.4-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/platform/package.json /app/platform/
COPY --from=build /app/platform/bin/ /app/platform/bin/
COPY --from=build /app/platform/dist/ /app/platform/dist/
COPY --from=build /app/platform/contracts/ /app/platform/contracts/
COPY --from=build /app/platform/node_modules/ /app/platform/node_modules/
COPY --from=build /app/services/identity/contracts/events/ /app/services/identity/contracts/events/
COPY --from=build /app/services/programs-sites/contracts/events/ /app/services/programs-sites/contracts/events/
COPY --from=build /app/services/people/package.json /app/services/people/
COPY --from=build /app/services/people/dist/ /app/services/people/dist/
COPY --from=build /app/services/people/contracts/ /app/services/people/contracts/
COPY --from=build /app/services/people/node_modules/ /app/services/people/node_modules/
WORKDIR /app/services/people
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
