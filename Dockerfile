# syntax=docker/dockerfile:1.7
# Two images from one file:
#   docker build --target api -t hos-api .   the server (NestJS). Runs pending migrations on start, then serves on $PORT.
#   docker build --target web -t hos-web .   the staff app behind Caddy, which also forwards /v1 to the API so the browser sees ONE origin (the session cookie and CSRF check need that).

# ───────────────────────── base ─────────────────────────
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /repo

# ───────────────────────── build (everything, dev dependencies included) ─────────────────────────
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter "@hos/api..." run build && pnpm --filter @hos/staff-web run build

# ───────────────────────── api ─────────────────────────
FROM base AS api
ENV NODE_ENV=production PORT=3000
WORKDIR /app
# production dependencies only: install from the manifests and the lockfile, then add the compiled code
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/staff-web/package.json apps/staff-web/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/domain-types/package.json packages/domain-types/
COPY packages/rates/package.json packages/rates/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile --filter "@hos/api..."
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/packages/auth/dist packages/auth/dist
COPY --from=build /repo/packages/db/dist packages/db/dist
COPY --from=build /repo/packages/db/migrations packages/db/migrations
COPY --from=build /repo/packages/domain-types/dist packages/domain-types/dist
COPY --from=build /repo/packages/rates/dist packages/rates/dist
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# run it with `init: true` (the compose file does) so signals and zombie processes are handled by Docker's built-in init
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# ───────────────────────── web ─────────────────────────
FROM caddy:2-alpine AS web
COPY --from=build /repo/apps/staff-web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
