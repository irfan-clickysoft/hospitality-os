#!/usr/bin/env bash
# Run on the server (the GitHub workflow calls it over SSH):  ./deploy.sh <image-tag>
# Pulls the new images, applies migrations, starts the new version, waits until it is healthy, and goes back to the
# previous version by itself if it is not.
set -euo pipefail
cd "$(dirname "$0")"
NEW="${1:?usage: deploy.sh <image-tag>}"
PREV="$(grep -E '^HOS_TAG=' .env | cut -d= -f2- || true)"
set_tag() { if grep -qE '^HOS_TAG=' .env; then sed -i.bak "s|^HOS_TAG=.*|HOS_TAG=$1|" .env && rm -f .env.bak; else echo "HOS_TAG=$1" >> .env; fi; }
healthy() { for _ in $(seq 1 "${HEALTH_RETRIES:-60}"); do
  s=$(docker compose ps --format '{{.Service}} {{.Health}}' api 2>/dev/null | awk '{print $2}' | sort -u | tr '\n' ' ')
  [ "$s" = "healthy " ] && return 0; sleep 5; done; return 1; }

echo ">> pulling images for $NEW"; set_tag "$NEW"; docker compose pull api web
echo ">> starting"; docker compose up -d --remove-orphans
if healthy; then echo ">> healthy: $NEW is live"; docker image prune -f >/dev/null; exit 0; fi
echo "!! the new version did not become healthy" >&2; docker compose logs --tail=50 api web >&2 || true
if [ -n "$PREV" ] && [ "$PREV" != "$NEW" ]; then echo ">> rolling back to $PREV" >&2; set_tag "$PREV"; docker compose up -d >/dev/null 2>&1; healthy && echo ">> rolled back" >&2; fi
exit 1
