# Pipeline controls and capacity

- Pause preserves PostgreSQL progress, the current Maps job ID and queued work. Active external requests may finish, but their next stage is deferred. Resume continues within 30 seconds, without consuming retry attempts for a pause.
- Stop is permanent for that run, preserves collected leads, cancels pending stages and prevents new downstream processing. An already submitted Maps batch can finish within its five-minute limit; stopping does not terminate the shared scraper used by other runs.
- Discovery processes one search batch at a time, saves each batch and deduplicates before advancing toward the target. A requested 3,000 is a target, not a promise that Maps has 3,000 unique matching listings. Exhausted search coverage is explicitly reported. More cities or categories increase coverage.
- PostgreSQL is the source of progress. Every 30 seconds the worker repairs orphaned queued stages using BullMQ deduplication. A run stays active until discovery, company stages and requested AI explanations settle.
- Evidence-based weighted/Bayesian ranking runs before optional AI explanations. AI does not invent new scores or re-route a business after research has started. Failed/timeout AI requests retain the rule assessment and are marked as fallback. Evaluated, qualified and AI-explained counts are different metrics.
- Run detail and qualification lists are paginated in batches of 100. Queue history is bounded to 500 recent successful/failed jobs per queue; durable lead data stays in PostgreSQL.
- The core VPS containers have a combined memory cap of approximately 6.3 GiB, excluding host services and optional mail. Maps has one browser and a 1 GiB cap. Ollama remains at one CPU, one request, a 3,200 MiB cap and unloads after a request. An 8 GiB machine still needs monitoring for the OS and other applications.

## Deployment

Apply `database/005_pipeline_progress.sql` to an existing database before starting the new API/worker. Build `api` and `web` (the worker shares the API image), then use **both** `compose.yml` and `compose.vps.yml` when recreating services. Do not replace host Nginx or unrelated sites.

## Isolated integration check

The built `apps/server/dist/pipeline-integration.js` harness requires `RUN_PIPELINE_INTEGRATION=1` and a read-only mount of this repository's database migrations at `/app/database`. Run it in a separate, resource-limited worker container. It creates a temporary test database, requires Redis DB 15 to be empty, forces safe providers and disables sending. It checks 3,000 synthetic businesses, pause/resume, stop, recovery, pagination and synchronized counters; then removes only its test database and queues. It does **not** benchmark real Maps/AI throughput.
