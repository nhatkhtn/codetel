-- Removes stored Claude Code records the ingest no longer keeps: MCP server
-- connection and plugin load events. Usage and prompt rows are unaffected.
delete from public.telemetry_records
where name in ('mcp_server_connection', 'plugin_loaded');
