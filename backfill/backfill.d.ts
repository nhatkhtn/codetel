import type { UsageEvent } from "../supabase/functions/_shared/telemetry.ts";

export function claudeRows(file: string): AsyncGenerator<UsageEvent>;
export function codexRows(file: string): AsyncGenerator<UsageEvent>;
export function collect(options: { claudeDir: string; codexDirs: string[]; before: string }): Promise<UsageEvent[]>;
