-- Removes stored Codex records the ingest no longer keeps: startup and
-- websocket events, and streaming events other than response.completed
-- (the only one with token counts). Usage and prompt rows are unaffected.
delete from public.telemetry_records
where name in ('codex.startup_phase', 'codex.websocket_connect', 'codex.websocket_request')
   or (
     name = 'codex.sse_event'
     and not jsonb_path_exists(
       payload,
       '$.record.attributes[*] ? (@.key == "event.kind" && @.value.stringValue == "response.completed")'
     )
   );
