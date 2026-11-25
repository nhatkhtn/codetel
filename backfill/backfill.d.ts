import type { PromptEvent, UsageEvent } from "../supabase/functions/_shared/telemetry.ts";

export function claudeRows(file: string): AsyncGenerator<UsageEvent>;
export function codexRows(file: string): AsyncGenerator<UsageEvent>;
export function antigravityRows(file: string, sessionId?: string | null): AsyncGenerator<UsageEvent>;
export function claudePrompts(file: string): AsyncGenerator<PromptEvent>;
export function codexPrompts(file: string): AsyncGenerator<PromptEvent>;
export function antigravityPrompts(file: string, sessionId?: string | null): AsyncGenerator<PromptEvent>;
export const TOOLS: readonly string[];
export function collect(
  options: { claudeDir: string; codexDirs: string[]; antigravityDir?: string; before: string; tools?: string[] },
): Promise<{ usage: UsageEvent[]; prompts: PromptEvent[] }>;
