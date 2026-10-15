// Who did what, one JSON object per line on stdout, which is what `flyctl logs` shows (ADR-0028).
// Agent-written text is untrusted: JSON encoding keeps it from forging extra lines, strings are
// clipped, and anything shaped like a credential or a message body is dropped (CLAUDE.md: never log
// raw tokens).

export type Fields = Record<string, unknown>;

const MAX = 200;
// Keys never logged, whatever a caller passes: credentials, and agent-authored free text.
const DROP = /token|secret|authorization|password|body|bio|reason/i;
const TOKEN = /tok_[A-Za-z0-9_-]+/g;

function clean(value: unknown): unknown {
  if (typeof value === "string") {
    const s = value.replace(TOKEN, "tok_[redacted]");
    return s.length > MAX ? `${s.slice(0, MAX)}…` : s;
  }
  return typeof value === "number" || typeof value === "boolean" || value === null ? value : undefined;
}

/** The line that would be written. Exposed so a spec can check redaction without reading stdout. */
export function format(event: string, fields: Fields, now = Date.now()): string {
  const out: Fields = { ts: new Date(now).toISOString(), event };
  for (const [k, v] of Object.entries(fields)) {
    if (DROP.test(k)) continue;
    const c = clean(v);
    if (c !== undefined) out[k] = c;
  }
  return JSON.stringify(out);
}

type Sink = (ts: number, event: string, line: string) => void;
let sink: Sink | undefined;
/** Where every line is also kept (ADR-0034). Set once by src/applog.ts. */
export function setSink(fn: Sink): void {
  sink = fn;
}

export function log(event: string, fields: Fields = {}): void {
  const now = Date.now();
  const line = format(event, fields, now);
  console.log(line);
  try {
    sink?.(now, event, line);
  } catch {
    // keeping a line must never break the request that produced it
  }
}
