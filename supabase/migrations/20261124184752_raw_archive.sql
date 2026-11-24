-- Raw records move to Storage: a private bucket of gzipped JSONL files, one
-- folder per UTC day, kept 180 days. The archive function (called nightly by
-- pg_cron every 10 minutes from 03:00 to 04:50 UTC through pg_net, with the upload secret kept in Vault under
-- `codetel_upload_secret`) exports closed days, a few parts per call, and deletes the exported rows.
-- `private.prune_telemetry_records()` stays as a 30-day backstop. The bucket
-- and the schedule are skipped where Supabase's storage, pg_cron or pg_net are
-- not available, as in the tests.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('raw-archive', 'raw-archive', false)
    on conflict (id) do nothing;
  end if;

  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net')
     and exists (select 1 from pg_available_extensions where name = 'supabase_vault') then
    create extension if not exists pg_cron with schema pg_catalog;
    create extension if not exists pg_net with schema extensions;
    create extension if not exists supabase_vault;
    perform cron.schedule(
      'codetel-archive-raw',
      '*/10 3-4 * * *',
      $job$
      select net.http_post(
        url := 'https://cmbnmbrudyozwsdmecrt.supabase.co/functions/v1/archive',
        headers := jsonb_build_object(
          'authorization',
          'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'codetel_upload_secret')
        ),
        timeout_milliseconds := 150000
      )
      $job$
    );
  end if;
end;
$$;
