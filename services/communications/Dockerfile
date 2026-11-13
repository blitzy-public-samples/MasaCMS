# SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
# Build from the repository root: docker build -f services/communications/Dockerfile .

FROM node:22.23.4-bookworm-slim AS build
RUN npm install -g npm@11.21.0
WORKDIR /app
COPY platform/package.json platform/package-lock.json platform/.npmrc platform/tsconfig.json /app/platform/
COPY platform/bin/ /app/platform/bin/
COPY platform/src/ /app/platform/src/
COPY platform/contracts/ /app/platform/contracts/
COPY services/communications/package.json services/communications/package-lock.json services/communications/.npmrc services/communications/tsconfig.json /app/services/communications/
WORKDIR /app/services/communications
RUN npm ci
COPY services/surveys/contracts/openapi.yaml /app/services/surveys/contracts/
COPY services/surveys/contracts/events/surveys.survey.scheduled.v1.json /app/services/surveys/contracts/events/
COPY services/identity/contracts/events/identity.login-mail.requested.v1.json /app/services/identity/contracts/events/
COPY services/programs-sites/contracts/events/programs-sites.site.changed.v1.json /app/services/programs-sites/contracts/events/
COPY services/communications/contracts/ /app/services/communications/contracts/
COPY services/communications/src/ /app/services/communications/src/
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && npm prune --omit=dev --ignore-scripts --prefix ../../platform

FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app/services/communications
COPY --from=build /app/platform/package.json /app/platform/
COPY --from=build /app/platform/bin/ /app/platform/bin/
COPY --from=build /app/platform/dist/ /app/platform/dist/
COPY --from=build /app/platform/contracts/ /app/platform/contracts/
COPY --from=build /app/platform/node_modules/ /app/platform/node_modules/
COPY --from=build /app/services/surveys/contracts/events/ /app/services/surveys/contracts/events/
COPY --from=build /app/services/identity/contracts/events/ /app/services/identity/contracts/events/
COPY --from=build /app/services/programs-sites/contracts/events/ /app/services/programs-sites/contracts/events/
COPY --from=build /app/services/communications/package.json /app/services/communications/
COPY --from=build /app/services/communications/dist/ /app/services/communications/dist/
COPY --from=build /app/services/communications/contracts/ /app/services/communications/contracts/
COPY --from=build /app/services/communications/node_modules/ /app/services/communications/node_modules/
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
