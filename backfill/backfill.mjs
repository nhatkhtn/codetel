#!/usr/bin/env node
// Imports per-request usage recorded before OTel export was enabled, from
// local Claude Code transcripts and Codex rollouts, via the ingest function.
//
//   node backfill/backfill.mjs --before <ISO time> [--dry-run]
//
// --before is the time OTel export was enabled on this machine; only usage
// strictly before it is imported, so nothing is counted twice.
//
// Environment (not needed for --dry-run):
//   CODETEL_INGEST_URL     e.g. https://<ref>.supabase.co/functions/v1/ingest
//   CODETEL_UPLOAD_SECRET  the upload secret
// Optional: CLAUDE_CONFIG_DIR (default ~/.claude), CODEX_HOME (default ~/.codex)
//
// Re-running is safe: rows are keyed by the native request/response ID.

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

// Collects rows before the cutoff, keeping the earliest row per ID.
export async function collect({ claudeDir, codexDirs, before }) {
  const cutoff = Date.parse(before);
  if (Number.isNaN(cutoff)) throw new Error(`--before is not a valid time: ${before}`);
  const rows = new Map();
  const add = (row) => {
    const t = Date.parse(row.occurred_at);
    if (Number.isNaN(t) || t >= cutoff) return;
    const seen = rows.get(row.id);
    if (!seen || t < Date.parse(seen.occurred_at)) rows.set(row.id, row);
  };
  for (const f of walk(claudeDir, (n) => n.endsWith(".jsonl"))) for await (const r of claudeRows(f)) add(r);
  for (const dir of codexDirs) {
    for (const f of walk(dir, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"))) {
      for await (const r of codexRows(f)) add(r);
    }
  }
  return [...rows.values()].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
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

async function upload(rows, url, secret) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const batch = rows.slice(i, i + BATCH_ROWS);
    const res = await fetch(`${url.replace(/\/$/, "")}/backfill`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ usage: batch }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`upload failed at row ${i}: HTTP ${res.status} ${body}`);
    inserted += JSON.parse(body).inserted;
    console.log(`uploaded ${Math.min(i + BATCH_ROWS, rows.length)}/${rows.length}`);
  }
  return inserted;
}

async function main() {
  const { values } = parseArgs({
    options: { before: { type: "string" }, "dry-run": { type: "boolean", default: false } },
  });
  if (!values.before) {
    console.error("usage: node backfill/backfill.mjs --before <ISO time> [--dry-run]");
    process.exit(2);
  }
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const rows = await collect({
    claudeDir: path.join(claudeHome, "projects"),
    codexDirs: [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")],
    before: values.before,
  });

  console.log(`requests before ${values.before}: ${rows.length}`);
  for (const [k, g] of summarize(rows)) {
    console.log(`${k}\t${g.requests} requests\tinput ${g.input}\tcached ${g.cached}\tcache write ${g.cacheWrite}\toutput ${g.output}\t${g.first.slice(0, 10)}..${g.last.slice(0, 10)}`);
  }
  if (values["dry-run"]) return;

  const url = process.env.CODETEL_INGEST_URL;
  const secret = process.env.CODETEL_UPLOAD_SECRET;
  if (!url || !secret) {
    console.error("CODETEL_INGEST_URL and CODETEL_UPLOAD_SECRET must be set");
    process.exit(2);
  }
  const inserted = await upload(rows, url, secret);
  console.log(`inserted ${inserted} new rows (${rows.length - inserted} already present)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
