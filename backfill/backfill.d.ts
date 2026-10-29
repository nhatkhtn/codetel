import type { PromptEvent, UsageEvent } from "../supabase/functions/_shared/telemetry.ts";

export function claudeRows(file: string): AsyncGenerator<UsageEvent>;
export function codexRows(file: string): AsyncGenerator<UsageEvent>;
export function claudePrompts(file: string): AsyncGenerator<PromptEvent>;
export function codexPrompts(file: string): AsyncGenerator<PromptEvent>;
export function collect(
  options: { claudeDir: string; codexDirs: string[]; before: string },
): Promise<{ usage: UsageEvent[]; prompts: PromptEvent[] }>;
