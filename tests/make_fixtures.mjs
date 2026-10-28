// Builds scrubbed test fixtures from local OTLP captures (otlp.jsonl files
// written by a capture receiver, one {path, body} upload per line).
//
//   node tests/make_fixtures.mjs <capture otlp.jsonl> <fixture name> [...more pairs]
//
// Account identifiers, emails, host names, paths, and tool I/O are replaced;
// session/turn/request identifiers are replaced by consistent fakes; spans
// are trimmed to the kept turn span plus a few others.

import fs from "node:fs";
import path from "node:path";

const REDACT_KEYS = new Set([
  "user.id", "user.email", "user.account_uuid", "user.account_id", "organization.id",
  "host.name", "arguments", "output", "cwd",
]);
const FAKE_ID_KEYS = new Set([
  "conversation.id", "thread.id", "session.id", "prompt.id", "turn.id", "request_id",
  "client_request_id", "message.uuid", "tool_use_id", "call_id",
  "gen_ai.conversation.id", "gen_ai.response.id", "gen_ai.tool.call.id",
]);
const OTHER_SPANS_KEPT = 3;

const fakeIds = new Map();
function fakeId(value) {
  if (!fakeIds.has(value)) {
    const n = String(fakeIds.size + 1).padStart(12, "0");
    fakeIds.set(value, `00000000-0000-4000-8000-${n}`);
  }
  return fakeIds.get(value);
}

function scrubAttributes(list) {
  for (const a of list ?? []) {
    const v = a.value ?? {};
    if (REDACT_KEYS.has(a.key) && "stringValue" in v) v.stringValue = "[scrubbed]";
    else if (FAKE_ID_KEYS.has(a.key) && "stringValue" in v) v.stringValue = fakeId(v.stringValue);
    else if ("stringValue" in v && /\/(home|blue|tmp|local)\//.test(v.stringValue)) v.stringValue = "[path]";
  }
}

function scrubUpload({ path: urlPath, body }) {
  for (const r of [...(body.resourceLogs ?? []), ...(body.resourceSpans ?? [])]) {
    scrubAttributes(r.resource?.attributes);
    for (const s of r.scopeLogs ?? []) for (const x of s.logRecords ?? []) scrubAttributes(x.attributes);
    for (const s of r.scopeSpans ?? []) {
      let others = 0;
      s.spans = (s.spans ?? []).filter((x) => x.name === "session_task.turn" || others++ < OTHER_SPANS_KEPT);
      for (const x of s.spans) {
        scrubAttributes(x.attributes);
        for (const e of x.events ?? []) scrubAttributes(e.attributes);
      }
    }
  }
  return { path: urlPath, body };
}

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2) {
  console.error("usage: node tests/make_fixtures.mjs <otlp.jsonl> <name> [...]");
  process.exit(2);
}
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
fs.mkdirSync(outDir, { recursive: true });
for (let i = 0; i < args.length; i += 2) {
  const uploads = fs.readFileSync(args[i], "utf8").trim().split("\n")
    .map((line) => JSON.parse(line))
    .filter((u) => u.path === "/v1/logs" || u.path === "/v1/traces")
    .map(scrubUpload);
  const out = path.join(outDir, `${args[i + 1]}.json`);
  // Faked IDs also appear under other keys (e.g. submission.id); replace all.
  let text = JSON.stringify(uploads, null, 1);
  for (const [real, fake] of fakeIds) text = text.replaceAll(real, fake);
  fs.writeFileSync(out, text + "\n");
  console.log(`${out}: ${uploads.length} uploads`);
}
