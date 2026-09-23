#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 backups/leadforge-TIMESTAMP.dump" >&2
  exit 1
fi

backup_file="$1"
case "$backup_file" in
  backups/*.dump) ;;
  *) echo "Backup must be a .dump file inside ./backups" >&2; exit 1 ;;
esac

if [ ! -f "$backup_file" ]; then
  echo "Backup not found: $backup_file" >&2
  exit 1
fi

echo "This replaces data in the configured LeadForge database."
read -r -p "Type RESTORE to continue: " confirmation
[ "$confirmation" = "RESTORE" ] || exit 1

docker compose exec -T postgres pg_restore \
  --username "${POSTGRES_USER:-leadforge}" \
  --dbname "${POSTGRES_DB:-leadforge}" \
  --clean --if-exists --no-owner < "$backup_file"
