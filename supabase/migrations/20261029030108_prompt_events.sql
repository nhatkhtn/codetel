-- One row per prompt submitted to Claude Code or Codex, including scripted
-- runs; queries decide which prompts count as human:
--   Codex: originator is not codex_exec.
--   Claude Code: the session has no usage row with query_source = 'sdk'.
-- command_name is set for slash commands (Claude Code only).
create table public.prompt_events (
  id text primary key,
  occurred_at timestamptz not null,
  tool text not null check (tool in ('claude_code', 'codex')),
  session_id text not null,
  prompt_length integer not null check (prompt_length >= 0),
  command_name text,
  originator text
);

create index prompt_events_occurred_at_idx on public.prompt_events (occurred_at);

-- Claude Code's request source: 'sdk' for scripted runs (claude -p),
-- 'repl_main_thread' for the interactive main thread, and others.
alter table public.usage_events add column query_source text;

alter table public.prompt_events enable row level security;
revoke all on public.prompt_events from anon, authenticated;
grant select on public.prompt_events to authenticated;
create policy "dashboard users read" on public.prompt_events
  for select to authenticated using ((select private.is_dashboard_user()));

-- ingest gains a prompts argument. It defaults to empty, so the deployed
-- function's two-argument call keeps working until it is redeployed.
drop function private.ingest(jsonb, jsonb);

-- Writes raw records, usage rows and prompts; re-sent batches are no-ops,
-- except that a usage row without query_source takes one from a re-send.
-- All arguments are JSON arrays of objects keyed by column name.
create function private.ingest(p_records jsonb, p_usage jsonb, p_prompts jsonb default '[]'::jsonb)
returns table (records_inserted bigint, usage_inserted bigint, prompts_inserted bigint)
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
      output_tokens, reasoning_output_tokens, reported_cost_usd, query_source
    )
    select
      t.id, t.occurred_at, t.tool, t.model, t.session_id, t.turn_id, t.request_id,
      t.input_tokens, t.cached_input_tokens, t.cache_write_tokens,
      t.cache_write_5m_tokens, t.cache_write_1h_tokens,
      t.output_tokens, t.reasoning_output_tokens, t.reported_cost_usd, t.query_source
    from jsonb_to_recordset(coalesce(p_usage, '[]'::jsonb))
      as t (
        id text, occurred_at timestamptz, tool text, model text, session_id text,
        turn_id text, request_id text,
        input_tokens bigint, cached_input_tokens bigint, cache_write_tokens bigint,
        cache_write_5m_tokens bigint, cache_write_1h_tokens bigint,
        output_tokens bigint, reasoning_output_tokens bigint, reported_cost_usd numeric,
        query_source text
      )
    on conflict (id) do update set query_source = excluded.query_source
      where public.usage_events.query_source is null and excluded.query_source is not null
    returning (xmax = 0) as inserted
  ),
  p as (
    insert into public.prompt_events (id, occurred_at, tool, session_id, prompt_length, command_name, originator)
    select t.id, t.occurred_at, t.tool, t.session_id, t.prompt_length, t.command_name, t.originator
    from jsonb_to_recordset(coalesce(p_prompts, '[]'::jsonb))
      as t (
        id text, occurred_at timestamptz, tool text, session_id text,
        prompt_length integer, command_name text, originator text
      )
    on conflict (id) do nothing
    returning 1
  )
  select (select count(*) from r), (select count(*) from u where inserted), (select count(*) from p);
$$;

revoke all on function private.ingest(jsonb, jsonb, jsonb) from public, anon, authenticated;
