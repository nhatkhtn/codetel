// Pure helpers for archiving raw telemetry records to Storage as gzipped
// JSONL (built by Postgres, one `to_json` row per line), one folder per UTC day (`YYYY-MM-DD/part-<run>-<n>.jsonl.gz`).

export const BUCKET = "raw-archive";
export const KEEP_DAYS = 180;
export const PAGE_ROWS = 5_000;
export const MAX_PAGES_PER_RUN = 3;

// Part names carry the run time, so a retried upload never overwrites a part
// whose rows were already deleted. A crash between upload and delete leaves a
// duplicate part; row IDs are unique, so readers drop repeats.
export function partPath(day: string, runId: string, part: number): string {
  return `${day}/part-${runId}-${String(part).padStart(4, "0")}.jsonl.gz`;
}

export function isDay(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

// Day folders older than `keepDays` before `today` (both `YYYY-MM-DD`, UTC).
export function expiredDays(folders: string[], today: string, keepDays = KEEP_DAYS): string[] {
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);
  const cut = cutoff.toISOString().slice(0, 10);
  return folders.filter((f) => isDay(f) && f < cut).sort();
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
