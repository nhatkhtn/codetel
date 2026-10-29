// Runs the migration on PGlite (in-process Postgres) with minimal stand-ins
// for Supabase's roles and auth.uid().

import { assert, assertAlmostEquals, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.5.10";

const MIGRATIONS_DIR = new URL("../supabase/migrations/", import.meta.url);
const MIGRATION = [...Deno.readDirSync(MIGRATIONS_DIR)]
  .map((e) => e.name)
  .filter((n) => n.endsWith(".sql"))
  .sort()
  .map((n) => Deno.readTextFileSync(new URL(n, MIGRATIONS_DIR)))
  .join("\n");
const SUPABASE_STANDINS = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public to anon, authenticated;
`;
const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";

function usage(over: Record<string, unknown>) {
  return {
    id: "r1",
    occurred_at: "2026-10-01T12:00:00Z",
    tool: "codex",
    model: "gpt-6.1-sol",
    session_id: "s1",
    turn_id: null,
    request_id: null,
    input_tokens: 1000,
    cached_input_tokens: 2000,
    cache_write_tokens: 0,
    cache_write_5m_tokens: null,
    cache_write_1h_tokens: null,
    output_tokens: 100,
    reasoning_output_tokens: 10,
    reported_cost_usd: null,
    ...over,
  };
}

async function setup(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STANDINS);
  await db.exec(MIGRATION);
  await db.exec(`
    insert into public.model_pricing values
      ('gpt-6.1-sol', '2026-01-01', 0,      2.00, 0.10, 2.50, 5.00, 10.00),
      ('gpt-6.1-sol', '2026-01-01', 272001, 4.00, 0.20, 5.00, 10.00, 15.00),
      ('claude-haiku-5-5', '2026-01-01', 0, 0.10, 0.01, 0.125, 0.20, 0.50),
      ('claude-haiku-5-5', '2026-01-01', 100001, 0.50, 0.05, 0.625, 1.00, 2.50);
    insert into public.dashboard_users values ('${OWNER}');
  `);
  return db;
}

async function ingest(db: PGlite, records: unknown[], rows: unknown[]) {
  const r = await db.query<{ records_inserted: number; usage_inserted: number }>(
    "select * from private.ingest($1::jsonb, $2::jsonb)",
    [JSON.stringify(records), JSON.stringify(rows)],
  );
  return r.rows[0];
}

async function cost(db: PGlite, id: string): Promise<number | null> {
  const r = await db.query<{ c: string | null }>(
    "select estimated_cost_usd::text as c from public.usage_with_cost where id = $1",
    [id],
  );
  return r.rows[0].c == null ? null : Number(r.rows[0].c);
}

Deno.test("ingest is idempotent", async () => {
  const db = await setup();
  const records = [{ id: "log:a", occurred_at: "2026-10-01T12:00:00Z", name: "x", payload: { a: 1 } }];
  const first = await ingest(db, records, [usage({})]);
  assertEquals([Number(first.records_inserted), Number(first.usage_inserted)], [1, 1]);
  const again = await ingest(db, records, [usage({})]);
  assertEquals([Number(again.records_inserted), Number(again.usage_inserted)], [0, 0]);
});

Deno.test("cost uses rates in effect, size tier, and reported cost first", async () => {
  const db = await setup();
  await ingest(db, [], [
    usage({ id: "small" }),
    usage({ id: "large", input_tokens: 100000, cached_input_tokens: 200000 }),
    usage({ id: "before-prices", occurred_at: "2025-12-31T00:00:00Z" }),
    usage({ id: "unknown-model", model: "unpriced-model" }),
    usage({ id: "reported", tool: "claude_code", model: "claude-opus-5-5", reported_cost_usd: 0.42 }),
    usage({
      id: "haiku",
      tool: "claude_code",
      model: "claude-haiku-5-5",
      input_tokens: 10,
      cached_input_tokens: 1000,
      cache_write_tokens: 300,
      cache_write_5m_tokens: 100,
      cache_write_1h_tokens: 200,
      output_tokens: 50,
    }),
  ]);
  // 1000*2 + 2000*0.10 + 100*10 = 3200 per million
  assertAlmostEquals((await cost(db, "small"))!, 0.0032, 1e-12);
  // prompt 300000 > 272000: 100000*4 + 200000*0.20 + 100*15
  assertAlmostEquals((await cost(db, "large"))!, 0.4415, 1e-12);
  assertEquals(await cost(db, "before-prices"), null);
  assertEquals(await cost(db, "unknown-model"), null);
  assertAlmostEquals((await cost(db, "reported"))!, 0.42, 1e-12);
  // 10*0.10 + 1000*0.01 + 100*0.125 + 200*0.20 + 50*0.50 = 88.5 per million
  assertAlmostEquals((await cost(db, "haiku"))!, 0.0000885, 1e-12);
});

Deno.test("codex cache writes use the short cache-write rate", async () => {
  const db = await setup();
  await ingest(db, [], [usage({ id: "cw", input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 1000, output_tokens: 0 })]);
  assertAlmostEquals((await cost(db, "cw"))!, 0.0025, 1e-12);
});

Deno.test("usage_daily sums known costs and counts unpriced requests", async () => {
  const db = await setup();
  await ingest(db, [], [
    usage({ id: "a" }),
    usage({ id: "b" }),
    usage({ id: "c", model: "unpriced-model" }),
    usage({ id: "late", occurred_at: "2026-10-02T03:00:00Z" }),
  ]);
  const r = await db.query<Record<string, string>>(
    `select day::text, model, requests::int, cost_usd::text, unpriced_requests::int
     from public.usage_daily('2026-10-01', '2026-10-03', 'America/New_York') order by model, day`,
  );
  // 03:00 UTC on Oct 2 is Oct 1 in New York, so all rows land on Oct 1.
  assertEquals(r.rows.map((x) => [x.day, x.model, x.requests, Number(x.cost_usd), x.unpriced_requests]), [
    ["2026-10-01", "gpt-6.1-sol", 3, 0.0096, 0],
    ["2026-10-01", "unpriced-model", 1, 0, 1],
  ]);
});

Deno.test("usage_daily splits cost by token type, scaled to a reported cost", async () => {
  const db = await setup();
  await ingest(db, [], [
    usage({ id: "a" }),
    usage({ id: "rep", tool: "claude_code", model: "claude-haiku-5-5", cache_write_tokens: 1000, reported_cost_usd: 0.01 }),
    usage({ id: "odd", tool: "claude_code", model: "unpriced-model", reported_cost_usd: 0.5 }),
  ]);
  const r = await db.query<Record<string, string>>(
    `select model, cost_usd::text, input_cost_usd::text, cache_read_cost_usd::text,
       cache_write_cost_usd::text, output_cost_usd::text
     from public.usage_daily('2026-10-01', '2026-10-03') order by model`,
  );
  const parts = Object.fromEntries(r.rows.map((x) => [x.model, [
    Number(x.cost_usd), Number(x.input_cost_usd), Number(x.cache_read_cost_usd),
    Number(x.cache_write_cost_usd), Number(x.output_cost_usd),
  ]]));
  // Price table only: 1000 input, 2000 cached, 100 output tokens.
  const [cost, ...sol] = parts["gpt-6.1-sol"];
  assertAlmostEquals(cost, 0.0032, 1e-12);
  [0.002, 0.0002, 0, 0.001].forEach((v, i) => assertAlmostEquals(sol[i], v, 1e-12));
  // Reported $0.01 split in the price-table ratio 0.0001 : 0.00002 : 0.000125 : 0.00005.
  const [repCost, ...rep] = parts["claude-haiku-5-5"];
  assertAlmostEquals(repCost, 0.01, 1e-12);
  [0.0001, 0.00002, 0.000125, 0.00005].forEach((v, i) => assertAlmostEquals(rep[i], (v / 0.000295) * 0.01, 1e-12));
  // A reported cost with no price stays unsplit.
  assertEquals(parts["unpriced-model"], [0.5, 0, 0, 0, 0]);
});

async function ingestPrompts(db: PGlite, rows: unknown[]) {
  const r = await db.query<{ prompts_inserted: number }>(
    "select * from private.ingest('[]'::jsonb, '[]'::jsonb, $1::jsonb)",
    [JSON.stringify(rows)],
  );
  return Number(r.rows[0].prompts_inserted);
}

Deno.test("prompts are stored once; a re-sent usage row fills a missing query_source", async () => {
  const db = await setup();
  const prompt = {
    id: "p1", occurred_at: "2026-10-01T12:00:00Z", tool: "claude_code", session_id: "s1",
    prompt_length: 42, command_name: null, originator: null,
  };
  assertEquals(await ingestPrompts(db, [prompt, { ...prompt, id: "p2", command_name: "compact" }]), 2);
  assertEquals(await ingestPrompts(db, [prompt]), 0);
  const p = await db.query<Record<string, unknown>>("select id, prompt_length, command_name from public.prompt_events order by id");
  assertEquals(p.rows, [
    { id: "p1", prompt_length: 42, command_name: null },
    { id: "p2", prompt_length: 42, command_name: "compact" },
  ]);

  // Backfilled first without query_source, then re-sent with one.
  assertEquals((await ingest(db, [], [usage({ id: "u1" })])).usage_inserted, 1);
  assertEquals(Number((await ingest(db, [], [usage({ id: "u1", query_source: "sdk" })])).usage_inserted), 0);
  await ingest(db, [], [usage({ id: "u1", query_source: "repl_main_thread" })]);
  const u = await db.query<{ query_source: string }>("select query_source from public.usage_events where id = 'u1'");
  assertEquals(u.rows[0].query_source, "sdk");
});

Deno.test("prompt_hourly counts only your prompts", async () => {
  const db = await setup();
  const prompt = (id: string, over: Record<string, unknown>) => ({
    id, occurred_at: "2026-10-01T12:00:00Z", tool: "claude_code", session_id: "s1",
    prompt_length: 10, command_name: null, originator: null, ...over,
  });
  await ingestPrompts(db, [
    prompt("c1", {}),
    prompt("c2", { command_name: "compact" }),
    prompt("c3", { session_id: "scripted" }),
    prompt("x1", { tool: "codex", session_id: "t1", originator: "codex-tui" }),
    prompt("x2", { tool: "codex", session_id: "t2", originator: "codex_exec" }),
    prompt("late", { occurred_at: "2026-10-02T03:00:00Z" }),
  ]);
  await ingest(db, [], [
    usage({ id: "u1", tool: "claude_code", session_id: "s1", query_source: "repl_main_thread" }),
    usage({ id: "u2", tool: "claude_code", session_id: "scripted", query_source: "sdk" }),
  ]);
  const r = await db.query<Record<string, string>>(
    `select day::text, hour, tool, prompts::int from public.prompt_hourly('2026-10-01', '2026-10-03', 'America/New_York') order by day, hour, tool`,
  );
  // 03:00 UTC on Oct 2 is 23:00 on Oct 1 in New York.
  assertEquals(r.rows.map((x) => [x.day, x.hour, x.tool, x.prompts]), [
    ["2026-10-01", 8, "claude_code", 2],
    ["2026-10-01", 8, "codex", 1],
    ["2026-10-01", 23, "claude_code", 1],
  ]);
});

Deno.test("usage_hourly buckets by local day and hour", async () => {
  const db = await setup();
  await ingest(db, [], [
    usage({ id: "a" }),
    usage({ id: "b", occurred_at: "2026-10-01T12:59:59Z", model: "unpriced-model" }),
    usage({ id: "late", occurred_at: "2026-10-02T03:00:00Z" }),
  ]);
  const r = await db.query<Record<string, string>>(
    `select day::text, hour, requests::int, tokens::int, cost_usd::text
     from public.usage_hourly('2026-10-01', '2026-10-03', 'America/New_York') order by day, hour`,
  );
  // 12:00 UTC is 08:00 in New York; 03:00 UTC on Oct 2 is 23:00 on Oct 1.
  assertEquals(r.rows.map((x) => [x.day, x.hour, x.requests, x.tokens, Number(x.cost_usd)]), [
    ["2026-10-01", 8, 2, 6200, 0.0032],
    ["2026-10-01", 23, 1, 3100, 0.0032],
  ]);
});

Deno.test("raw records older than 30 days are pruned; usage rows are kept", async () => {
  const db = await setup();
  await ingest(db, [
    { id: "log:old", occurred_at: null, name: "x", payload: {} },
    { id: "log:new", occurred_at: null, name: "x", payload: {} },
  ], [usage({ id: "u-old", occurred_at: "2025-01-01T00:00:00Z" })]);
  await db.exec(`
    update public.telemetry_records set received_at = now() - interval '31 days' where id = 'log:old';
  `);
  const r = await db.query<{ n: number }>("select private.prune_telemetry_records()::int as n");
  assertEquals(r.rows[0].n, 1);
  const left = await db.query<{ id: string }>("select id from public.telemetry_records");
  assertEquals(left.rows.map((x) => x.id), ["log:new"]);
  const usageLeft = await db.query<{ n: number }>("select count(*)::int as n from public.usage_events");
  assertEquals(usageLeft.rows[0].n, 1);
});

Deno.test("only listed dashboard users can read; nobody else can write", async () => {
  const db = await setup();
  await ingest(db, [{ id: "log:a", occurred_at: null, name: "x", payload: {} }], [usage({})]);
  await ingestPrompts(db, [{ id: "p", occurred_at: "2026-10-01T12:00:00Z", tool: "codex", session_id: "s", prompt_length: 1 }]);
  const countAs = async (role: string, sub: string, table: string) => {
    await db.exec(`set role ${role}; set request.jwt.claim.sub = '${sub}';`);
    try {
      return Number((await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n);
    } finally {
      await db.exec("reset role; reset request.jwt.claim.sub;");
    }
  };
  for (const table of ["public.usage_events", "public.usage_with_cost", "public.telemetry_records", "public.model_pricing", "public.prompt_events", "public.human_prompts"]) {
    assert((await countAs("authenticated", OWNER, table)) > 0, `owner reads ${table}`);
    assertEquals(await countAs("authenticated", STRANGER, table), 0, `stranger sees nothing in ${table}`);
  }
  await db.exec("set role authenticated; set request.jwt.claim.sub = '" + OWNER + "';");
  try {
    await assertRejects(() => db.query("insert into public.usage_events (id) values ('x')"));
    await assertRejects(() => db.query("insert into public.prompt_events (id) values ('x')"));
    await assertRejects(() => db.query("select * from private.ingest('[]', '[]')"));
    await assertRejects(() => db.query("select * from public.dashboard_users"));
  } finally {
    await db.exec("reset role; reset request.jwt.claim.sub;");
  }
  await db.exec("set role anon;");
  try {
    await assertRejects(() => db.query("select * from public.usage_events"));
    await assertRejects(() => db.query("select * from public.prompt_events"));
    await assertRejects(() => db.query("select * from public.usage_daily(now() - interval '1 day', now())"));
    await assertRejects(() => db.query("select * from public.usage_hourly(now() - interval '1 day', now())"));
    await assertRejects(() => db.query("select * from public.prompt_hourly(now() - interval '1 day', now())"));
  } finally {
    await db.exec("reset role;");
  }
});

Deno.test("pricing file loads and has a base row for every model", async () => {
  const db = new PGlite();
  await db.exec(SUPABASE_STANDINS);
  await db.exec(MIGRATION);
  const pricing = Deno.readTextFileSync(new URL("../supabase/pricing.sql", import.meta.url));
  await db.exec(pricing);
  await db.exec(pricing); // re-running updates in place
  const r = await db.query<{ missing: number; rows: number }>(
    `select count(*) filter (where not exists (
       select 1 from public.model_pricing b where b.model = p.model and b.effective_from = p.effective_from and b.min_prompt_tokens = 0
     ))::int as missing, count(*)::int as rows from public.model_pricing p`,
  );
  assertEquals(r.rows[0].missing, 0);
  assertEquals(r.rows[0].rows, 25);
});
