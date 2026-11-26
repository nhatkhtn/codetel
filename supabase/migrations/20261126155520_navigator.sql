-- Allow UF NaviGator (reported by the credential proxy) as a tool in usage_events.
alter table public.usage_events
  drop constraint if exists usage_events_tool_check,
  add constraint usage_events_tool_check
    check (tool in ('claude_code', 'codex', 'antigravity', 'navigator'));
