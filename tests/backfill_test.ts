// Backfill parsing on small synthetic transcripts shaped like real ones.

import { assertEquals } from "jsr:@std/assert@1";
import { backfillError, promptBackfillError } from "../supabase/functions/_shared/telemetry.ts";
// @ts-types="../backfill/backfill.d.ts"
import { collect } from "../backfill/backfill.mjs";

function claudeEntry(requestId: string, timestamp: string, over: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    requestId,
    sessionId: "sess-1",
    timestamp,
    message: {
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 1000,
        output_tokens: 50,
        output_tokens_details: { thinking_tokens: 0 },
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      },
    },
    ...over,
  };
}

function codexLines() {
  return [
    { type: "session_meta", timestamp: "2026-10-01T10:00:00Z", payload: { id: "thread-1" } },
    { type: "turn_context", timestamp: "2026-10-01T10:00:01Z", payload: { turn_id: "turn-1", model: "gpt-6.1-sol" } },
    {
      type: "token_usage_record",
      timestamp: "2026-10-01T10:00:05Z",
      payload: {
        thread_id: "thread-1",
        session_id: "thread-1",
        turn_id: "turn-1",
        response_id: "resp_1",
        usage: { input_tokens: 17147, cached_input_tokens: 12288, cache_write_input_tokens: 0, output_tokens: 48, reasoning_output_tokens: 7 },
      },
    },
    { type: "event_msg", timestamp: "2026-10-01T10:00:05Z", payload: { type: "token_count" } },
    { type: "turn_context", timestamp: "2026-10-03T10:00:00Z", payload: { turn_id: "turn-2", model: "gpt-6-astra" } },
    {
      type: "token_usage_record",
      timestamp: "2026-10-03T10:00:05Z",
      payload: { thread_id: "thread-1", turn_id: "turn-2", response_id: "resp_2", usage: { input_tokens: 10, output_tokens: 1 } },
    },
  ];
}

async function writeJsonl(file: string, rows: unknown[], trailing = "") {
  await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n" + trailing);
}

Deno.test("backfill collects deduplicated rows before the cutoff", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const claudeDir = `${dir}/claude/projects`;
    await writeJsonl(`${claudeDir}/-proj/sess-1.jsonl`, [
      { type: "user", timestamp: "2026-10-01T09:00:00Z" },
      claudeEntry("req_a", "2026-10-01T09:00:01Z"),
      claudeEntry("req_a", "2026-10-01T09:00:02Z"), // second content block, same request
      claudeEntry("req_syn", "2026-10-01T09:00:03Z", { message: { model: "<synthetic>", usage: { output_tokens: 1 } } }),
      claudeEntry("req_late", "2026-10-05T00:00:00Z"),
    ], '{"type":"assistant","trunc'); // truncated final line
    // A resumed session repeats req_a in another file.
    await writeJsonl(`${claudeDir}/-proj/sess-2.jsonl`, [claudeEntry("req_a", "2026-10-02T00:00:00Z", { sessionId: "sess-2" })]);
    await writeJsonl(`${dir}/codex/sessions/2026/10/01/rollout-x.jsonl`, codexLines());

    const { usage: rows } = await collect({
      claudeDir,
      codexDirs: [`${dir}/codex/sessions`, `${dir}/codex/archived_sessions`],
      before: "2026-10-04T00:00:00Z",
    });

    assertEquals(rows.map((r) => r.id), ["req_a", "resp_1", "resp_2"]);
    const [claude, codex1, codex2] = rows;
    assertEquals(claude.session_id, "sess-1");
    assertEquals(
      [claude.input_tokens, claude.cached_input_tokens, claude.cache_write_tokens, claude.cache_write_5m_tokens, claude.cache_write_1h_tokens, claude.output_tokens],
      [2, 1000, 300, 100, 200, 50],
    );
    assertEquals(
      [codex1.model, codex1.turn_id, codex1.input_tokens, codex1.cached_input_tokens, codex1.output_tokens, codex1.reasoning_output_tokens],
      ["gpt-6.1-sol", "turn-1", 4859, 12288, 48, 7],
    );
    assertEquals(codex2.model, "gpt-6-astra");
    for (const r of rows) assertEquals(backfillError(r), null, r.id);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function claudeUser(promptId: string, timestamp: string, content: unknown, over: Record<string, unknown> = {}) {
  return { type: "user", promptId, sessionId: "sess-1", timestamp, entrypoint: "cli", message: { role: "user", content }, ...over };
}

Deno.test("backfill collects prompts the way live telemetry reports them", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const claudeDir = `${dir}/claude/projects`;
    const human = { origin: { kind: "human" }, promptSource: "typed" };
    await writeJsonl(`${claudeDir}/-proj/sess-1.jsonl`, [
      claudeUser("p1", "2026-10-01T09:00:00Z", "fix the bug", human),
      claudeUser("p1", "2026-10-01T09:00:05Z", [{ type: "tool_result", content: "ok" }]),
      claudeUser("p2", "2026-10-01T09:01:00Z", "<command-name>/rename</command-name> <command-message>rename</command-message> <command-args>New name</command-args>"),
      claudeUser("p2", "2026-10-01T09:01:00Z", "<local-command-caveat>…</local-command-caveat>", { isMeta: true }),
      claudeUser("p3", "2026-10-01T09:02:00Z", "<task-notification>done</task-notification>", { origin: { kind: "task-notification" }, promptSource: "system" }),
      claudeUser("p4", "2026-10-01T09:03:00Z", "[Request interrupted by user]"),
      claudeUser("p5", "2026-10-01T09:04:00Z", "summary", { isCompactSummary: true }),
      claudeUser("p6", "2026-10-01T09:05:00Z", [{ type: "text", text: "pasted " }, { type: "image" }, { type: "text", text: "text" }], human),
      claudeUser("p7", "2026-10-05T00:00:00Z", "after the cutoff", human),
      { ...claudeEntry("req_s", "2026-10-01T10:00:01Z"), entrypoint: "sdk-cli", sessionId: "sess-s" },
    ]);
    // A scripted run, and a resumed session that copies p1 with a later time.
    await writeJsonl(`${claudeDir}/-proj/sess-s.jsonl`, [
      claudeUser("ps", "2026-10-01T10:00:00Z", "Reply OK", { sessionId: "sess-s", entrypoint: "sdk-cli", promptSource: "sdk" }),
    ]);
    await writeJsonl(`${claudeDir}/-proj/sess-2.jsonl`, [claudeUser("p1", "2026-10-02T00:00:00Z", "fix the bug", { ...human, sessionId: "sess-2" })]);

    const userMessage = (id: string, timestamp: string, text: string) => ({
      type: "event_msg",
      timestamp,
      payload: { type: "item_completed", item: { type: "UserMessage", id, content: [{ type: "text", text, text_elements: [] }] } },
    });
    await writeJsonl(`${dir}/codex/sessions/2026/10/01/rollout-tui.jsonl`, [
      { type: "session_meta", timestamp: "2026-10-01T10:00:00Z", payload: { id: "thread-1", originator: "codex-tui", source: "cli" } },
      userMessage("u1", "2026-10-01T10:00:01Z", "hello codex"),
      { type: "response_item", timestamp: "2026-10-01T10:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md" }] } },
    ]);
    await writeJsonl(`${dir}/codex/sessions/2026/10/01/rollout-exec.jsonl`, [
      { type: "session_meta", timestamp: "2026-10-01T11:00:00Z", payload: { id: "thread-2", originator: "codex_exec", source: "exec" } },
      userMessage("u2", "2026-10-01T11:00:01Z", "scripted"),
    ]);
    await writeJsonl(`${dir}/codex/sessions/2026/10/01/rollout-guardian.jsonl`, [
      { type: "session_meta", timestamp: "2026-10-01T12:00:00Z", payload: { id: "thread-3", originator: "codex-tui", source: { subagent: { other: "guardian" } } } },
      userMessage("u3", "2026-10-01T12:00:01Z", "The following is the Codex agent history"),
    ]);

    const { usage, prompts } = await collect({
      claudeDir,
      codexDirs: [`${dir}/codex/sessions`],
      before: "2026-10-04T00:00:00Z",
    });
    assertEquals(prompts.map((p) => [p.id, p.session_id, p.prompt_length, p.command_name, p.originator]), [
      ["p1", "sess-1", 11, null, null],
      ["p2", "sess-1", 16, "rename", null],
      ["p6", "sess-1", 11, null, null],
      ["ps", "sess-s", 8, null, null],
      ["u1", "thread-1", 11, null, "codex-tui"],
      ["u2", "thread-2", 8, null, "codex_exec"],
    ]);
    for (const p of prompts) assertEquals(promptBackfillError(p), null, p.id);
    assertEquals(usage.find((u) => u.id === "req_s")?.query_source, "sdk");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
