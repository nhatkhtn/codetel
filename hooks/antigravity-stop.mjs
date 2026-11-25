#!/usr/bin/env node
// Antigravity CLI Stop hook: converts new PLANNER_RESPONSE and USER_INPUT
// entries from the conversation's transcript.jsonl into an OTLP/HTTP JSON
// ExportLogsServiceRequest and posts it to the codetel ingest Edge Function.
//
// Configured in ~/.gemini/config/hooks.json under "Stop".
//
// Environment:
//   CODETEL_INGEST_URL         e.g. https://<ref>.supabase.co/functions/v1/ingest
//   CODETEL_UPLOAD_SECRET      the upload secret
// Optional:
//   CODETEL_ANTIGRAVITY_STATE  path to per-conversation step cursor JSON
//   CODETEL_TIMEOUT_MS         HTTP request timeout in ms (default 3000)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseAntigravityTranscript } from "../backfill/backfill.mjs";

const DEFAULT_TIMEOUT_MS = 3000;

function isoToNanos(iso) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "0" : (BigInt(ms) * 1000000n).toString();
}

function strAttr(key, value) {
  return { key, value: { stringValue: String(value) } };
}

function intAttr(key, value) {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

/**
 * Builds an OTLP ExportLogsServiceRequest JSON payload from parsed Antigravity
 * transcript usage and prompt entries.
 */
export function buildOtlpLogs({ usage, prompts, hostName = os.hostname() }) {
  const logRecords = [];
  for (const { step_index, row } of usage) {
    const nanos = isoToNanos(row.occurred_at);
    logRecords.push({
      timeUnixNano: nanos,
      observedTimeUnixNano: nanos,
      body: { stringValue: "antigravity.api_request" },
      attributes: [
        strAttr("event.name", "antigravity.api_request"),
        strAttr("event.timestamp", row.occurred_at),
        strAttr("conversation.id", row.session_id),
        intAttr("step.index", step_index),
        strAttr("model", row.model),
        intAttr("input_tokens", row.input_tokens),
        intAttr("cached_input_tokens", row.cached_input_tokens),
        intAttr("output_tokens", row.output_tokens),
      ],
    });
  }
  for (const { step_index, row } of prompts) {
    const nanos = isoToNanos(row.occurred_at);
    const attrs = [
      strAttr("event.name", "antigravity.user_prompt"),
      strAttr("event.timestamp", row.occurred_at),
      strAttr("conversation.id", row.session_id),
      intAttr("step.index", step_index),
      intAttr("prompt_length", row.prompt_length),
    ];
    if (row.originator) attrs.push(strAttr("originator", row.originator));
    logRecords.push({
      timeUnixNano: nanos,
      observedTimeUnixNano: nanos,
      body: { stringValue: "antigravity.user_prompt" },
      attributes: attrs,
    });
  }
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            strAttr("service.name", "antigravity-cli"),
            strAttr("host.name", hostName),
          ],
        },
        scopeLogs: [
          {
            scope: { name: "codetel.antigravity_hook", version: "1.0.0" },
            logRecords,
          },
        ],
      },
    ],
  };
}

function readState(stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state) + "\n");
  fs.renameSync(tmp, stateFile);
}

function resolveTranscriptPath(input) {
  if (input.transcriptPath && fs.existsSync(input.transcriptPath)) return input.transcriptPath;
  if (!input.conversationId) return null;
  const fallback = path.join(
    os.homedir(),
    ".gemini",
    "antigravity-cli",
    "brain",
    input.conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * Exports any un-exported steps for one Antigravity conversation, updating the
 * local step cursor only after the ingest endpoint returns 2xx.
 */
export async function exportStopEvent(input, opts = {}) {
  const url = opts.ingestUrl ?? process.env.CODETEL_INGEST_URL;
  const secret = opts.uploadSecret ?? process.env.CODETEL_UPLOAD_SECRET;
  const conversationId = input?.conversationId;
  if (!url || !secret || !conversationId) return { sent: 0 };

  const transcriptPath = resolveTranscriptPath(input);
  if (!transcriptPath) return { sent: 0 };

  const stateFile = opts.stateFile
    ?? process.env.CODETEL_ANTIGRAVITY_STATE
    ?? path.join(os.homedir(), ".gemini", "antigravity-cli", "cache", "codetel-state.json");
  const state = readState(stateFile);
  const lastStep = Number.isSafeInteger(state[conversationId]) ? state[conversationId] : -1;

  const parsed = await parseAntigravityTranscript(transcriptPath, conversationId);
  const usage = parsed.usage.filter((x) => x.step_index > lastStep);
  const prompts = parsed.prompts.filter((x) => x.step_index > lastStep);
  if (usage.length === 0 && prompts.length === 0) return { sent: 0 };

  const body = buildOtlpLogs({ usage, prompts, hostName: opts.hostName });
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.CODETEL_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const fetchImpl = opts.fetch ?? fetch;
  const endpoint = `${url.replace(/\/$/, "")}/v1/logs`;

  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`codetel ingest failed: HTTP ${res.status}`);
  }

  const maxStep = Math.max(
    lastStep,
    ...usage.map((x) => x.step_index),
    ...prompts.map((x) => x.step_index),
  );
  state[conversationId] = maxStep;
  writeState(stateFile, state);
  return { sent: usage.length + prompts.length, maxStep };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main() {
  try {
    const raw = await readStdin();
    if (raw) {
      const input = JSON.parse(raw);
      await exportStopEvent(input);
    }
  } catch (err) {
    if (process.env.CODETEL_DEBUG === "1") {
      console.error("[codetel antigravity hook]", err instanceof Error ? err.message : String(err));
    }
  }
  // Always return {} and exit 0 so offline/transient errors never block agy.
  process.stdout.write("{}\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
