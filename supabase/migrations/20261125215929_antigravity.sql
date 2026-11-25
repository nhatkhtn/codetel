-- Allow Antigravity CLI as a tool in usage_events and prompt_events.
alter table public.usage_events
  drop constraint if exists usage_events_tool_check,
  add constraint usage_events_tool_check
    check (tool in ('claude_code', 'codex', 'antigravity'));

alter table public.prompt_events
  drop constraint if exists prompt_events_tool_check,
  add constraint prompt_events_tool_check
    check (tool in ('claude_code', 'codex', 'antigravity'));
