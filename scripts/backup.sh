#!/usr/bin/env sh
set -eu

mkdir -p /backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  --host postgres \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --format custom \
  --file "/backups/leadforge-${stamp}.dump"

find /backups -type f -name 'leadforge-*.dump' -mtime "+${BACKUP_RETENTION_DAYS:-7}" -delete
