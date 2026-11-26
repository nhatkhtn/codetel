# codetel

Token usage, estimated cost and prompts for Claude Code, Codex, Antigravity and UF NaviGator
CLI, collected from every machine into one Supabase project and shown on a
static dashboard.

```text
Claude Code / Codex built-in OTel exporters, or an Antigravity CLI hook (each machine)
    -> OTLP HTTP/JSON, Authorization: Bearer <upload secret>
    -> Supabase Edge Function `ingest`
    -> Postgres (raw records + one row per model request and per prompt)
    <- dashboard on GitHub Pages (Supabase Auth email link, read-only via RLS)
```

Nothing in this repo runs on the machines: each tool's exporter (for
Antigravity CLI, a `Stop` hook) is configured to send to the Edge Function by
`bootstrap-secrets`. Usage from before export was enabled is imported once per machine by
`backfill/backfill.mjs`.

## Layout

| Path | What |
| --- | --- |
| `supabase/migrations/` | Schema, cost view, `usage_daily()` and `usage_hourly()` RPCs, `private.ingest()`, RLS, raw-record cleanup job |
| `supabase/functions/ingest/` | Edge Function: auth, routing, gzip, DB write |
| `supabase/functions/archive/` | Edge Function: nightly export of raw records to Storage, 180-day expiry |
| `supabase/functions/_shared/telemetry.ts` | OTLP parsing, usage and prompt normalization (pure) |
| `supabase/pricing.sql` | Model prices (USD per million tokens) |
| `backfill/backfill.mjs` | One-off import from local transcripts (Node, no dependencies) |
| `docs/` | Dashboard (plain HTML/JS), served by GitHub Pages |
| `.github/workflows/pages.yml` | Deploys `docs/` to Pages, stamping asset versions |
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
- `query_source` is Claude Code's request source: `sdk` for scripted runs
  (`claude -p`), `repl_main_thread` and others for interactive use.
- IDs:

  | | Claude Code | Codex (OTel) | Codex (backfill) | Antigravity CLI |
  | --- | --- | --- | --- |
  | `id` | native `request_id` | hash of conversation, event time, model, counts | native `response_id` | `agy:<conversationId>:<step_index>` |
  | `session_id` | `session.id` | `conversation.id` | `thread_id` | `conversation.id` |
  | `turn_id` | `prompt.id` (OTel only) | none in logs | `turn_id` | none |

**`prompt_events`**: one row per prompt submitted, without its text:
`prompt_length` (characters), `command_name` for Claude slash commands, and
Codex's `originator` (`codex-tui` interactive, `codex_exec` scripted,
`codex-agent` workers started by the codex-workers skill). Every
prompt is stored; queries decide which count as yours:

- Codex: `originator` is `codex-tui`.
- Claude Code: the session has no usage row with `query_source = 'sdk'`.

IDs are Claude's `prompt.id` (the same as transcripts' `promptId`), a hash of
conversation, event time and length for Codex OTel, and the `UserMessage` item
ID for Codex backfill.

**`telemetry_records`**: raw OTel records as exported (`{resource, scope,
record|span}`), so parsers can be fixed and data re-derived. All log records
are kept except tool events (`tool_decision`, `tool_result` and their
`codex.` versions), which carry no usage, and Codex's connection noise
(`codex.startup_phase`, `codex.websocket_connect`, `codex.websocket_request`,
and every `codex.sse_event` except `response.completed`). Of Codex's ~1000 spans per turn,
only `session_task.turn` (turn totals) is kept. Identity attributes
(`user.*`, `organization.id`), constant resource attributes (SDK, OS, `env`) and
`scope` are removed before storing; `host.name`, `service.name` and
`service.version` stay.

Raw records are archived, not kept in Postgres. A nightly `pg_cron` job
(every 10 minutes from 03:00 to 04:50 UTC) calls the `archive` Edge Function
through `pg_net`; each call writes at most 3 parts and returns, so a busy day drains over
several calls. It writes each
closed UTC day (by `received_at`) to the private `raw-archive` bucket as
`YYYY-MM-DD/part-<run>-<n>.jsonl.gz` (one JSON record per line, up to 5,000
per part), checks the stored size, then deletes those rows. Files older than 180
days are removed. A crash between upload and delete can leave a duplicate part;
record IDs are unique, so readers drop repeats. To re-derive data, download the
day's files, gunzip and replay them. `private.prune_telemetry_records()` (04:17
UTC) deletes anything still in Postgres after 30 days, as a backstop if the
archive stops. Usage rows are kept.

The cron job reads the upload secret from Vault. Set it once:
`select vault.create_secret('<UPLOAD_SECRET>', 'codetel_upload_secret');`

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

**UF NaviGator.** The credential proxy of `bootstrap-secrets` posts one
`navigator.api_request` log to `/v1/logs` (`service.name=navigator-proxy`) for
each model call that returns a `usage` block: `event.timestamp`, `request_id`
(the row ID, generated per call), `session.id` (`navigator:<host>`), `model`,
`input_tokens` (uncached only), `cached_input_tokens`, `output_tokens` and
`reasoning_output_tokens`. NaviGator has no cache-write charge, so
`cache_write_tokens` is 0.

**Antigravity CLI.** Antigravity CLI has no built-in OTel exporter. Its
machine-side hook (installed by `bootstrap-secrets`) posts OTLP/HTTP JSON to
`/v1/logs` with `service.name=antigravity-cli` and two events:

- `antigravity.api_request`, one per finished model response: `event.timestamp`,
  `conversation.id`, `step.index`, `model`, `input_tokens` (uncached input
  only, separate from `cached_input_tokens`) and `output_tokens`. `cost_usd`
  and the cache write and reasoning counts are optional.
- `antigravity.user_prompt`, one per prompt typed by the user:
  `event.timestamp`, `conversation.id`, `step.index`, `prompt_length` and
  `originator`.

The row ID is `agy:<conversation.id>:<step.index>`. The backfill builds the
same ID from the transcripts under `~/.gemini/antigravity-cli/brain`, so a step
reported by both is stored once. The model name carries the reasoning effort
(`gemini-4-hydrogen-high`); the dashboard groups the efforts of a model.

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

Antigravity CLI: the `antigravity` group of `bootstrap-secrets` installs the
hook.

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

By default it scans Claude Code, Codex and Antigravity. `--tool claude_code`,
`--tool codex` or `--tool antigravity` limits the scan to that tool; repeat the
flag to pick several. Use it when the tools' exporters were enabled at
different times.

Backfilled Claude rows have no reported cost and are priced from
`model_pricing`.

Prompts are imported the way live telemetry reports them. Claude: transcript
entries typed by you (`origin.kind = human`), slash commands and scripted
prompts (`promptSource = sdk`; their usage rows get `query_source = sdk`);
tool results, task notifications and command output are skipped. Codex:
`UserMessage` items, with the session's `originator`; subagent sessions
(spawned agents, the command reviewer) are skipped.

## Development

Tests run on Deno with PGlite (Postgres in WASM); keep tool caches out of the
repo:

```sh
export DENO_DIR=$TMPDIR/deno-dir-codetel
deno test --allow-read --allow-write --allow-env --allow-net=registry.npmjs.org,jsr.io tests/
deno check supabase/functions/ingest/index.ts supabase/functions/archive/index.ts
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
password is needed. The API records its own version timestamp for each
migration; rename the local file to match.

The dashboard deploys on every push that touches `docs/`
(`.github/workflows/pages.yml`). Asset links in `docs/index.html` carry
`?v=dev`; the workflow replaces it with the commit, so a cached page never
mixes old and new files.

Dashboard access: sign-ups are disabled. A user is created through the Auth
admin API and added to `public.dashboard_users`.

## Assumptions to revisit

- Codex reports some internal helper conversations as prompts: a hidden
  read-only conversation on a small model, started with each new session
  (likely title generation), sends `codex.user_prompt` with `originator:
  codex-tui`. These count as yours for now (about one per new session).
- Codex cache writes: assumed to be included in Codex's input count and
  priced at the short (30m) cache-write rate. No nonzero cache write has been
  observed yet.
- Claude fast mode, US-only inference (1.1x) and Batch discounts are not
  modeled for backfilled Claude rows (OTel rows carry the actual cost).

## References

- Claude Code telemetry (events, attributes, exporter settings):
  https://code.claude.com/docs/en/monitoring-usage
- Codex telemetry (events, metrics, exporter settings):
  https://github.com/openai/codex/blob/main/codex-rs/otel/README.md
