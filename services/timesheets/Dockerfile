# SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/

FROM node:22.23.4-bookworm-slim AS build
RUN npm install -g npm@11.21.0
WORKDIR /app/services/timesheets
COPY platform/package.json platform/package-lock.json platform/.npmrc platform/tsconfig.json /app/platform/
COPY platform/bin/ /app/platform/bin/
COPY platform/src/ /app/platform/src/
COPY platform/contracts/ /app/platform/contracts/
COPY services/timesheets/package.json services/timesheets/package-lock.json services/timesheets/.npmrc services/timesheets/tsconfig.json ./
RUN npm ci
# Build stage only: `generate` types the reporting client from it; nothing reads it at run time.
COPY services/reporting/contracts/openapi.yaml /app/services/reporting/contracts/
COPY services/people/contracts/events/people.person.archived.v1.json /app/services/people/contracts/events/
COPY services/programs-sites/contracts/events/programs-sites.site.changed.v1.json /app/services/programs-sites/contracts/events/
COPY services/timesheets/contracts/ ./contracts/
COPY services/timesheets/src/ ./src/
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && npm prune --omit=dev --ignore-scripts --prefix ../../platform

FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/platform/package.json /app/platform/
COPY --from=build /app/platform/bin/ /app/platform/bin/
COPY --from=build /app/platform/dist/ /app/platform/dist/
COPY --from=build /app/platform/contracts/ /app/platform/contracts/
COPY --from=build /app/platform/node_modules/ /app/platform/node_modules/
COPY --from=build /app/services/people/contracts/events/people.person.archived.v1.json /app/services/people/contracts/events/
COPY --from=build /app/services/programs-sites/contracts/events/programs-sites.site.changed.v1.json /app/services/programs-sites/contracts/events/
COPY --from=build /app/services/timesheets/package.json /app/services/timesheets/
COPY --from=build /app/services/timesheets/dist/ /app/services/timesheets/dist/
COPY --from=build /app/services/timesheets/contracts/ /app/services/timesheets/contracts/
COPY --from=build /app/services/timesheets/node_modules/ /app/services/timesheets/node_modules/
WORKDIR /app/services/timesheets
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
