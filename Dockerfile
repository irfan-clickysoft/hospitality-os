# syntax=docker/dockerfile:1
# Hospitality OS images, built from the repository root.
#   docker build --target api -t hos-api .     the API (also used for migrations and the demo seed jobs)
#   docker build --target web -t hos-web .     the staff app, built to static files and served by Caddy
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@10.33.0 tsx@4 && npm cache clean --force
WORKDIR /app

# ---- API ----
FROM base AS api-build
COPY . .
RUN pnpm install --frozen-lockfile --filter "@hos/api..."
RUN pnpm --filter "@hos/api..." build

FROM api-build AS api
ENV NODE_ENV=production PORT=3000
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

# ---- Staff app (static files) ----
FROM base AS web-build
COPY . .
RUN pnpm install --frozen-lockfile --filter "@hos/staff-web..."
RUN pnpm --filter @hos/staff-web build

FROM caddy:2-alpine AS web
COPY --from=web-build /app/apps/staff-web/dist /srv
COPY deploy/staging/Caddyfile.web /etc/caddy/Caddyfile
EXPOSE 80
