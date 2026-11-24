-- Removes from stored raw records what the ingest no longer keeps: account
-- identity attributes (the same on every row), constant resource attributes
-- (SDK, OS, environment) and the instrumentation `scope`. `host.name`,
-- `service.name` and `service.version` stay. Usage and prompt rows are
-- unaffected. One pass per row; rows without `scope` are already scrubbed, so
-- re-running (or running in batches by hand) is safe.
create function pg_temp.drop_attrs(attrs jsonb, keys text[])
returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(a order by ord), '[]'::jsonb)
  from jsonb_array_elements(attrs) with ordinality as e(a, ord)
  where not (a->>'key' = any(keys))
$$;

create function pg_temp.scrub_payload(p jsonb)
returns jsonb language sql immutable as $$
  select (
    case when jsonb_typeof(q #> '{resource,attributes}') = 'array'
      then jsonb_set(q, '{resource,attributes}', pg_temp.drop_attrs(q #> '{resource,attributes}',
        array['telemetry.sdk.name', 'telemetry.sdk.version', 'telemetry.sdk.language',
              'os.type', 'os.version', 'host.arch', 'env']))
      else q
    end
  ) - 'scope'
  from (
    select case
      when jsonb_typeof(p #> '{record,attributes}') = 'array'
        then jsonb_set(p, '{record,attributes}', pg_temp.drop_attrs(p #> '{record,attributes}',
          array['user.email', 'user.id', 'user.account_id', 'user.account_uuid', 'organization.id']))
      when jsonb_typeof(p #> '{span,attributes}') = 'array'
        then jsonb_set(p, '{span,attributes}', pg_temp.drop_attrs(p #> '{span,attributes}',
          array['user.email', 'user.id', 'user.account_id', 'user.account_uuid', 'organization.id']))
      else p
    end as q
  ) s
$$;

update public.telemetry_records
set payload = pg_temp.scrub_payload(payload)
where payload ? 'scope';
