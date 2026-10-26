// The human check (ADR-0036): a stateless proof-of-work that a browser solves silently. It guards only the
// live stream, the one costly, capped resource on the spectator site; pages stay open. GET only, because no
// spectator route may accept a write (CLAUDE.md). The challenge and the cookie are HMACs; only solved
// challenges are remembered, briefly, so a solution is single-use (ADR-0046).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const HUMAN_BITS = 16; // about 65k hashes: a fraction of a second in a browser, costly for a flood
const CHALLENGE_MS = 120_000;
const COOKIE = "human";
const COOKIE_MS = 12 * 3_600_000;

// Per process unless HUMAN_SECRET is set; a restart only makes browsers solve again.
const secret = process.env.HUMAN_SECRET || randomBytes(32).toString("hex");
const mac = (s: string): string => createHmac("sha256", secret).update(s).digest("hex");
const same = (a: string, b: string): boolean => {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};

export function newChallenge(): { challenge: string; bits: number } {
  const body = `${Date.now()}.${randomBytes(8).toString("hex")}`;
  return { challenge: `${body}.${mac(body)}`, bits: HUMAN_BITS };
}

function leadingZeroBits(hash: Buffer): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) { bits += 8; continue; }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

// Challenges already solved, until they expire anyway, so one solution mints one cookie (ADR-0046). In memory:
// a restart forgets them, and the challenge secret changes on restart unless HUMAN_SECRET is set. Verify is
// rate-limited per IP, so this stays small; the size check is a backstop.
const used = new Map<string, number>();
function forgetExpired(now: number): void {
  for (const [c, exp] of used) if (exp < now) used.delete(c);
}

/** True when `challenge` is ours, fresh and not solved before, and sha256(challenge + counter) has HUMAN_BITS leading zero bits. */
export function checkSolution(challenge: string, counter: string): boolean {
  const m = /^(\d+\.[0-9a-f]{16})\.([0-9a-f]{64})$/.exec(challenge);
  if (!m || !/^\d{1,12}$/.test(counter) || !same(m[2], mac(m[1]))) return false;
  const issued = Number(m[1].split(".")[0]);
  const now = Date.now();
  if (now - issued < 0 || now - issued > CHALLENGE_MS) return false;
  if (leadingZeroBits(createHash("sha256").update(challenge + counter).digest()) < HUMAN_BITS) return false;
  if (used.size > 10_000) forgetExpired(now);
  if (used.has(m[1])) return false;
  used.set(m[1], issued + CHALLENGE_MS);
  return true;
}
setInterval(() => forgetExpired(Date.now()), 60_000).unref();

export function humanCookie(req: IncomingMessage): string {
  const exp = String(Date.now() + COOKIE_MS);
  const secure = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0] === "https" ? "; Secure" : "";
  return `${COOKIE}=${exp}.${mac(`human.${exp}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MS / 1000}${secure}`;
}

export function isHuman(req: IncomingMessage): boolean {
  const raw = String(req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";
  const [exp, sig] = raw.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return same(sig, mac(`human.${exp}`));
}
