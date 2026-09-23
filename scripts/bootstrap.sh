#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Engine and the Compose plugin first." >&2
  exit 1
fi
docker compose version >/dev/null

if [ ! -s secrets/gmaps-proxies.txt ]; then
  echo "Missing secrets/gmaps-proxies.txt." >&2
  echo "Import your Webshare file first: ./scripts/import-proxies.sh /path/to/proxies.txt" >&2
  exit 1
fi

if [ -f .env ]; then
  echo ".env already exists; leaving your configuration unchanged."
else
  if [ "$#" -ne 4 ]; then
    echo "Usage with domains: $0 leads.example.com mail.example.com admin@example.com hello@example.com" >&2
    echo "Usage without domains: $0 YOUR_VPS_IP YOUR_VPS_IP admin@example.com hello@example.com" >&2
    echo "Arguments: dashboard host, Posta host, Posta admin email, sender email" >&2
    exit 1
  fi
  app_domain="$1"
  posta_domain="$2"
  posta_admin_email="$3"
  posta_from="$4"
  for hostname in "$app_domain" "$posta_domain"; do
    echo "$hostname" | grep -Eq '^[A-Za-z0-9.-]+$' || { echo "Invalid domain: $hostname" >&2; exit 1; }
  done
  echo "$posta_admin_email" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+$' || { echo "Invalid admin email" >&2; exit 1; }
  echo "$posta_from" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+$' || { echo "Invalid sender email" >&2; exit 1; }
  if echo "$app_domain" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$|^localhost$'; then
    app_url="http://${app_domain}"
    posta_public_url="http://${app_domain}:9000"
  else
    app_url="https://${app_domain}"
    posta_public_url="https://${posta_domain}"
  fi
  cp .env.example .env
  api_token="$(openssl rand -hex 32)"
  postgres_password="$(openssl rand -hex 24)"
  webhook_secret="$(openssl rand -hex 32)"
  posta_db_password="$(openssl rand -hex 24)"
  posta_jwt_secret="$(openssl rand -hex 32)"
  posta_admin_password="$(openssl rand -base64 24 | tr -d '\n/+=' | cut -c1-24)"
  posta_encryption_key="$(openssl rand -hex 32)"

  sed -i "s|API_TOKEN=change-me-with-a-long-random-token|API_TOKEN=${api_token}|" .env
  sed -i "s|POSTGRES_PASSWORD=change-me|POSTGRES_PASSWORD=${postgres_password}|" .env
  sed -i "s|POSTA_WEBHOOK_SECRET=change-me-webhook-secret|POSTA_WEBHOOK_SECRET=${webhook_secret}|" .env
  sed -i "s|POSTA_DB_PASSWORD=change-me-posta-db|POSTA_DB_PASSWORD=${posta_db_password}|" .env
  sed -i "s|POSTA_JWT_SECRET=change-me-with-at-least-32-random-characters|POSTA_JWT_SECRET=${posta_jwt_secret}|" .env
  sed -i "s|POSTA_ADMIN_PASSWORD=change-me-with-a-strong-password|POSTA_ADMIN_PASSWORD=${posta_admin_password}|" .env
  sed -i "s|POSTA_ENCRYPTION_KEY=change-me-with-32-bytes-of-random-data|POSTA_ENCRYPTION_KEY=${posta_encryption_key}|" .env
  sed -i "s|DOMAIN=localhost|DOMAIN=${app_domain}|" .env
  sed -i "s|POSTA_DOMAIN=posta.example.com|POSTA_DOMAIN=${posta_domain}|" .env
  sed -i "s|APP_URL=http://localhost|APP_URL=${app_url}|" .env
  sed -i "s|POSTA_PUBLIC_URL=http://localhost:9000|POSTA_PUBLIC_URL=${posta_public_url}|" .env
  sed -i "s|POSTA_ADMIN_EMAIL=admin@example.com|POSTA_ADMIN_EMAIL=${posta_admin_email}|" .env
  sed -i "s|POSTA_FROM=hello@example.com|POSTA_FROM=${posta_from}|" .env
  chmod 600 .env
  echo "Created .env with domains, email identities, and random secrets."
fi

mkdir -p backups
docker compose config --quiet
docker compose up -d --build
docker compose ps

echo
echo "LeadForge is starting. Open $(sed -n 's/^APP_URL=//p' .env | tail -1)"
echo "Use the API_TOKEN from .env when the dashboard asks for it."
