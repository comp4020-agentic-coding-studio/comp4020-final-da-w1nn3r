// The stored log (ADR-0034): every line src/log.ts writes is also kept in SQLite, so an admin can
// download it by ISO week. Lines are already redacted by log.ts; nothing extra is stored here.
import { config } from "./config.ts";
import { db, dbFull } from "./db.ts";
import { capRows } from "./limits.ts";
import { setSink } from "./log.ts";

const DAY = 86_400_000;
/** A download is streamed in pages of this many lines (ADR-0098), so memory stays flat however big the week is. */
export const DOWNLOAD_PAGE = 2_000;

const insert = db.prepare("INSERT INTO app_log (ts, event, line) VALUES (?, ?, ?)");
setSink((ts, event, line) => {
  // Past the database budget the log is only written to stdout (ADR-0098): it must not be what fills the volume.
  if (dbFull()) return;
  insert.run(ts, event, line);
});

/** Drop lines older than the retention, then the oldest lines beyond LOG_MAX_ROWS (ADR-0034, ADR-0098). */
export function prune(now = Date.now(), maxRows = config.logMaxRows): number {
  const n = Number(db.prepare("DELETE FROM app_log WHERE ts < ?").run(now - config.logRetentionDays * DAY).changes);
  return n + capRows(db, "app_log", maxRows);
}
prune();
// Hourly: the row cap has to keep up with a flood, not just with age.
setInterval(() => prune(), 3_600_000).unref();

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

/**
 * The week's lines as JSON Lines, oldest first, as a stream of pages (ADR-0098): each page is a short query by id,
 * so no read transaction is held between pages and at most DOWNLOAD_PAGE lines are in memory at once.
 */
export function download(label: string): { name: string; pages: () => Generator<string> } | null {
  const range = label === "all" ? ([0, Number.MAX_SAFE_INTEGER] as [number, number]) : weekRange(label);
  if (!range) return null;
  const page = db.prepare("SELECT id, line FROM app_log WHERE ts >= ? AND ts < ? AND id > ? ORDER BY id LIMIT ?");
  return {
    name: `ribbon-cable-log-${label}.jsonl`,
    *pages() {
      let after = 0;
      for (;;) {
        const rows = page.all(range[0], range[1], after, DOWNLOAD_PAGE) as { id: number; line: string }[];
        if (!rows.length) return;
        after = Number(rows[rows.length - 1].id);
        yield rows.map((r) => `${r.line}\n`).join("");
        if (rows.length < DOWNLOAD_PAGE) return;
      }
    },
  };
}
