# LeadForge

LeadForge is a self-hosted business discovery, research, qualification, contact-enrichment, and email-operations platform designed for a single 8 GB VPS. It uses a React dashboard, Fastify API, PostgreSQL, Redis/BullMQ workers, Ollama, SearXNG, Google Maps Scraper, Posta, and Caddy.

The dashboard accepts comma-separated business types and cities:

```text
Country: India
Cities: Mumbai, Bangalore, Bhubaneswar
Business types: dentist, agency, clinic, manufacturer
Target: 5000
```

Each business moves independently through the queues. Qualification can therefore begin while discovery and crawling are still running; the system does not load or process an entire 5,000-record batch in memory.

## Quick VPS deployment

Recommended host: Ubuntu 24.04, 4–6 vCPU, 8 GB RAM, 80+ GB NVMe, a dedicated IPv4 address, and 2–4 GB swap. Docker Engine, the Docker Compose plugin, Git, and OpenSSL are the only host dependencies.

```bash
git clone YOUR_REPOSITORY_URL leadforge
cd leadforge
chmod +x scripts/*.sh
./scripts/import-proxies.sh /path/to/webshare-proxies.txt
./scripts/bootstrap.sh leads.example.com mail.example.com admin@example.com hello@example.com
```

The four arguments are the dashboard host, Posta host, Posta administrator email, and sender address. A domain is optional for an initial safe-mode test. Without one, pass the VPS IP twice:

```bash
./scripts/bootstrap.sh 203.0.113.10 203.0.113.10 admin@example.com hello@example.com
```

This exposes only the dashboard at `http://203.0.113.10`. Posta remains private in IP mode because its administrator login must not travel over plain HTTP. Add domains before configuring Posta or enabling live campaigns so Caddy can issue trusted certificates and email DNS can be configured.

### VPS with an existing Nginx installation

When host Nginx already owns ports 80 and 443, use the VPS override instead of the bundled Caddy edge service:

```bash
docker compose -f compose.yml -f compose.vps.yml up -d --build
```

This publishes the React container only on `127.0.0.1:8080` and the API only on `127.0.0.1:3001`. PostgreSQL, Redis, Maps, SearXNG, and Ollama remain private. Install `deploy/nginx-ritzla.in.conf` as the host virtual server after updating its domain and certificate paths if required. Test both loopback services and run `nginx -t` before reloading Nginx.

The bootstrap script creates `.env`, generates random secrets, validates the Compose file, builds the application, downloads images/model, starts the services, and prints their status. Before public use, review these values:

The proxy importer accepts Webshare's `host:port:user:password` format or complete `http://`, `https://`, and SOCKS proxy URLs. It writes a normalized, mode-`600` file to `secrets/gmaps-proxies.txt`. That directory is excluded from Git and Docker build contexts. Compose mounts the file read-only only into the Maps scraper, so these proxies are used for initial Google Maps discovery and not for website crawling, AI, search, or email delivery.

```dotenv
DOMAIN=leads.example.com
APP_URL=https://leads.example.com
POSTA_DOMAIN=mail.example.com
POSTA_PUBLIC_URL=https://mail.example.com
POSTA_FROM=hello@example.com
POSTA_ADMIN_EMAIL=admin@example.com
PROVIDER_MODE=safe
PIPELINE_STOP_AFTER=enrichment
ENABLE_EMAIL_SENDING=false
```

Create DNS `A` records for both domains pointing to the VPS. Open TCP ports 80 and 443. Open TCP 25 only if the VPS provider allows it and Posta will receive email directly. Do not expose ports 5432, 6379, 8080, 9000, or 11434.

Open `https://leads.example.com` and enter `API_TOKEN` from `.env`. The initial configuration is deliberately safe:

- `PROVIDER_MODE=safe` creates deterministic demonstration businesses and never performs public research.
- `PIPELINE_STOP_AFTER=enrichment` stops after finding and verifying candidate emails.
- `ENABLE_EMAIL_SENDING=false` is a second lock that prevents all sending.
- Posta and its supporting database/Redis are not started unless the optional `mail` profile is enabled.
- Switch to live mode only after the providers, sending domain, suppression behavior, and local law have been tested.

Useful commands:

```bash
docker compose ps
docker compose logs -f api worker
docker compose stats
docker compose restart worker
./scripts/update.sh
```

## Architecture

```text
Browser → Caddy → React / Fastify
                         │
                PostgreSQL + Redis/BullMQ
                         │
 discovery → filter → HTTP/Chromium crawl → Ollama qualification
                         │
                 SearXNG research → email enrichment
                         │
                  eligibility → draft/Posta
                         │
                  reply webhook → suppression/CRM
```

PostgreSQL is the source of truth. Redis contains only recoverable queue state. BullMQ runs separate queues for discovery, filtering, crawling, AI qualification, research, enrichment, and campaigns. Deduplication IDs prevent the same stage from being queued twice for one business.

The worker uses ordinary HTTP first and launches Chromium only when a site returns too little meaningful HTML. A process-wide lock permits only one fallback browser at a time. Ollama and the Maps scraper also run at concurrency one by default.

Ollama is capped to one vCPU by default with `OLLAMA_CPU_LIMIT=1.0`. Qwen is unloaded immediately after every request, so the Ollama API remains idle between queued qualification jobs instead of retaining the model or consuming inference CPU continuously. Lowering the quota further reduces impact but increases qualification time.

### Memory budget

Compose applies hard limits. The default research/enrichment stack stays below the full mail-enabled budget and leaves additional room for the operating system and Docker:

| Group | Hard limit |
| --- | ---: |
| Ollama/Qwen3 4B | 3.2 GB |
| Application API + worker + web + Caddy | 1.05 GB |
| Maps scraper + SearXNG | 832 MB |
| LeadForge PostgreSQL + Redis | 672 MB |
| Optional Posta + its PostgreSQL/Redis | 640 MB (not started by default) |
| Backup job | 96 MB |

`docker compose stats` shows actual use. If the host starts swapping heavily, set `CRAWL_CONCURRENCY=2`, then restart the worker. Do not increase AI or browser parallelism on an 8 GB VPS.

## Going live

### Discovery

The bundled `gosom/google-maps-scraper` service is private to the Compose network. The adapter submits all `business type × city × country` queries, follows asynchronous jobs, downloads CSV results, normalizes them, and deduplicates by source ID. Public sites and Maps can change their behavior, throttle, or block automation; test a small request before attempting thousands and comply with applicable terms.

Set:

```dotenv
PROVIDER_MODE=live
MAX_DISCOVERY_RESULTS=5000
```

Restart the API and worker after configuration changes:

```bash
docker compose up -d --force-recreate api worker
```

### Research and AI

SearXNG is only reachable inside Docker and allows JSON results. Ollama automatically pulls `qwen3:4b`; structured output is constrained to a JSON schema, temperature is low, context is limited to 4,096 tokens, and only stored evidence is sent to the model.

Search results are evidence, not guaranteed identity. Low-confidence or ambiguous contacts exit as `NO_CONTACT` instead of being guessed.

### Email enrichment

The built-in adapter harvests published website addresses, applies name affinity, generates a `first.last` candidate only when a company domain exists, and checks MX records. A generated candidate without public evidence is marked `RISKY`; only `VALID` addresses can enter the campaign queue. This conservative behavior avoids pretending that an MX record proves a mailbox exists.

SMTP recipient probing is intentionally not performed by default: many providers treat it as abusive, many domains are catch-all, and VPS port restrictions make results unreliable. If `waterdoog/email-enrich` is adopted later, keep it behind this adapter and move its in-memory cache/rate limits into Redis before scaling.

### Posta and replies

Posta is isolated in the optional `mail` Compose profile. The normal bootstrap does not build or start it. When a domain and mail configuration are ready, start it explicitly:

```bash
docker compose --profile mail up -d --build posta posta-db posta-redis
```

Posta is then available at `https://POSTA_DOMAIN`. Sign in with `POSTA_ADMIN_EMAIL` and `POSTA_ADMIN_PASSWORD` from `.env`, then:

1. Add and verify the sending domain/SMTP configuration.
2. Create an API key and copy it into `POSTA_API_KEY` in `.env`.
3. Configure a signed inbound webhook to `https://DOMAIN/webhooks/posta` with the value of `POSTA_WEBHOOK_SECRET` in `X-Webhook-Secret`.
4. Configure SPF, DKIM, DMARC, MX, TLS, and the VPS PTR/reverse-DNS record.
5. Start with a low `DAILY_SEND_LIMIT`; enable sending only after test delivery, bounce, unsubscribe, and reply flows all work.

```dotenv
POSTA_API_KEY=your-created-key
ENABLE_EMAIL_SENDING=true
DAILY_SEND_LIMIT=100
```

The campaign worker applies both an eligibility check and a global BullMQ daily limiter. Replies immediately become CRM events. Unsubscribe and not-interested replies are added to the suppression table.

## Backups and recovery

The backup container writes a PostgreSQL custom-format dump to `./backups` once per day and keeps seven days by default. Copy this directory to another machine or object store; a backup on the same disk is not disaster recovery.

```bash
ls -lh backups/
./scripts/restore.sh backups/leadforge-YYYYMMDDTHHMMSSZ.dump
```

Docker volumes preserve PostgreSQL, Redis, Ollama, Posta, Caddy, SearXNG, and Maps data across container restarts. Never run `docker compose down -v` unless permanent data deletion is intended.

## Development

Run PostgreSQL and Redis, update local connection URLs if needed, then:

```bash
npm install
npm run dev
npm test
npm run typecheck
npm run build
```

The API listens on port 3001 and Vite on 5173. Database initialization scripts are in `database/`. On an already-initialized production database, apply new numbered migrations explicitly rather than recreating the volume.

## Why code instead of n8n?

Code is the better fit for this workload. BullMQ provides explicit concurrency, retries, rate limits, deduplication, backpressure, and stage ownership without keeping thousands of visual workflow executions in memory. Types and tests make provider changes easier to review, and PostgreSQL transactions keep eligibility and suppression logic auditable.

n8n would be faster for a tiny proof of concept and convenient for ad-hoc integrations. At this scale its workflow history, node-by-node payload copies, debugging, versioning, and execution-memory overhead become operational drawbacks. The code approach costs more initial engineering but gives tighter RAM control and a cleaner path to multiple workers or VPSs.

## Known trade-offs

- One 8 GB VPS is economical but is also one failure domain. Database, research, AI, and email delivery compete for CPU and disk.
- CPU-only 4B inference is slower than a hosted model or GPU. Queues absorb the delay, but they do not make inference faster.
- Public scraping is brittle and may conflict with a site's terms or local rules. Selectors and upstream API payloads can change.
- Self-hosted email is operationally demanding. Correct DNS does not guarantee inbox placement, and many VPS providers block port 25.
- SearXNG results vary with upstream engines and can be rate-limited.
- Search evidence can misidentify a person. The confidence threshold should favor `NO_CONTACT` over a wrong recipient.
- AI scores are prioritization aids, not facts. The system stores rationale and source evidence for review.
- A single API token is suitable for one operator, not a multi-tenant SaaS. Add user accounts/RBAC before giving access to a team.

## Responsible operation

Use a lawful basis for collecting and contacting people, retain only necessary public business data, honor opt-outs immediately, and follow applicable privacy, marketing, and platform rules. Maps phone numbers are not permission for automated WhatsApp or SMS outreach. Keep AI replies as drafts until their accuracy and tone have been reviewed.

Primary upstream references: [Google Maps Scraper](https://github.com/gosom/google-maps-scraper), [BullMQ](https://docs.bullmq.io/), [Ollama](https://ollama.com/), [SearXNG](https://github.com/searxng/searxng), and [Posta](https://github.com/goposta/posta).
