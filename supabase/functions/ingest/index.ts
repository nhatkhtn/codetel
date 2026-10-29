// Receives OTLP/HTTP JSON from Claude Code and Codex, plus backfill batches.
//
//   POST /ingest/v1/logs     OTLP logs
//   POST /ingest/v1/traces   OTLP traces
//   POST /ingest/backfill    {"usage": [UsageEvent, ...], "prompts": [PromptEvent, ...]}
//
// Every request needs `Authorization: Bearer <UPLOAD_SECRET>`.

import postgres from "npm:postgres@3.4.9";
import {
  backfillError,
  type Parsed,
  parseLogs,
  parseTraces,
  promptBackfillError,
  sha256Hex,
} from "../_shared/telemetry.ts";

const MAX_BACKFILL_ROWS = 5000;

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const uploadSecretHash = sha256Hex(Deno.env.get("UPLOAD_SECRET") ?? "");

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Compares fixed-length digests so timing does not depend on the secret.
async function authorized(req: Request): Promise<boolean> {
  if (!Deno.env.get("UPLOAD_SECRET")) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [a, b] = [await sha256Hex(token), await uploadSecretHash];
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJson(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (type && !type.includes("json")) throw new HttpError(415, "only JSON bodies are accepted");
  let stream = req.body;
  if (!stream) throw new HttpError(400, "empty body");
  if ((req.headers.get("content-encoding") ?? "").toLowerCase() === "gzip") {
    stream = stream.pipeThrough(new DecompressionStream("gzip"));
  }
  try {
    return JSON.parse(await new Response(stream).text());
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function store({ records, usage, prompts }: Parsed) {
  if (records.length === 0 && usage.length === 0 && prompts.length === 0) {
    return { records_inserted: 0, usage_inserted: 0, prompts_inserted: 0 };
  }
  // Sent as text: postgres.js would JSON-encode a string bound to a jsonb parameter again.
  const [row] = await sql`
    select * from private.ingest(
      ${JSON.stringify(records)}::text::jsonb,
      ${JSON.stringify(usage)}::text::jsonb,
      ${JSON.stringify(prompts)}::text::jsonb
    )
  `;
  return {
    records_inserted: Number(row.records_inserted),
    usage_inserted: Number(row.usage_inserted),
    prompts_inserted: Number(row.prompts_inserted),
  };
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!(await authorized(req))) return json(401, { error: "unauthorized" });
  const path = new URL(req.url).pathname;

  if (path.endsWith("/v1/logs")) {
    const result = await store(await parseLogs(await readJson(req)));
    console.log(JSON.stringify({ path: "logs", ...result }));
    return json(200, {});
  }
  if (path.endsWith("/v1/traces")) {
    const result = await store(parseTraces(await readJson(req)));
    console.log(JSON.stringify({ path: "traces", ...result }));
    return json(200, {});
  }
  if (path.endsWith("/backfill")) {
    // deno-lint-ignore no-explicit-any
    const body = await readJson(req) as any;
    const usage = body?.usage ?? [];
    const prompts = body?.prompts ?? [];
    if (!Array.isArray(usage) || !Array.isArray(prompts)) {
      throw new HttpError(400, "expected {\"usage\": [...], \"prompts\": [...]}");
    }
    if (usage.length + prompts.length > MAX_BACKFILL_ROWS) {
      throw new HttpError(413, `at most ${MAX_BACKFILL_ROWS} rows per request`);
    }
    for (const [i, row] of usage.entries()) {
      const error = backfillError(row);
      if (error) throw new HttpError(400, `usage row ${i}: ${error}`);
    }
    for (const [i, row] of prompts.entries()) {
      const error = promptBackfillError(row);
      if (error) throw new HttpError(400, `prompt row ${i}: ${error}`);
    }
    const result = await store({ records: [], usage, prompts });
    console.log(JSON.stringify({ path: "backfill", received: usage.length, prompts: prompts.length, ...result }));
    return json(200, {
      received: usage.length,
      inserted: result.usage_inserted,
      prompts_received: prompts.length,
      prompts_inserted: result.prompts_inserted,
    });
  }
  return json(404, { error: "unknown path" });
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(e);
    // 5xx makes OTLP exporters retry the batch; inserts are idempotent.
    // Only reachable after the upload secret was accepted.
    return json(500, { error: "internal error", detail: e instanceof Error ? e.message : String(e) });
  }
});
