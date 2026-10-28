-- Raw records are kept for 30 days after they arrive; usage rows are kept
-- for good. A nightly pg_cron job does the deleting (skipped where pg_cron is
-- not available, as in the tests).
create index telemetry_records_received_at_idx on public.telemetry_records (received_at);

create function private.prune_telemetry_records()
returns bigint
language sql
set search_path = ''
as $$
  with d as (
    delete from public.telemetry_records
    where received_at < now() - interval '30 days'
    returning 1
  )
  select count(*) from d;
$$;

revoke all on function private.prune_telemetry_records() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule(
      'codetel-prune-telemetry-records',
      '17 4 * * *',
      'select private.prune_telemetry_records()'
    );
  end if;
end;
$$;
