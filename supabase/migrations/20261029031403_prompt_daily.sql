-- Prompts that count as yours: Codex prompts outside scripted runs
-- (codex_exec), and Claude Code prompts from sessions with no scripted
-- (query_source 'sdk') request.
create view public.human_prompts
with (security_invoker = true)
as
select p.*
from public.prompt_events p
where case p.tool
  when 'codex' then p.originator is distinct from 'codex_exec'
  else not exists (
    select 1 from public.usage_events u
    where u.session_id = p.session_id and u.tool = p.tool and u.query_source = 'sdk'
  )
end;

revoke all on public.human_prompts from anon, authenticated;
grant select on public.human_prompts to authenticated;

-- Daily counts of your prompts for the dashboard's calendar, bucketed by day
-- in the viewer's time zone.
create function public.prompt_daily(p_from timestamptz, p_to timestamptz, p_tz text default 'UTC')
returns table (
  day date,
  tool text,
  prompts bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select (p.occurred_at at time zone p_tz)::date, p.tool, count(*)
  from public.human_prompts p
  where p.occurred_at >= p_from and p.occurred_at < p_to
  group by 1, 2
  order by 1, 2;
$$;

revoke all on function public.prompt_daily(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.prompt_daily(timestamptz, timestamptz, text) to authenticated;
