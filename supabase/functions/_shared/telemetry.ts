// Turns OTLP/HTTP JSON batches from Claude Code and Codex into raw records,
// normalized per-request usage rows and prompt rows. Pure functions; no I/O.

export type Tool = "claude_code" | "codex";

export interface RawRecord {
  id: string;
  occurred_at: string | null;
  name: string;
  payload: unknown;
}

export interface UsageEvent {
  id: string;
  occurred_at: string;
  tool: Tool;
  model: string;
  session_id: string;
  turn_id: string | null;
  request_id: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  cache_write_5m_tokens: number | null;
  cache_write_1h_tokens: number | null;
  output_tokens: number;
  reasoning_output_tokens: number | null;
  reported_cost_usd: number | null;
  query_source?: string | null;
}

export interface PromptEvent {
  id: string;
  occurred_at: string;
  tool: Tool;
  session_id: string;
  prompt_length: number;
  command_name: string | null;
  originator: string | null;
}

export interface Parsed {
  records: RawRecord[];
  usage: UsageEvent[];
  prompts: PromptEvent[];
}

// Log events never stored: per-tool-call events carry no usage (and Codex's
// tool results carry tool arguments and output).
export const DROPPED_LOG_EVENTS = new Set([
  "tool_decision",
  "tool_result",
  "codex.tool_decision",
  "codex.tool_result",
]);

// The only spans stored. Codex emits ~1000 spans per turn; this one carries
// turn ID and turn token totals, kept for debugging.
const KEPT_SPANS = new Set(["session_task.turn"]);

// deno-lint-ignore no-explicit-any
type Json = any;
type Attrs = Record<string, unknown>;

function anyValue(v: Json): unknown {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("boolValue" in v) return v.boolValue;
  if ("arrayValue" in v) return (v.arrayValue?.values ?? []).map(anyValue);
  if ("kvlistValue" in v) return attrs(v.kvlistValue?.values);
  if ("bytesValue" in v) return v.bytesValue;
  return null;
}

// Later duplicates of a key win; the raw payload keeps every duplicate.
export function attrs(list: Json[] | undefined): Attrs {
  const out: Attrs = {};
  for (const a of list ?? []) out[a.key] = anyValue(a.value);
  return out;
}

function nanosToIso(n: unknown): string | null {
  if (n == null) return null;
  const ns = BigInt(String(n));
  if (ns === 0n) return null;
  return new Date(Number(ns / 1000000n)).toISOString();
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function int(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function intOrNull(v: unknown): number | null {
  return v == null ? null : int(v);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function toolOf(resource: Attrs, scopeName: string | undefined, eventName: string): Tool | null {
  if (scopeName?.startsWith("com.anthropic.claude_code") || resource["service.name"] === "claude-code") {
    return "claude_code";
  }
  if (eventName.startsWith("codex.") || String(resource["service.name"] ?? "").startsWith("codex")) {
    return "codex";
  }
  return null;
}

function claudeUsage(a: Attrs): UsageEvent | null {
  const id = str(a["request_id"]);
  const session = str(a["session.id"]);
  const model = str(a["model"]);
  const at = str(a["event.timestamp"]);
  if (!id || !session || !model || !at) return null;
  const cost = a["cost_usd"];
  return {
    id,
    occurred_at: at,
    tool: "claude_code",
    model,
    session_id: session,
    turn_id: str(a["prompt.id"]),
    request_id: id,
    input_tokens: int(a["input_tokens"]),
    cached_input_tokens: int(a["cache_read_tokens"]),
    cache_write_tokens: int(a["cache_creation_tokens"]),
    cache_write_5m_tokens: intOrNull(a["cache_creation_5m_tokens"]),
    cache_write_1h_tokens: intOrNull(a["cache_creation_1h_tokens"]),
    output_tokens: int(a["output_tokens"]),
    reasoning_output_tokens: null,
    reported_cost_usd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    query_source: str(a["query_source"]),
  };
}

// Claude Code's prompt ID is the same one its transcripts record, so the
// backfill and the live path agree on IDs.
function claudePrompt(a: Attrs): PromptEvent | null {
  const id = str(a["prompt.id"]);
  const session = str(a["session.id"]);
  const at = str(a["event.timestamp"]);
  if (!id || !session || !at) return null;
  return {
    id,
    occurred_at: at,
    tool: "claude_code",
    session_id: session,
    prompt_length: int(a["prompt_length"]),
    command_name: str(a["command_name"]),
    originator: null,
  };
}

// Codex prompt events carry no ID; the row ID hashes the fields that
// identify the event, as for usage rows.
async function codexPrompt(a: Attrs): Promise<PromptEvent | null> {
  const session = str(a["conversation.id"]);
  const at = str(a["event.timestamp"]);
  if (!session || !at) return null;
  const length = int(a["prompt_length"]);
  const key = JSON.stringify(["codex_prompt", session, at, length]);
  return {
    id: "codex:" + (await sha256Hex(key)).slice(0, 32),
    occurred_at: at,
    tool: "codex",
    session_id: session,
    prompt_length: length,
    command_name: null,
    originator: str(a["originator"]),
  };
}

// Codex exports one response.completed event per model response. The
// connection warmup (generate=false) also emits one; it is the only kind
// without model_reasoning_effort, which Codex sets on every real request.
// The logs carry no response ID, so the row ID hashes the fields that
// identify the event; retried uploads produce the same ID.
async function codexUsage(a: Attrs): Promise<UsageEvent | null> {
  if (a["event.kind"] !== "response.completed") return null;
  if (a["model_reasoning_effort"] == null) return null;
  const session = str(a["conversation.id"]);
  const model = str(a["model"]);
  const at = str(a["event.timestamp"]);
  if (!session || !model || !at) return null;
  const input = int(a["input_token_count"]);
  const cached = int(a["cached_token_count"]);
  const cacheWrite = int(a["cache_write_token_count"]);
  const output = int(a["output_token_count"]);
  const reasoning = int(a["reasoning_token_count"]);
  const key = JSON.stringify(["codex", session, at, model, input, cached, cacheWrite, output, reasoning]);
  return {
    id: "codex:" + (await sha256Hex(key)).slice(0, 32),
    occurred_at: at,
    tool: "codex",
    model,
    session_id: session,
    turn_id: null,
    request_id: null,
    // Codex's input count includes cached input and (assumed) cache writes.
    input_tokens: Math.max(0, input - cached - cacheWrite),
    cached_input_tokens: cached,
    cache_write_tokens: cacheWrite,
    cache_write_5m_tokens: null,
    cache_write_1h_tokens: null,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    reported_cost_usd: null,
  };
}

export async function parseLogs(body: Json): Promise<Parsed> {
  const records: RawRecord[] = [];
  const usage: UsageEvent[] = [];
  const prompts: PromptEvent[] = [];
  for (const rl of body?.resourceLogs ?? []) {
    const resource = attrs(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) {
        const a = attrs(lr.attributes);
        const name = str(a["event.name"]) ?? str(lr.body?.stringValue) ?? "unknown";
        if (DROPPED_LOG_EVENTS.has(name)) continue;
        const payload = { resource: rl.resource ?? null, scope: sl.scope ?? null, record: lr };
        records.push({
          id: "log:" + (await sha256Hex(JSON.stringify(payload))),
          occurred_at: nanosToIso(lr.timeUnixNano) ?? nanosToIso(lr.observedTimeUnixNano),
          name,
          payload,
        });
        const tool = toolOf(resource, sl.scope?.name, name);
        const row = tool === "claude_code" && name === "api_request"
          ? claudeUsage(a)
          : tool === "codex" && name === "codex.sse_event"
          ? await codexUsage(a)
          : null;
        if (row) usage.push(row);
        const prompt = tool === "claude_code" && name === "user_prompt"
          ? claudePrompt(a)
          : tool === "codex" && name === "codex.user_prompt"
          ? await codexPrompt(a)
          : null;
        if (prompt) prompts.push(prompt);
      }
    }
  }
  return { records, usage, prompts };
}

export function parseTraces(body: Json): Parsed {
  const records: RawRecord[] = [];
  for (const rs of body?.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        if (!KEPT_SPANS.has(span.name)) continue;
        records.push({
          id: `span:${span.traceId}:${span.spanId}`,
          occurred_at: nanosToIso(span.startTimeUnixNano),
          name: span.name,
          payload: { resource: rs.resource ?? null, scope: ss.scope ?? null, span },
        });
      }
    }
  }
  return { records, usage: [], prompts: [] };
}

const COUNT_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_tokens",
  "output_tokens",
] as const;
const NULLABLE_COUNT_FIELDS = [
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "reasoning_output_tokens",
] as const;

// Checks a backfill row; returns an error message or null.
export function backfillError(row: Json): string | null {
  if (row == null || typeof row !== "object") return "row is not an object";
  for (const f of ["id", "occurred_at", "model", "session_id"]) {
    if (typeof row[f] !== "string" || row[f] === "") return `${f} must be a non-empty string`;
  }
  if (Number.isNaN(Date.parse(row.occurred_at))) return "occurred_at is not a timestamp";
  if (row.tool !== "claude_code" && row.tool !== "codex") return "tool must be claude_code or codex";
  for (const f of ["turn_id", "request_id"]) {
    if (row[f] != null && typeof row[f] !== "string") return `${f} must be a string or null`;
  }
  for (const f of COUNT_FIELDS) {
    if (!Number.isSafeInteger(row[f]) || row[f] < 0) return `${f} must be a non-negative integer`;
  }
  for (const f of NULLABLE_COUNT_FIELDS) {
    if (row[f] != null && (!Number.isSafeInteger(row[f]) || row[f] < 0)) {
      return `${f} must be a non-negative integer or null`;
    }
  }
  if (row.reported_cost_usd != null) return "reported_cost_usd must be null for backfill";
  if (row.query_source != null && typeof row.query_source !== "string") return "query_source must be a string or null";
  return null;
}

// Checks a backfill prompt row; returns an error message or null.
export function promptBackfillError(row: Json): string | null {
  if (row == null || typeof row !== "object") return "row is not an object";
  for (const f of ["id", "occurred_at", "session_id"]) {
    if (typeof row[f] !== "string" || row[f] === "") return `${f} must be a non-empty string`;
  }
  if (Number.isNaN(Date.parse(row.occurred_at))) return "occurred_at is not a timestamp";
  if (row.tool !== "claude_code" && row.tool !== "codex") return "tool must be claude_code or codex";
  if (!Number.isSafeInteger(row.prompt_length) || row.prompt_length < 0) return "prompt_length must be a non-negative integer";
  for (const f of ["command_name", "originator"]) {
    if (row[f] != null && typeof row[f] !== "string") return `${f} must be a string or null`;
  }
  return null;
}
