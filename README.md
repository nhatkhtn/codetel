# codetel

Token usage and estimated cost for Claude Code and Codex, collected from every
machine into one Supabase project and shown on a static dashboard.

```text
Claude Code / Codex built-in OTel exporters (each machine)
    -> OTLP HTTP/JSON, Authorization: Bearer <upload secret>
    -> Supabase Edge Function `ingest`
    -> Postgres (raw records + one row per model request)
    <- dashboard on GitHub Pages (Supabase Auth email link, read-only via RLS)
```

Nothing runs on the machines besides the tools themselves: each tool's exporter
is configured to send to the Edge Function. Usage from before export was
enabled is imported once per machine by `backfill/backfill.mjs`.

## Layout

| Path | What |
| --- | --- |
| `supabase/migrations/` | Schema, cost view, `usage_daily()` and `usage_hourly()` RPCs, `private.ingest()`, RLS |
| `supabase/functions/ingest/` | Edge Function: auth, routing, gzip, DB write |
| `supabase/functions/_shared/telemetry.ts` | OTLP parsing and usage normalization (pure) |
| `supabase/pricing.sql` | Model prices (USD per million tokens) |
| `backfill/backfill.mjs` | One-off import from local transcripts (Node, no dependencies) |
| `docs/` | Dashboard (plain HTML/JS), served by GitHub Pages |
| `tests/` | Deno tests; scrubbed OTLP fixtures; fixture scrubber |

## Data

**`usage_events`**: one row per model API request. Grouping by day, tool or
model happens in the dashboard.

- `input_tokens` is uncached input only. `cached_input_tokens` (cache reads)
  and `cache_write_tokens` are separate, so the three never overlap.
  `cache_write_5m_tokens` / `cache_write_1h_tokens` split cache writes for
  Claude. `reasoning_output_tokens` is part of `output_tokens`, never added
  to it.
- `reported_cost_usd` is Claude Code's own cost, present for OTel rows.
- IDs:

  | | Claude Code | Codex (OTel) | Codex (backfill) |
  | --- | --- | --- | --- |
  | `id` | native `request_id` | hash of conversation, event time, model, counts | native `response_id` |
  | `session_id` | `session.id` | `conversation.id` | `thread_id` |
  | `turn_id` | `prompt.id` (OTel only) | none in logs | `turn_id` |

**`telemetry_records`**: raw OTel records as exported (`{resource, scope,
record|span}`), so parsers can be fixed and data re-derived. All log records
are kept except Codex `codex.tool_result` (tool arguments and output). Of
Codex's ~1000 spans per turn, only `session_task.turn` (turn totals) is kept.

**`model_pricing`** and the **`usage_with_cost`** view: cost is computed at
query time. Reported cost wins; otherwise the rate set in effect at the
request time applies, choosing the size tier from the prompt size (all input
tokens). A model with no price keeps its tokens and has a NULL cost; the
dashboard leaves it out of sums and says pricing is incomplete.

## How usage is counted

**Codex.** Each model response emits a `codex.sse_event` log with
`event.kind=response.completed`. The WebSocket connection warmup
(`generate=false`) emits one too, and it is not inference. Codex attaches
`model_reasoning_effort` to every real request (from config or the model's
default level) and never to the warmup, so completion events without it are
skipped. In test captures the remaining per-request rows sum exactly to the
turn span's token totals. Models without a default reasoning level would
break this rule; none are in use.

**Claude Code.** Each `api_request` log carries final usage, cost and IDs.

## Machine setup

Exporter settings and the upload secret are distributed by `bootstrap-secrets`.
`<secret>` below is the upload secret.

Claude Code (`env` in `~/.claude/settings.json`):

```text
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=none
OTEL_TRACES_EXPORTER=none
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=https://cmbnmbrudyozwsdmecrt.supabase.co/functions/v1/ingest
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <secret>
```

Codex (`~/.codex/config.toml`):

```toml
[otel]
log_user_prompt = false
metrics_exporter = "none"
exporter = { otlp-http = { endpoint = "https://cmbnmbrudyozwsdmecrt.supabase.co/functions/v1/ingest/v1/logs", protocol = "json", headers = { "authorization" = "Bearer <secret>" } } }
trace_exporter = { otlp-http = { endpoint = "https://cmbnmbrudyozwsdmecrt.supabase.co/functions/v1/ingest/v1/traces", protocol = "json", headers = { "authorization" = "Bearer <secret>" } } }
```

## Backfill

Run once per machine, after its exporters are on. `--before` is when export
was enabled on that machine; only earlier usage is imported, so no request
is counted twice. Re-running is safe.

```sh
node backfill/backfill.mjs --before 2026-10-28T19:00:00Z --dry-run   # summary only
CODETEL_INGEST_URL=https://cmbnmbrudyozwsdmecrt.supabase.co/functions/v1/ingest \
CODETEL_UPLOAD_SECRET=<secret> \
node backfill/backfill.mjs --before 2026-10-28T19:00:00Z
```

Backfilled Claude rows have no reported cost and are priced from
`model_pricing`.

## Development

Tests run on Deno with PGlite (Postgres in WASM); keep tool caches out of the
repo:

```sh
export DENO_DIR=$TMPDIR/deno-dir-codetel
deno test --allow-read --allow-write --allow-env --allow-net=registry.npmjs.org,jsr.io tests/
deno check supabase/functions/ingest/index.ts
```

Fixtures come from local OTLP captures, scrubbed by
`node tests/make_fixtures.mjs <otlp.jsonl> <name> ...`. Never commit raw
captures: they hold account identifiers.

## Deploy

The Supabase CLI runs through `npx supabase@2.122.0` with
`SUPABASE_ACCESS_TOKEN` from `.env` (git-ignored).

```sh
npx supabase@2.122.0 functions deploy ingest --project-ref cmbnmbrudyozwsdmecrt --use-api
npx supabase@2.122.0 secrets set --project-ref cmbnmbrudyozwsdmecrt --env-file <file with UPLOAD_SECRET=...>
```

Migrations and `supabase/pricing.sql` are applied through the Management API
(`/v1/projects/{ref}/database/migrations` and `/database/query`); no database
password is needed.

Dashboard access: sign-ups are disabled. A user is created through the Auth
admin API and added to `public.dashboard_users`.

## Assumptions to revisit

- Codex cache writes: assumed to be included in Codex's input count and
  priced at the short (30m) cache-write rate. No nonzero cache write has been
  observed yet.
- Claude fast mode, US-only inference (1.1x) and Batch discounts are not
  modeled for backfilled Claude rows (OTel rows carry the actual cost).
- Raw record retention is unlimited for now; watch storage
  (about 40 KB per Codex turn).
