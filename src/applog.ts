// The stored log (ADR-0034): every line src/log.ts writes is also kept in SQLite, so an admin can
// download it by ISO week. Lines are already redacted by log.ts; nothing extra is stored here.
import { config } from "./config.ts";
import { db } from "./db.ts";
import { setSink } from "./log.ts";

const DAY = 86_400_000;
/** A week of a busy deployment can be large and the admin response is built in memory (256 MB app). */
export const MAX_DOWNLOAD_LINES = 200_000;

const insert = db.prepare("INSERT INTO app_log (ts, event, line) VALUES (?, ?, ?)");
setSink((ts, event, line) => {
  insert.run(ts, event, line);
});

export function prune(now = Date.now()): number {
  return Number(db.prepare("DELETE FROM app_log WHERE ts < ?").run(now - config.logRetentionDays * DAY).changes);
}
prune();
setInterval(prune, 6 * 3_600_000).unref();

// --- ISO weeks, in UTC: Monday to Sunday, week 1 holds 4 January ---
const mondayOfWeek1 = (year: number): number => {
  const jan4 = Date.UTC(year, 0, 4);
  return jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
};

export function weekLabel(ms: number): string {
  const d = new Date(ms);
  // the ISO year is the year of that week's Thursday
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY + 3 * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - mondayOfWeek1(year)) / (7 * DAY)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** [start, end) in ms for a label like 2026-W42, or null if it is not one. */
export function weekRange(label: string): [number, number] | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) return null;
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const start = mondayOfWeek1(Number(m[1])) + (week - 1) * 7 * DAY;
  return weekLabel(start) === label ? [start, start + 7 * DAY] : null;
}

export interface WeekSummary {
  week: string;
  lines: number;
  mcp: number;
  start: number;
}

/** Weeks that have any lines, newest first. */
export function weeks(): WeekSummary[] {
  const rows = db
    .prepare("SELECT CAST(ts / ? AS INTEGER) AS day, COUNT(*) AS n, SUM(event = 'mcp') AS mcp FROM app_log GROUP BY day")
    .all(DAY) as { day: number; n: number; mcp: number }[];
  const out = new Map<string, WeekSummary>();
  for (const r of rows) {
    const label = weekLabel(r.day * DAY);
    const w = out.get(label) ?? { week: label, lines: 0, mcp: 0, start: weekRange(label)![0] };
    w.lines += r.n;
    w.mcp += Number(r.mcp);
    out.set(label, w);
  }
  return [...out.values()].sort((a, b) => b.start - a.start);
}

/** The week's lines as JSON Lines, oldest first, and whether the cap cut it short. */
export function download(label: string): { name: string; body: string; truncated: boolean } | null {
  const range = label === "all" ? ([0, Number.MAX_SAFE_INTEGER] as [number, number]) : weekRange(label);
  if (!range) return null;
  const rows = db
    .prepare("SELECT line FROM app_log WHERE ts >= ? AND ts < ? ORDER BY id LIMIT ?")
    .all(range[0], range[1], MAX_DOWNLOAD_LINES + 1) as { line: string }[];
  const truncated = rows.length > MAX_DOWNLOAD_LINES;
  const body = rows.slice(0, MAX_DOWNLOAD_LINES).map((r) => r.line).join("\n");
  return { name: `ribbon-cable-log-${label}.jsonl`, body: body ? `${body}\n` : "", truncated };
}
