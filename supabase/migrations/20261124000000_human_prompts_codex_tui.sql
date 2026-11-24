-- Codex prompts count as yours only from the interactive client
-- (originator 'codex-tui'). Workers started through codex-agent report
-- 'codex-agent', scripted runs 'codex_exec'; neither is typed by you.
create or replace view public.human_prompts
with (security_invoker = true)
as
select p.*
from public.prompt_events p
where case p.tool
  when 'codex' then p.originator = 'codex-tui'
  else not exists (
    select 1 from public.usage_events u
    where u.session_id = p.session_id and u.tool = p.tool and u.query_source = 'sdk'
  )
end;
