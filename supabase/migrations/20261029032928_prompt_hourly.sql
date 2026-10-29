-- Hourly counts of your prompts, bucketed by local day and hour in the
-- viewer's time zone. Feeds the calendar (summed per day) and its weekday and
-- hour-of-day breakdown; replaces prompt_daily.
drop function public.prompt_daily(timestamptz, timestamptz, text);

create function public.prompt_hourly(p_from timestamptz, p_to timestamptz, p_tz text default 'UTC')
returns table (
  day date,
  hour int,
  tool text,
  prompts bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    (p.occurred_at at time zone p_tz)::date,
    extract(hour from p.occurred_at at time zone p_tz)::int,
    p.tool,
    count(*)
  from public.human_prompts p
  where p.occurred_at >= p_from and p.occurred_at < p_to
  group by 1, 2, 3
  order by 1, 2, 3;
$$;

revoke all on function public.prompt_hourly(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.prompt_hourly(timestamptz, timestamptz, text) to authenticated;
