import { assert, assertEquals } from "jsr:@std/assert@1";
import { expiredDays, gzip, isDay, partPath } from "../supabase/functions/_shared/archive.ts";

Deno.test("archive: part paths sort by run then part number", () => {
  assertEquals(partPath("2026-11-24", "20261125T033000", 1), "2026-11-24/part-20261125T033000-0001.jsonl.gz");
  assert(partPath("2026-11-24", "20261125T033000", 2) < partPath("2026-11-24", "20261125T033000", 10));
});

Deno.test("archive: days are YYYY-MM-DD only", () => {
  assert(isDay("2026-11-24"));
  for (const bad of ["2026-13-01", "2026-11-24/", "part-1", "", "2026-1-1"]) assert(!isDay(bad), bad);
});

Deno.test("archive: expiry keeps the last 180 days and ignores non-day names", () => {
  const folders = ["2026-05-01", "2026-05-28", "2026-05-29", "2026-11-23", "notes", "2026-05-30"];
  // 180 days before 2026-11-24 is 2026-05-28: that day is kept, earlier days expire.
  assertEquals(expiredDays(folders, "2026-11-24"), ["2026-05-01"]);
  assertEquals(expiredDays(["2026-05-27", "2026-05-28"], "2026-11-24"), ["2026-05-27"]);
});

Deno.test("archive: text round-trips through gzip", async () => {
  const text = '{"id":"log:a","payload":{"x":"é\\n"}}\n{"id":"span:b","payload":{}}\n';
  const gz = await gzip(text);
  const back = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  assertEquals(back, text);
  assert(gz.length < text.length * 2);
});
