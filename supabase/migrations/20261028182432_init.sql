-- codetel schema: raw OTel records, normalized per-request usage, model prices.
--
-- Writes happen only through private.ingest(), called by the ingest Edge
-- Function over a direct database connection. The `private` schema is not
-- exposed by the Data API. Dashboard users read through RLS-protected tables,
-- the usage_with_cost view, and the usage_daily() RPC.

create schema if not exists private;
revoke all on schema private from public;

-- Raw telemetry records, kept so parsers can be improved and data re-derived.
-- payload holds {resource, scope, record|span} exactly as exported.
create table public.telemetry_records (
  id text primary key,
  received_at timestamptz not null default now(),
  occurred_at timestamptz,
  name text not null,
  payload jsonb not null
);

-- One row per model API request.
-- input_tokens is uncached input only; cached_input_tokens are cache reads;
-- cache_write_tokens are cache writes. The three never overlap.
-- cache_write_5m/1h subdivide cache_write_tokens (Claude only).
-- reasoning_output_tokens is a breakdown of output_tokens, never added to it.
create table public.usage_events (
  id text primary key,
  occurred_at timestamptz not null,
  tool text not null check (tool in ('claude_code', 'codex')),
  model text not null,
  session_id text not null,
  turn_id text,
  request_id text,
  input_tokens bigint not null check (input_tokens >= 0),
  cached_input_tokens bigint not null check (cached_input_tokens >= 0),
  cache_write_tokens bigint not null check (cache_write_tokens >= 0),
  cache_write_5m_tokens bigint check (cache_write_5m_tokens >= 0),
  cache_write_1h_tokens bigint check (cache_write_1h_tokens >= 0),
  output_tokens bigint not null check (output_tokens >= 0),
  reasoning_output_tokens bigint check (reasoning_output_tokens >= 0),
  reported_cost_usd numeric
);

create index usage_events_occurred_at_idx on public.usage_events (occurred_at);

-- Prices in USD per million tokens.
-- A rate set applies from effective_from until a later effective_from for the
-- same model. Within a rate set, the row with the highest min_prompt_tokens
-- not above the request's prompt size applies; every rate set needs a row
-- with min_prompt_tokens = 0.
-- Cache write rates: short = Claude 5m / OpenAI 30m, long = Claude 1h / OpenAI 12h.
create table public.model_pricing (
  model text not null,
  effective_from timestamptz not null,
  min_prompt_tokens bigint not null default 0 check (min_prompt_tokens >= 0),
  input_rate numeric not null,
  cached_input_rate numeric not null,
  cache_write_short_rate numeric not null,
  cache_write_long_rate numeric,
  output_rate numeric not null,
  primary key (model, effective_from, min_prompt_tokens)
);

-- Supabase Auth users allowed to read the dashboard data.
create table public.dashboard_users (
  user_id uuid primary key
);

create function private.is_dashboard_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.dashboard_users where user_id = (select auth.uid())
  );
$$;

-- Prompt size used for size-tiered prices: all input, cached or not.
create view public.usage_with_cost
with (security_invoker = true)
as
select
  u.*,
  coalesce(
    u.reported_cost_usd,
    (
      u.input_tokens * p.input_rate
      + u.cached_input_tokens * p.cached_input_rate
      + coalesce(u.cache_write_5m_tokens, u.cache_write_tokens - coalesce(u.cache_write_1h_tokens, 0))
        * p.cache_write_short_rate
      + coalesce(u.cache_write_1h_tokens, 0)
        * coalesce(p.cache_write_long_rate, p.cache_write_short_rate)
      + u.output_tokens * p.output_rate
    ) / 1000000
  ) as estimated_cost_usd
from public.usage_events u
left join lateral (
  select mp.*
  from public.model_pricing mp
  where mp.model = u.model
    and mp.effective_from <= u.occurred_at
    and mp.min_prompt_tokens <= u.input_tokens + u.cached_input_tokens + u.cache_write_tokens
  order by mp.effective_from desc, mp.min_prompt_tokens desc
  limit 1
) p on true;

-- Daily totals for the dashboard, bucketed by day in the viewer's time zone.
-- Unknown costs are left out of cost_usd and counted in unpriced_requests.
create function public.usage_daily(p_from timestamptz, p_to timestamptz, p_tz text default 'UTC')
returns table (
  day date,
  tool text,
  model text,
  requests bigint,
  input_tokens numeric,
  cached_input_tokens numeric,
  cache_write_tokens numeric,
  output_tokens numeric,
  reasoning_output_tokens numeric,
  cost_usd numeric,
  unpriced_requests bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    (u.occurred_at at time zone p_tz)::date,
    u.tool,
    u.model,
    count(*),
    sum(u.input_tokens),
    sum(u.cached_input_tokens),
    sum(u.cache_write_tokens),
    sum(u.output_tokens),
    coalesce(sum(u.reasoning_output_tokens), 0),
    coalesce(sum(u.estimated_cost_usd), 0),
    count(*) filter (where u.estimated_cost_usd is null)
  from public.usage_with_cost u
  where u.occurred_at >= p_from and u.occurred_at < p_to
  group by 1, 2, 3
  order by 1, 2, 3;
$$;

-- Writes raw records and usage rows; re-sent batches are no-ops.
-- Both arguments are JSON arrays of objects keyed by column name.
create function private.ingest(p_records jsonb, p_usage jsonb)
returns table (records_inserted bigint, usage_inserted bigint)
language sql
set search_path = ''
as $$
  with r as (
    insert into public.telemetry_records (id, occurred_at, name, payload)
    select t.id, t.occurred_at, t.name, t.payload
    from jsonb_to_recordset(coalesce(p_records, '[]'::jsonb))
      as t (id text, occurred_at timestamptz, name text, payload jsonb)
    on conflict (id) do nothing
    returning 1
  ),
  u as (
    insert into public.usage_events (
      id, occurred_at, tool, model, session_id, turn_id, request_id,
      input_tokens, cached_input_tokens, cache_write_tokens,
      cache_write_5m_tokens, cache_write_1h_tokens,
      output_tokens, reasoning_output_tokens, reported_cost_usd
    )
    select
      t.id, t.occurred_at, t.tool, t.model, t.session_id, t.turn_id, t.request_id,
      t.input_tokens, t.cached_input_tokens, t.cache_write_tokens,
      t.cache_write_5m_tokens, t.cache_write_1h_tokens,
      t.output_tokens, t.reasoning_output_tokens, t.reported_cost_usd
    from jsonb_to_recordset(coalesce(p_usage, '[]'::jsonb))
      as t (
        id text, occurred_at timestamptz, tool text, model text, session_id text,
        turn_id text, request_id text,
        input_tokens bigint, cached_input_tokens bigint, cache_write_tokens bigint,
        cache_write_5m_tokens bigint, cache_write_1h_tokens bigint,
        output_tokens bigint, reasoning_output_tokens bigint, reported_cost_usd numeric
      )
    on conflict (id) do nothing
    returning 1
  )
  select (select count(*) from r), (select count(*) from u);
$$;

-- Access: RLS on every table; dashboard users may only read.
alter table public.telemetry_records enable row level security;
alter table public.usage_events enable row level security;
alter table public.model_pricing enable row level security;
alter table public.dashboard_users enable row level security;

revoke all on public.telemetry_records, public.usage_events, public.model_pricing,
  public.dashboard_users, public.usage_with_cost from anon, authenticated;
grant select on public.telemetry_records, public.usage_events, public.model_pricing,
  public.usage_with_cost to authenticated;

create policy "dashboard users read" on public.telemetry_records
  for select to authenticated using ((select private.is_dashboard_user()));
create policy "dashboard users read" on public.usage_events
  for select to authenticated using ((select private.is_dashboard_user()));
create policy "dashboard users read" on public.model_pricing
  for select to authenticated using ((select private.is_dashboard_user()));

grant usage on schema private to authenticated;
revoke all on function private.is_dashboard_user() from public, anon;
grant execute on function private.is_dashboard_user() to authenticated;
revoke all on function private.ingest(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.usage_daily(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.usage_daily(timestamptz, timestamptz, text) to authenticated;
