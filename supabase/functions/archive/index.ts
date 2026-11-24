// Moves raw telemetry records from Postgres to Storage and expires old files.
//
//   POST /archive    (nightly, from pg_cron through pg_net)
//
// Every closed UTC day (by `received_at`) is written to the private
// `raw-archive` bucket as gzipped JSONL parts, and a part's rows are deleted
// from `telemetry_records` only after the stored object's size matches what was
// uploaded. Day folders older than KEEP_DAYS are removed. Needs
// `Authorization: Bearer <UPLOAD_SECRET>`, like the ingest function. A run
// writes at most MAX_PAGES_PER_RUN parts (Edge Functions get little CPU per
// request), so cron calls it every 10 minutes and a busy day drains over runs.

import postgres from "npm:postgres@3.4.9";
import { BUCKET, expiredDays, gzip, isDay, KEEP_DAYS, MAX_PAGES_PER_RUN, PAGE_ROWS, partPath } from "../_shared/archive.ts";
import { sha256Hex } from "../_shared/telemetry.ts";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const uploadSecretHash = sha256Hex(Deno.env.get("UPLOAD_SECRET") ?? "");
const storageUrl = `${Deno.env.get("SUPABASE_URL")}/storage/v1`;
const storageHeaders = { authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function authorized(req: Request): Promise<boolean> {
  if (!Deno.env.get("UPLOAD_SECRET")) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [a, b] = [await sha256Hex(token), await uploadSecretHash];
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function storage(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`${storageUrl}/${path}`, { ...init, headers: { ...storageHeaders, ...init.headers } });
  if (!res.ok) throw new Error(`storage ${init.method} ${path}: ${res.status} ${await res.text()}`);
  return res;
}

async function list(prefix: string): Promise<{ name: string; metadata: { size: number } | null }[]> {
  const res = await storage(`object/list/${BUCKET}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: "name", order: "asc" } }),
  });
  return await res.json();
}

// Uploads a part and returns only once the stored size matches.
async function putPart(path: string, body: Uint8Array): Promise<void> {
  await storage(`object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/gzip", "x-upsert": "false" },
    body,
  });
  const [day, file] = path.split("/");
  const stored = (await list(day)).find((o) => o.name === file);
  if (stored?.metadata?.size !== body.length) {
    throw new Error(`stored size of ${path} is ${stored?.metadata?.size}, expected ${body.length}`);
  }
}

// Postgres builds the JSONL text, so the function never parses the records:
// parsing a page into objects exceeds the Edge Function's memory and CPU limits.
async function archiveDay(day: string, runId: string, firstPart: number, pagesLeft: number) {
  let parts = 0;
  let rows = 0;
  while (parts < pagesLeft) {
    const start = `${day}T00:00:00Z`;
    const [page] = await sql`
      with p as (
        select id, occurred_at, received_at, name, payload
        from public.telemetry_records
        where received_at >= ${start}::timestamptz and received_at < ${start}::timestamptz + interval '1 day'
        order by received_at, id
        limit ${PAGE_ROWS}
      )
      select count(*)::int as n,
             string_agg(to_json(p)::text, E'\n' order by received_at, id) as body,
             array_agg(id) as ids
      from p
    `;
    if (page.n === 0) return { parts, rows, done: true };
    const body = await gzip(page.body + "\n");
    await putPart(partPath(day, runId, firstPart + parts), body);
    // Deleted by ID: rows that arrived late are not in this part and stay.
    const deleted = await sql`
      delete from public.telemetry_records
      where id in (select jsonb_array_elements_text(${JSON.stringify(page.ids)}::text::jsonb))
      returning 1
    `;
    if (deleted.length !== page.n) throw new Error(`${day}: archived ${page.n} rows, deleted ${deleted.length}`);
    parts++;
    rows += page.n;
  }
  return { parts, rows, done: false };
}

async function expire(today: string): Promise<string[]> {
  const folders = (await list("")).map((o) => o.name);
  const old = expiredDays(folders, today, KEEP_DAYS);
  for (const day of old) {
    const files = (await list(day)).map((o) => `${day}/${o.name}`);
    if (files.length) {
      await storage(`object/${BUCKET}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prefixes: files }),
      });
    }
  }
  return old;
}

async function run() {
  let pagesLeft = MAX_PAGES_PER_RUN;
  const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const today = new Date().toISOString().slice(0, 10);
  const days: string[] = (await sql`
    select distinct (received_at at time zone 'utc')::date::text as d
    from public.telemetry_records
    where received_at < date_trunc('day', now() at time zone 'utc') at time zone 'utc'
    order by 1
  `).map((r) => r.d).filter(isDay);
  const archived: Record<string, unknown> = {};
  for (const day of days) {
    if (pagesLeft <= 0) break;
    const result = await archiveDay(day, runId, 1, pagesLeft);
    archived[day] = result;
    pagesLeft -= result.parts;
  }
  const expired = await expire(today);
  return { archived, expired, pending_days: days.filter((d) => !(d in archived) || archived[d] && !(archived[d] as { done: boolean }).done) };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!(await authorized(req))) return json(401, { error: "unauthorized" });
  try {
    const result = await run();
    console.log(JSON.stringify(result));
    return json(200, result);
  } catch (e) {
    console.error(e);
    return json(500, { error: "internal error", detail: e instanceof Error ? e.message : String(e) });
  }
});
