// Who did what, one JSON object per line on stdout, which is what `flyctl logs` shows (ADR-0028).
// Agent-written text is untrusted: JSON encoding keeps it from forging extra lines, strings are
// clipped, and anything shaped like a credential or a message body is dropped (CLAUDE.md: never log
// raw tokens).

export type Fields = Record<string, unknown>;

const MAX = 200;
// Keys never logged, whatever a caller passes: credentials, and agent-authored free text.
// Agent-authored free text is dropped by name too (ADR-0046), so a new call site cannot leak it by accident.
const DROP = /token|secret|authorization|password|body|bio|reason|^(display_name|interests|looking_for|emoji|message|content)$/i;
const TOKEN = /tok_[A-Za-z0-9_-]+/g;

function clean(value: unknown): unknown {
  if (typeof value === "string") {
    const s = value.replace(TOKEN, "tok_[redacted]");
    return s.length > MAX ? `${s.slice(0, MAX)}…` : s;
  }
  return typeof value === "number" || typeof value === "boolean" || value === null ? value : undefined;
}

const HANDLE = /^[a-z0-9_]{3,24}$/;
const MODEL = /^[A-Za-z0-9._:\/+@-]{1,60}$/;
const NAME = /^[A-Za-z0-9_.\/-]{1,64}$/;
/** A handle the caller sent, logged only when it has the handle format; anything else is agent text (ADR-0038 rule 7). */
export const safeHandle = (v: unknown): string | undefined => (v === undefined ? undefined : typeof v === "string" && HANDLE.test(v) ? v : "[not a handle]");
/** A model name the caller sent, logged only in a plain charset. */
export const safeModel = (v: unknown): string => (typeof v === "string" && MODEL.test(v.trim()) ? v.trim() : "[other]");
/** A JSON-RPC method or tool name from an unauthenticated caller. */
export const safeName = (v: unknown): string => (typeof v === "string" && NAME.test(v) ? v : "?");
/** A request path with any segment that is not a plain name (a handle, an id, a file) masked: a path is caller text. */
export const safePath = (path: string): string =>
  path.split("/").map((seg) => (seg === "" || /^[A-Za-z0-9_.-]{1,40}$/.test(seg) ? seg : "[x]")).join("/");
/** An error message with the caller's own input cut out, for refusals that repeat it ("No agent with handle ..."). */
export function withoutInput(message: string, input: unknown): string {
  return typeof input === "string" && input.length > 0 && safeHandle(input) !== input ? message.split(input).join("[input]") : message;
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
