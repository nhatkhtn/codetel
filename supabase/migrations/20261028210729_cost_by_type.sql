-- Cost split by token type, so the dashboard can show what each type costs.
-- When the tool reported its own cost, the parts are scaled to add up to it.
-- Rows without a price have no parts; their reported cost stays unsplit.
create or replace view public.usage_with_cost
with (security_invoker = true)
as
select
  u.*,
  coalesce(u.reported_cost_usd, c.total) as estimated_cost_usd,
  c.input * c.scale as input_cost_usd,
  c.cache_read * c.scale as cache_read_cost_usd,
  c.cache_write * c.scale as cache_write_cost_usd,
  c.output * c.scale as output_cost_usd
from public.usage_events u
left join lateral (
  select mp.*
  from public.model_pricing mp
  where mp.model = u.model
    and mp.effective_from <= u.occurred_at
    and mp.min_prompt_tokens <= u.input_tokens + u.cached_input_tokens + u.cache_write_tokens
  order by mp.effective_from desc, mp.min_prompt_tokens desc
  limit 1
) p on true
cross join lateral (
  select
    parts.*,
    parts.input + parts.cache_read + parts.cache_write + parts.output as total,
    case
      when u.reported_cost_usd is not null and parts.input + parts.cache_read + parts.cache_write + parts.output > 0
        then u.reported_cost_usd / (parts.input + parts.cache_read + parts.cache_write + parts.output)
      else 1
    end as scale
  from (
    select
      u.input_tokens * p.input_rate / 1000000 as input,
      u.cached_input_tokens * p.cached_input_rate / 1000000 as cache_read,
      (
        coalesce(u.cache_write_5m_tokens, u.cache_write_tokens - coalesce(u.cache_write_1h_tokens, 0))
          * p.cache_write_short_rate
        + coalesce(u.cache_write_1h_tokens, 0)
          * coalesce(p.cache_write_long_rate, p.cache_write_short_rate)
      ) / 1000000 as cache_write,
      u.output_tokens * p.output_rate / 1000000 as output
  ) parts
) c;

-- The return type changes, so the function is recreated.
drop function public.usage_daily(timestamptz, timestamptz, text);

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
  unpriced_requests bigint,
  input_cost_usd numeric,
  cache_read_cost_usd numeric,
  cache_write_cost_usd numeric,
  output_cost_usd numeric
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
    count(*) filter (where u.estimated_cost_usd is null),
    coalesce(sum(u.input_cost_usd), 0),
    coalesce(sum(u.cache_read_cost_usd), 0),
    coalesce(sum(u.cache_write_cost_usd), 0),
    coalesce(sum(u.output_cost_usd), 0)
  from public.usage_with_cost u
  where u.occurred_at >= p_from and u.occurred_at < p_to
  group by 1, 2, 3
  order by 1, 2, 3;
$$;

revoke all on function public.usage_daily(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.usage_daily(timestamptz, timestamptz, text) to authenticated;
