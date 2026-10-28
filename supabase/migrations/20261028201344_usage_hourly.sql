-- Hourly totals for the dashboard's time-of-day and day-of-week heatmap,
-- bucketed by local day and hour in the viewer's time zone.
create function public.usage_hourly(p_from timestamptz, p_to timestamptz, p_tz text default 'UTC')
returns table (
  day date,
  hour int,
  requests bigint,
  tokens numeric,
  cost_usd numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    (u.occurred_at at time zone p_tz)::date,
    extract(hour from u.occurred_at at time zone p_tz)::int,
    count(*),
    sum(u.input_tokens + u.cached_input_tokens + u.cache_write_tokens + u.output_tokens),
    coalesce(sum(u.estimated_cost_usd), 0)
  from public.usage_with_cost u
  where u.occurred_at >= p_from and u.occurred_at < p_to
  group by 1, 2
  order by 1, 2;
$$;

revoke all on function public.usage_hourly(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.usage_hourly(timestamptz, timestamptz, text) to authenticated;
