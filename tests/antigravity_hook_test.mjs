import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { collect } from "../backfill/backfill.mjs";
import { exportStopEvent } from "../hooks/antigravity-stop.mjs";
import { backfillError, parseLogs, promptBackfillError } from "../supabase/functions/_shared/telemetry.ts";

function writeLines(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("antigravity Stop hook exports incremental OTLP logs and round-trips through parseLogs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetel-agy-hook-"));
  try {
    const convId = "conv-123";
    const transcriptPath = path.join(dir, convId, ".system_generated", "logs", "transcript.jsonl");
    const stateFile = path.join(dir, "state.json");

    writeLines(transcriptPath, [
      { type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", step_index: 0, created_at: "2026-11-25T21:19:50Z", content: "hello" },
      { type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", step_index: 1, created_at: "2026-11-25T21:19:51Z", model: "gemini-4-hydrogen-high", input_tokens: 100, cache_read_tokens: 0, output_tokens: 20 },
      { type: "PLANNER_RESPONSE", source: "MODEL", status: "STREAMING", step_index: 2, created_at: "2026-11-25T21:19:52Z", model: "gemini-4-hydrogen-high", input_tokens: 5, cache_read_tokens: 0, output_tokens: 1 },
    ]);

    const sent = [];
    const okFetch = async (url, init) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    };

    const first = await exportStopEvent(
      { conversationId: convId, transcriptPath, hookEventName: "Stop" },
      { ingestUrl: "https://example.supabase.co/functions/v1/ingest/", uploadSecret: "sec", stateFile, fetch: okFetch, hostName: "test-host" },
    );
    assert.deepEqual(first, { sent: 2, maxStep: 1 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://example.supabase.co/functions/v1/ingest/v1/logs");
    assert.equal(sent[0].headers.authorization, "Bearer sec");

    const parsed = await parseLogs(sent[0].body);
    assert.equal(parsed.records.length, 2);
    assert.deepEqual(parsed.usage.map((u) => [u.id, u.tool, u.model, u.input_tokens, u.cached_input_tokens, u.output_tokens]), [
      ["agy:conv-123:1", "antigravity", "gemini-4-hydrogen-high", 100, 0, 20],
    ]);
    assert.deepEqual(parsed.prompts.map((p) => [p.id, p.tool, p.prompt_length, p.originator]), [
      ["agy:conv-123:0", "antigravity", 5, "antigravity-cli"],
    ]);

    // Second Stop with no new steps sends nothing.
    const second = await exportStopEvent(
      { conversationId: convId, transcriptPath },
      { ingestUrl: "https://example.supabase.co/functions/v1/ingest", uploadSecret: "sec", stateFile, fetch: okFetch },
    );
    assert.deepEqual(second, { sent: 0 });
    assert.equal(sent.length, 1);

    // Failed upload does not advance cursor; subsequent Stop succeeds.
    writeLines(transcriptPath, [
      { type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", step_index: 0, created_at: "2026-11-25T21:19:50Z", content: "hello" },
      { type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", step_index: 1, created_at: "2026-11-25T21:19:51Z", model: "gemini-4-hydrogen-high", input_tokens: 100, cache_read_tokens: 0, output_tokens: 20 },
      { type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", step_index: 4, created_at: "2026-11-25T21:19:57Z", model: "gemini-4-hydrogen-high", input_tokens: 50, cache_read_tokens: 120, output_tokens: 15 },
    ]);
    await assert.rejects(
      () => exportStopEvent(
        { conversationId: convId, transcriptPath },
        { ingestUrl: "https://example.supabase.co/functions/v1/ingest", uploadSecret: "sec", stateFile, fetch: async () => new Response("err", { status: 500 }) },
      ),
      /HTTP 500/,
    );
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8"))[convId], 1);

    const third = await exportStopEvent(
      { conversationId: convId, transcriptPath },
      { ingestUrl: "https://example.supabase.co/functions/v1/ingest", uploadSecret: "sec", stateFile, fetch: okFetch },
    );
    assert.deepEqual(third, { sent: 1, maxStep: 4 });
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8"))[convId], 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("antigravity Stop CLI fails open with {} and exit 0 when unconfigured", () => {
  const res = spawnSync(process.execPath, ["hooks/antigravity-stop.mjs"], {
    input: JSON.stringify({ conversationId: "x", hookEventName: "Stop" }),
    env: { ...process.env, CODETEL_INGEST_URL: "", CODETEL_UPLOAD_SECRET: "" },
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "{}");
});

test("backfill collect supports antigravityDir and passes telemetry validation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetel-agy-backfill-"));
  try {
    const brain = path.join(dir, "brain");
    writeLines(path.join(brain, "sess-a", ".system_generated", "logs", "transcript.jsonl"), [
      { type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", step_index: 0, created_at: "2026-10-01T10:00:00Z", content: "hi" },
      { type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", step_index: 1, created_at: "2026-10-01T10:00:02Z", model: "gemini-4-hydrogen-high", input_tokens: 200, cache_read_tokens: 300, output_tokens: 40 },
    ]);
    const { usage, prompts } = await collect({
      claudeDir: path.join(dir, "none-claude"),
      codexDirs: [path.join(dir, "none-codex")],
      antigravityDir: brain,
      before: "2026-10-02T00:00:00Z",
    });
    assert.equal(usage.length, 1);
    assert.equal(prompts.length, 1);
    assert.equal(backfillError(usage[0]), null);
    assert.equal(promptBackfillError(prompts[0]), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
