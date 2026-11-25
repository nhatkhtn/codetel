#!/usr/bin/env node
// Imports per-request usage and prompts recorded before OTel export was
// enabled, from local Claude Code transcripts, Codex rollouts and Antigravity
// CLI transcripts, via the ingest function.
//
//   node backfill/backfill.mjs --before <ISO time> [--tool <name>]... [--dry-run]
//
// --before is the time OTel export was enabled on this machine; only usage
// strictly before it is imported, so nothing is counted twice.
// --tool limits the scan to claude_code, codex or antigravity; repeat it for
// several. Without it all three are scanned.
//
// Environment (not needed for --dry-run):
//   CODETEL_INGEST_URL     e.g. https://<ref>.supabase.co/functions/v1/ingest
//   CODETEL_UPLOAD_SECRET  the upload secret
// Optional: CLAUDE_CONFIG_DIR (~/.claude), CODEX_HOME (~/.codex),
//           ANTIGRAVITY_HOME (~/.gemini/antigravity-cli)
//
// Re-running is safe: rows are keyed by the native request/response/prompt ID.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const BATCH_ROWS = 1000;

async function* jsonLines(file) {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // Truncated last line of a file still being written.
    }
  }
}

function* walk(dir, match) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, match);
    else if (e.isFile() && match(e.name)) yield p;
  }
}

const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const countOrNull = (v) => (v == null ? null : count(v));

// Claude Code writes each API response as several transcript entries (one
// per content block) with the same requestId and usage; resumed sessions
// copy earlier entries into new files. Rows are deduplicated by requestId
// by the caller.
export async function* claudeRows(file) {
  for await (const e of jsonLines(file)) {
    const m = e?.message;
    const u = m?.usage;
    if (e?.type !== "assistant" || !u || !e.requestId || !e.sessionId || !e.timestamp) continue;
    if (!m.model || m.model === "<synthetic>") continue;
    yield {
      id: e.requestId,
      occurred_at: e.timestamp,
      tool: "claude_code",
      model: m.model,
      session_id: e.sessionId,
      turn_id: null,
      request_id: e.requestId,
      input_tokens: count(u.input_tokens),
      cached_input_tokens: count(u.cache_read_input_tokens),
      cache_write_tokens: count(u.cache_creation_input_tokens),
      cache_write_5m_tokens: countOrNull(u.cache_creation?.ephemeral_5m_input_tokens),
      cache_write_1h_tokens: countOrNull(u.cache_creation?.ephemeral_1h_input_tokens),
      output_tokens: count(u.output_tokens),
      reasoning_output_tokens: countOrNull(u.output_tokens_details?.thinking_tokens),
      reported_cost_usd: null,
      // Live telemetry reports scripted runs (claude -p) as query_source "sdk".
      query_source: e.entrypoint === "sdk-cli" ? "sdk" : null,
    };
  }
}

// Claude Code logs a prompt event for what you type, slash commands and
// scripted prompts; transcripts mark these by origin, a <command-name> tag
// or promptSource "sdk". Other user entries (tool results, task
// notifications, command output, interruptions) are not prompts. Several
// entries share a promptId; the caller keeps the earliest per ID.
const COMMAND = /<command-name>(.*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

export async function* claudePrompts(file) {
  for await (const e of jsonLines(file)) {
    if (e?.type !== "user" || !e.promptId || !e.sessionId || !e.timestamp) continue;
    if (e.isMeta || e.isCompactSummary) continue;
    const content = e.message?.content;
    if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) continue;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("") : "";
    const command = text.match(COMMAND);
    if (!command && e.origin?.kind !== "human" && e.promptSource !== "sdk") continue;
    // A slash command's length is that of "/name args", as typed.
    const args = command ? text.match(COMMAND_ARGS)?.[1] : null;
    const typed = command ? command[1] + (args ? " " + args : "") : text;
    yield {
      id: e.promptId,
      occurred_at: e.timestamp,
      tool: "claude_code",
      session_id: e.sessionId,
      prompt_length: typed.length,
      command_name: command ? command[1].replace(/^\//, "") : null,
      originator: null,
    };
  }
}

// Codex rollouts record one token_usage_record per model response, with
// the native response ID (connection warmups are not recorded). The model
// comes from the turn_context of the same turn.
export async function* codexRows(file) {
  const turnModel = new Map();
  let lastModel = null;
  for await (const e of jsonLines(file)) {
    const p = e?.payload;
    if (e?.type === "turn_context" && p?.model) {
      lastModel = p.model;
      if (p.turn_id) turnModel.set(p.turn_id, p.model);
      continue;
    }
    if (e?.type !== "token_usage_record" || !p?.response_id || !p.usage || !e.timestamp) continue;
    const model = turnModel.get(p.turn_id) ?? lastModel;
    const session = p.thread_id ?? p.session_id;
    if (!model || !session) continue;
    const u = p.usage;
    const input = count(u.input_tokens);
    const cached = count(u.cached_input_tokens);
    const cacheWrite = count(u.cache_write_input_tokens);
    yield {
      id: p.response_id,
      occurred_at: e.timestamp,
      tool: "codex",
      model,
      session_id: session,
      turn_id: p.turn_id ?? null,
      request_id: p.response_id,
      // Same normalization as the OTel path: Codex input includes cached input.
      input_tokens: Math.max(0, input - cached - cacheWrite),
      cached_input_tokens: cached,
      cache_write_tokens: cacheWrite,
      cache_write_5m_tokens: null,
      cache_write_1h_tokens: null,
      output_tokens: count(u.output_tokens),
      reasoning_output_tokens: countOrNull(u.reasoning_output_tokens),
      reported_cost_usd: null,
    };
  }
}

// Codex records each prompt as a completed UserMessage item. Subagent
// sessions (spawned agents, the command reviewer) are skipped: their
// prompts are written by Codex. The session's originator tells interactive
// (codex-tui) from scripted (codex_exec) runs.
export async function* codexPrompts(file) {
  let meta = null;
  for await (const e of jsonLines(file)) {
    const p = e?.payload;
    if (e?.type === "session_meta" && !meta) {
      meta = p ?? {};
      continue;
    }
    if (e?.type !== "event_msg" || p?.type !== "item_completed" || p.item?.type !== "UserMessage") continue;
    if (!meta?.id || meta.source?.subagent || !p.item.id || !e.timestamp) continue;
    const text = (p.item.content ?? []).filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
    yield {
      id: p.item.id,
      occurred_at: e.timestamp,
      tool: "codex",
      session_id: meta.id,
      prompt_length: text.length,
      command_name: null,
      originator: meta.originator ?? null,
    };
  }
}

// Antigravity CLI writes brain/<conversation-id>/.system_generated/logs/transcript.jsonl.
export function antigravitySessionId(file) {
  const parts = path.resolve(file).split(path.sep);
  const idx = parts.lastIndexOf(".system_generated");
  return idx > 0 ? parts[idx - 1] : null;
}

// Parses Antigravity CLI transcript entries into usage and prompt records
// paired with their step_index.
export async function parseAntigravityTranscript(file, sessionId = antigravitySessionId(file)) {
  const usage = [];
  const prompts = [];
  if (!sessionId) return { usage, prompts };
  for await (const e of jsonLines(file)) {
    const step = e?.step_index;
    if (!Number.isSafeInteger(step) || step < 0 || !e?.created_at) continue;
    if (e.type === "PLANNER_RESPONSE" && e.status === "DONE" && e.model) {
      usage.push({
        step_index: step,
        row: {
          id: `agy:${sessionId}:${step}`,
          occurred_at: e.created_at,
          tool: "antigravity",
          model: e.model,
          session_id: sessionId,
          turn_id: null,
          request_id: null,
          input_tokens: count(e.input_tokens),
          cached_input_tokens: count(e.cache_read_tokens),
          cache_write_tokens: 0,
          cache_write_5m_tokens: null,
          cache_write_1h_tokens: null,
          output_tokens: count(e.output_tokens),
          reasoning_output_tokens: null,
          reported_cost_usd: null,
        },
      });
    } else if (e.type === "USER_INPUT" && e.source === "USER_EXPLICIT") {
      const text = typeof e.content === "string" ? e.content : "";
      prompts.push({
        step_index: step,
        row: {
          id: `agy:${sessionId}:${step}`,
          occurred_at: e.created_at,
          tool: "antigravity",
          session_id: sessionId,
          prompt_length: text.length,
          command_name: null,
          originator: "antigravity-cli",
        },
      });
    }
  }
  return { usage, prompts };
}

export async function* antigravityRows(file, sessionId) {
  const { usage } = await parseAntigravityTranscript(file, sessionId);
  for (const item of usage) yield item.row;
}

export async function* antigravityPrompts(file, sessionId) {
  const { prompts } = await parseAntigravityTranscript(file, sessionId);
  for (const item of prompts) yield item.row;
}

export const TOOLS = ["claude_code", "codex", "antigravity"];

// Collects usage and prompt rows before the cutoff from the chosen tools
// (default all), keeping the earliest row per ID.
export async function collect({ claudeDir, codexDirs, antigravityDir, before, tools = TOOLS }) {
  for (const t of tools) {
    if (!TOOLS.includes(t)) throw new Error(`unknown tool: ${t} (expected ${TOOLS.join(", ")})`);
  }
  const cutoff = Date.parse(before);
  if (Number.isNaN(cutoff)) throw new Error(`--before is not a valid time: ${before}`);
  const usage = new Map();
  const prompts = new Map();
  const add = (rows, row) => {
    const t = Date.parse(row.occurred_at);
    if (Number.isNaN(t) || t >= cutoff) return;
    const seen = rows.get(row.id);
    if (!seen || t < Date.parse(seen.occurred_at)) rows.set(row.id, row);
  };
  if (tools.includes("claude_code")) for (const f of walk(claudeDir, (n) => n.endsWith(".jsonl"))) {
    for await (const r of claudeRows(f)) add(usage, r);
    for await (const r of claudePrompts(f)) add(prompts, r);
  }
  if (tools.includes("codex")) for (const dir of codexDirs) {
    for (const f of walk(dir, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"))) {
      for await (const r of codexRows(f)) add(usage, r);
      for await (const r of codexPrompts(f)) add(prompts, r);
    }
  }
  if (antigravityDir && tools.includes("antigravity")) {
    const suffix = path.join(".system_generated", "logs", "transcript.jsonl");
    for (const f of walk(antigravityDir, (n) => n === "transcript.jsonl")) {
      if (!f.endsWith(suffix)) continue;
      for await (const r of antigravityRows(f)) add(usage, r);
      for await (const r of antigravityPrompts(f)) add(prompts, r);
    }
  }
  const sorted = (rows) => [...rows.values()].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  return { usage: sorted(usage), prompts: sorted(prompts) };
}

export function summarize(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.tool}\t${r.model}`;
    const g = groups.get(k) ?? { requests: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, first: r.occurred_at, last: r.occurred_at };
    g.requests++;
    g.input += r.input_tokens;
    g.cached += r.cached_input_tokens;
    g.cacheWrite += r.cache_write_tokens;
    g.output += r.output_tokens;
    if (r.occurred_at < g.first) g.first = r.occurred_at;
    if (r.occurred_at > g.last) g.last = r.occurred_at;
    groups.set(k, g);
  }
  return groups;
}

// key is "usage" or "prompts"; returns how many rows were new.
async function upload(key, rows, url, secret) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const batch = rows.slice(i, i + BATCH_ROWS);
    const res = await fetch(`${url.replace(/\/$/, "")}/backfill`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ [key]: batch }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`upload failed at ${key} row ${i}: HTTP ${res.status} ${body}`);
    const result = JSON.parse(body);
    inserted += key === "usage" ? result.inserted : result.prompts_inserted;
    console.log(`uploaded ${key} ${Math.min(i + BATCH_ROWS, rows.length)}/${rows.length}`);
  }
  return inserted;
}

async function main() {
  const { values } = parseArgs({
    options: {
      before: { type: "string" },
      tool: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.before) {
    console.error("usage: node backfill/backfill.mjs --before <ISO time> [--tool <name>]... [--dry-run]");
    process.exit(2);
  }
  const bad = (values.tool ?? []).filter((t) => !TOOLS.includes(t));
  if (bad.length) {
    console.error(`unknown --tool ${bad.join(", ")}; expected ${TOOLS.join(", ")}`);
    process.exit(2);
  }
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const antigravityHome = process.env.ANTIGRAVITY_HOME ?? path.join(os.homedir(), ".gemini", "antigravity-cli");
  const { usage: rows, prompts } = await collect({
    claudeDir: path.join(claudeHome, "projects"),
    codexDirs: [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")],
    antigravityDir: path.join(antigravityHome, "brain"),
    before: values.before,
    tools: values.tool?.length ? values.tool : TOOLS,
  });

  console.log(`requests before ${values.before}: ${rows.length}`);
  for (const [k, g] of summarize(rows)) {
    console.log(`${k}\t${g.requests} requests\tinput ${g.input}\tcached ${g.cached}\tcache write ${g.cacheWrite}\toutput ${g.output}\t${g.first.slice(0, 10)}..${g.last.slice(0, 10)}`);
  }
  const promptGroups = new Map();
  for (const p of prompts) {
    const k = `${p.tool}\t${p.originator ?? (p.command_name ? "slash command" : "prompt")}`;
    promptGroups.set(k, (promptGroups.get(k) ?? 0) + 1);
  }
  console.log(`prompts before ${values.before}: ${prompts.length}`);
  for (const [k, n] of promptGroups) console.log(`${k}\t${n}`);
  if (values["dry-run"]) return;

  const url = process.env.CODETEL_INGEST_URL;
  const secret = process.env.CODETEL_UPLOAD_SECRET;
  if (!url || !secret) {
    console.error("CODETEL_INGEST_URL and CODETEL_UPLOAD_SECRET must be set");
    process.exit(2);
  }
  const inserted = await upload("usage", rows, url, secret);
  console.log(`inserted ${inserted} new usage rows (${rows.length - inserted} already present)`);
  const promptsInserted = await upload("prompts", prompts, url, secret);
  console.log(`inserted ${promptsInserted} new prompts (${prompts.length - promptsInserted} already present)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
