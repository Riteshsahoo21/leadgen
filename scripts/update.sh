#!/usr/bin/env bash
set -euo pipefail

docker compose pull --ignore-buildable
docker compose build --pull api web posta
docker compose up -d --remove-orphans
docker image prune -f
docker compose ps
