import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  attrs,
  backfillError,
  type Parsed,
  parseLogs,
  parseTraces,
  type UsageEvent,
} from "../supabase/functions/_shared/telemetry.ts";

interface Upload {
  path: string;
  body: unknown;
}

function fixture(name: string): Upload[] {
  return JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
}

async function parseAll(uploads: Upload[]): Promise<Parsed> {
  const out: Parsed = { records: [], usage: [] };
  for (const u of uploads) {
    const p = u.path === "/v1/logs" ? await parseLogs(u.body) : parseTraces(u.body);
    out.records.push(...p.records);
    out.usage.push(...p.usage);
  }
  return out;
}

// deno-lint-ignore no-explicit-any
function turnTotals(parsed: Parsed): Record<string, any>[] {
  // deno-lint-ignore no-explicit-any
  return parsed.records.filter((r) => r.name === "session_task.turn").map((r: any) => attrs(r.payload.span.attributes));
}

function sum(rows: UsageEvent[], key: keyof UsageEvent): number {
  return rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);
}

Deno.test("codex: per-request usage excludes warmup and matches the turn span", async () => {
  for (const name of ["codex_new_session", "codex_resumed_session"]) {
    const parsed = await parseAll(fixture(name));
    const [turn] = turnTotals(parsed);
    assert(turn, `${name}: turn span kept`);
    const u = parsed.usage;
    assertEquals(sum(u, "input_tokens") + sum(u, "cached_input_tokens") + sum(u, "cache_write_tokens"),
      turn["codex.turn.token_usage.input_tokens"], `${name}: input`);
    assertEquals(sum(u, "cached_input_tokens"), turn["codex.turn.token_usage.cached_input_tokens"], `${name}: cached`);
    assertEquals(sum(u, "input_tokens"), turn["codex.turn.token_usage.non_cached_input_tokens"], `${name}: uncached`);
    assertEquals(sum(u, "output_tokens"), turn["codex.turn.token_usage.output_tokens"], `${name}: output`);
    assertEquals(sum(u, "reasoning_output_tokens"), turn["codex.turn.token_usage.reasoning_output_tokens"], `${name}: reasoning`);
    for (const row of u) {
      assertEquals(row.tool, "codex");
      assert(row.id.startsWith("codex:"));
    }
  }
});

Deno.test("codex: request counts per fixture", async () => {
  assertEquals((await parseAll(fixture("codex_new_session"))).usage.length, 3);
  assertEquals((await parseAll(fixture("codex_resumed_session"))).usage.length, 1);
});

Deno.test("codex: tool_result logs are not stored, other logs are", async () => {
  const uploads = fixture("codex_new_session");
  const parsed = await parseAll(uploads);
  assert(!parsed.records.some((r) => r.name === "codex.tool_result"));
  let logs = 0, toolResults = 0;
  for (const u of uploads.filter((u) => u.path === "/v1/logs")) {
    // deno-lint-ignore no-explicit-any
    for (const rl of (u.body as any).resourceLogs) {
      for (const sl of rl.scopeLogs) {
        for (const lr of sl.logRecords) {
          logs++;
          if (attrs(lr.attributes)["event.name"] === "codex.tool_result") toolResults++;
        }
      }
    }
  }
  assert(toolResults > 0, "fixture contains tool results");
  assertEquals(parsed.records.filter((r) => r.id.startsWith("log:")).length, logs - toolResults);
});

Deno.test("traces: only session_task.turn spans are stored", async () => {
  const parsed = await parseAll(fixture("codex_new_session"));
  const spans = parsed.records.filter((r) => r.id.startsWith("span:"));
  assertEquals(spans.map((r) => r.name), ["session_task.turn"]);
});

Deno.test("ids are stable when a batch is parsed again", async () => {
  for (const name of ["codex_new_session", "claude_session"]) {
    const a = await parseAll(fixture(name));
    const b = await parseAll(fixture(name));
    assertEquals(a.records.map((r) => r.id), b.records.map((r) => r.id));
    assertEquals(a.usage.map((r) => r.id), b.usage.map((r) => r.id));
    assertEquals(new Set(a.records.map((r) => r.id)).size, a.records.length, `${name}: record ids unique`);
  }
});

Deno.test("claude: api_request logs become usage rows with reported cost", async () => {
  const parsed = await parseAll(fixture("claude_session"));
  assertEquals(parsed.usage.length, 2);
  for (const row of parsed.usage) {
    assertEquals(row.tool, "claude_code");
    assertEquals(row.id, row.request_id);
    assert(row.turn_id);
    assert(row.reported_cost_usd != null && row.reported_cost_usd > 0);
    assertEquals(row.cache_write_tokens, (row.cache_write_5m_tokens ?? 0) + (row.cache_write_1h_tokens ?? 0));
  }
  assertEquals(parsed.usage.map((r) => [r.input_tokens, r.output_tokens, r.cached_input_tokens, r.cache_write_tokens]), [
    [2, 78, 2136, 1719],
    [2, 4, 3855, 88],
  ]);
  assertEquals(parsed.usage.map((r) => r.reported_cost_usd), [0.0157472, 0.001563]);
});

Deno.test("backfill rows are validated", () => {
  const ok = {
    id: "resp_1",
    occurred_at: "2026-10-01T00:00:00Z",
    tool: "codex",
    model: "gpt-6.1-sol",
    session_id: "s",
    turn_id: "t",
    request_id: "resp_1",
    input_tokens: 1,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    cache_write_5m_tokens: null,
    cache_write_1h_tokens: null,
    output_tokens: 1,
    reasoning_output_tokens: 0,
    reported_cost_usd: null,
  };
  assertEquals(backfillError(ok), null);
  assert(backfillError({ ...ok, tool: "other" }));
  assert(backfillError({ ...ok, input_tokens: -1 }));
  assert(backfillError({ ...ok, output_tokens: 1.5 }));
  assert(backfillError({ ...ok, occurred_at: "yesterday" }));
  assert(backfillError({ ...ok, reported_cost_usd: 1 }));
  assert(backfillError({ ...ok, id: "" }));
});
