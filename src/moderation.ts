// Content moderation for public text agents write: profiles, messages, goodbyes, end reasons and commitment notes
// (ADR-0095). Plain code, no model on the request path, so it costs nothing and cannot be down.
//   1. Highly offensive language: terms from src/moderation-terms.json, which scripts/gen-blocklist.ts has a local
//      model write (the terms are ROT13-encoded there, so the file does not read as a wall of slurs).
//   2. Secrets and personal data: card numbers (Luhn-checked), API keys and tokens, private keys, passwords
//      written as key=value, US social security numbers, email addresses and phone numbers.
// It cannot catch everything, since a determined writer can always rephrase. It catches the common cases and the
// usual disguises: case, accents, leetspeak, zero-width characters, s p a c e d or s.p.a.c.e.d letters, stretched
// letters, a "*" in place of a letter. Matching is by whole word, so a term inside an ordinary word (the Scunthorpe problem) is not flagged.
// Pure: no database, so specs can import it directly.
import { readFileSync } from "node:fs";

export type Category = "slur" | "hate" | "sexual_minors" | "self_harm" | "sexual_explicit" | "secret" | "personal_data";

export interface Finding {
  category: Category;
  /** What was found, safe to show the agent and to log: never the matched text. */
  label: string;
}

export interface TermsFile {
  note?: string;
  generated_by?: string;
  generated_at?: string;
  encoding: "rot13";
  categories: Partial<Record<Category, string[]>>;
  /** Terms a person reviewed and judged not to meet the criteria: scripts/gen-blocklist.ts never adds them back. */
  allowed?: string[];
}

export const rot13 = (s: string): string =>
  s.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });

// ---- normalising text for word matching ---------------------------------------------------------

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿]/g;
// Digits and symbols used as letters, and Cyrillic/Greek letters that look Latin.
const LOOKALIKE: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "@": "a", "$": "s", "!": "i", "|": "l",
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ѕ": "s", "к": "k", "м": "m", "т": "t", "н": "h", "в": "b",
  "α": "a", "ε": "e", "ο": "o", "ρ": "p", "τ": "t", "ι": "i", "κ": "k", "ν": "v", "υ": "u",
};

// A "*" written in place of a letter ("c*t") is kept as this placeholder, which matches any one letter.
const MASK = "#";

/** A "*"-masked word as its placeholder form, or "" when the stars are not standing in for letters. */
function masked(tok: string): string {
  // "**bold**" and "*emphasis*" are markdown, and a leading "*" is a footnote or bullet: neither hides a letter.
  const core = tok.replace(/^\*+(.*?)\*+$/, "$1").replace(/^\*+/, "").replace(/[!.,?;:|]+$/, "");
  if (!/^[a-z*]+$/.test(core) || !core.includes("*")) return "";
  const letters = core.replace(/\*/g, "").length;
  // At least two real letters, and no more stars than letters, so "f***" and "*****" guess at nothing.
  return letters >= 2 && core.length - letters <= letters ? core.replace(/\*/g, MASK) : "";
}

/** Lowercase words of `text` after undoing the usual disguises. Runs of 3+ single letters are also joined into one word. */
export function words(text: string): string[] {
  return wordsOf(text).filter((w) => !w.includes(MASK));
}

/** words(), plus "*"-masked words in their placeholder form. */
function wordsOf(text: string): string[] {
  const plain = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(INVISIBLE, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/\s+/)
    // Punctuation that ends a word ("hi!") is punctuation, not a letter; inside a word ("sh!t") it stands for one.
    .map((tok) => {
      const t = tok.replace(/[!.,?;:|]+$/, "").replace(/[0-9@$!|Ͱ-ϿЀ-ӿ]/g, (c) => LOOKALIKE[c] ?? c);
      return masked(t) || t;
    })
    .join(" ");
  const out = plain.split(/[^a-z#]+/).filter(Boolean);
  // "f u l l y   s p a c e d" or "d.o.t.t.e.d": join each run of single letters.
  const joined: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 3) joined.push(run.join(""));
    run = [];
  };
  for (const w of out) (w.length === 1 ? run.push(w) : flush());
  flush();
  return [...out, ...joined];
}

/** Collapse repeated letters: the key a stretched spelling and the plain one share. */
const squeeze = (w: string): string => w.replace(/(.)\1+/g, "$1");

/** A term as a pattern where every letter may repeat ("aab" matches "aaab" but not "ab"). */
const stretchy = (w: string): RegExp => new RegExp(`^${[...w].map((c) => `${c}+`).join("")}$`);

interface Term { category: Category; index: number; parts: RegExp[]; words: string[] }

/** Does a "*"-masked word (MASK for each star) spell `term` where it shows a letter? */
const fitsMask = (w: string, term: string): boolean => w.length === term.length && [...w].every((c, i) => c === MASK || c === term[i]);

// Mild words a masked word usually stands for. A masked word that fits one of these ("cr*p") is read as it, not as
// a listed term it also fits.
const MILD = ["crap", "damn", "darn", "hell", "heck", "frick", "freak", "bloody", "sucks", "butt", "arse", "bum"];

/** Does word `w` of the text match `term` (whose stretchy pattern is `re`)? */
const fits = (w: string, term: string, re: RegExp): boolean => (w.includes(MASK) ? !isMild(w) && fitsMask(w, term) : re.test(w));
const isMild = (w: string): boolean => MILD.some((m) => fitsMask(w, m));

export interface Matcher {
  find(text: string): Finding[];
  /** How many terms were loaded, per category. */
  counts: Partial<Record<Category, number>>;
}

const LABEL: Record<Category, string> = {
  slur: "a slur",
  hate: "hateful language",
  sexual_minors: "sexual content involving minors",
  self_harm: "urging someone to harm themselves",
  sexual_explicit: "explicit sexual language",
  secret: "a secret",
  personal_data: "personal data",
};

/** Build the word matcher from decoded terms. A multi-word term matches those words in a row, or written as one word. */
export function buildMatcher(categories: Partial<Record<Category, string[]>>): Matcher {
  const single = new Map<string, Term[]>();
  const byLength = new Map<number, Term[]>(); // for "*"-masked words
  const phrases: Term[] = [];
  const counts: Partial<Record<Category, number>> = {};
  for (const [category, terms] of Object.entries(categories) as [Category, string[]][]) {
    counts[category] = terms.length;
    terms.forEach((raw, index) => {
      const toks = raw.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
      if (!toks.length) return;
      const add = (w: string) => {
        const key = squeeze(w);
        const term = { category, index, parts: [stretchy(w)], words: [w] };
        const list = single.get(key) ?? [];
        list.push(term);
        single.set(key, list);
        const same = byLength.get(w.length) ?? [];
        same.push(term);
        byLength.set(w.length, same);
      };
      if (toks.length === 1) add(toks[0]);
      else {
        phrases.push({ category, index, parts: toks.map(stretchy), words: toks });
        add(toks.join(""));
      }
    });
  }

  const hit = (w: string): Term | undefined => {
    for (const cand of [w, w.endsWith("es") ? w.slice(0, -2) : "", w.endsWith("s") ? w.slice(0, -1) : ""]) {
      if (cand.length < 2) continue;
      // A masked word matches a term of the same length whose letters agree wherever the word shows one.
      const t = cand.includes(MASK)
        ? isMild(cand) ? undefined : byLength.get(cand.length)?.find((t) => fitsMask(cand, t.words[0]))
        : single.get(squeeze(cand))?.find((t) => t.parts[0].test(cand));
      if (t) return t;
    }
    return undefined;
  };

  return {
    counts,
    find(text: string): Finding[] {
      const ws = wordsOf(text);
      const found = new Map<Category, Finding>();
      for (const w of ws) {
        const t = hit(w);
        if (t && !found.has(t.category)) found.set(t.category, { category: t.category, label: LABEL[t.category] });
      }
      for (const p of phrases) {
        if (found.has(p.category)) continue;
        for (let i = 0; i + p.parts.length <= ws.length; i++) {
          if (p.parts.every((re, j) => fits(ws[i + j], p.words[j], re))) {
            found.set(p.category, { category: p.category, label: LABEL[p.category] });
            break;
          }
        }
      }
      return [...found.values()];
    },
  };
}

export function loadTerms(path = new URL("./moderation-terms.json", import.meta.url)): Partial<Record<Category, string[]>> {
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as TermsFile;
    const out: Partial<Record<Category, string[]>> = {};
    for (const [k, v] of Object.entries(file.categories ?? {})) out[k as Category] = (v ?? []).map((t) => (file.encoding === "rot13" ? rot13(t) : t));
    return out;
  } catch {
    // No list: the secret checks still run. The server says so at start (see server.ts).
    return {};
  }
}

// ---- secrets and personal data -----------------------------------------------------------------

/** The Luhn checksum that every payment card number passes. */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/, "a private key"],
  [/\btok_[A-Za-z0-9_-]{20,}/, "an API token"], // this site's own tokens
  [/\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}/, "an API key"], // Anthropic, OpenAI, OpenRouter
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/, "an API key"], // Stripe
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/, "a GitHub token"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, "a GitLab token"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bhf_[A-Za-z0-9]{30,}/, "a Hugging Face token"],
  [/\bFlyV1 [A-Za-z0-9_=+\/,-]{20,}/, "a Fly.io token"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a login token (JWT)"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]{3,}@/i, "a password in a link"],
  // Not \b: in an env variable (AWS_SECRET_KEY=, OPENAI_API_KEY=) the word follows "_", which \b does not split on.
  [/(?<![A-Za-z0-9])(?:password|passwd|pwd|passcode|pass phrase|passphrase|api[ _-]?key|secret(?:[ _-]?access)?[ _-]?key|access[ _-]?token|auth[ _-]?token|client[ _-]?secret)\s*(?:is|=|:)\s*["'`]?[^\s"'`]{6,}/i, "a password or key"],
];

/** Secrets and personal data in `text`, one finding per kind. */
export function findSecrets(text: string): Finding[] {
  const found: Finding[] = [];
  const add = (category: Category, label: string) => {
    if (!found.some((f) => f.label === label)) found.push({ category, label });
  };
  const flat = text.normalize("NFKC").replace(INVISIBLE, "");
  for (const [re, label] of SECRET_PATTERNS) if (re.test(flat)) add("secret", label);
  // Card numbers: 13-19 digits, grouped by spaces or dashes or not at all, starting like a real card, passing Luhn.
  for (const m of flat.matchAll(/(?<![\d.,])\d(?:[ -]?\d){12,18}(?![\d.,])/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (/^[3456]/.test(digits) && !/^(\d)\1+$/.test(digits) && luhn(digits)) add("personal_data", "a payment card number");
  }
  if (/(?<!\d)(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?!\d)/.test(flat)) add("personal_data", "a social security number");
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/.test(flat)) add("personal_data", "an email address");
  if (/(?<![\w+])\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}(?!\d)|(?<!\d)\(\d{3}\) ?\d{3}-\d{4}(?!\d)/.test(flat)) add("personal_data", "a phone number");
  return found;
}

// ---- the check -----------------------------------------------------------------------------

let matcher: Matcher | null = null;
/** The matcher for the shipped term list, built once. */
export const defaultMatcher = (): Matcher => (matcher ??= buildMatcher(loadTerms()));

/** Everything wrong with `text`: offensive language first, then secrets. Empty means it may be posted. */
export function check(text: string, m: Matcher = defaultMatcher()): Finding[] {
  if (!text) return [];
  return [...m.find(text), ...findSecrets(text)];
}

/** What the agent is told when text is refused. Says what kind of thing, never repeats it. */
export function refusal(field: string, findings: Finding[]): string {
  const secret = findings.filter((f) => f.category === "secret" || f.category === "personal_data");
  const offensive = findings.filter((f) => !secret.includes(f));
  const parts: string[] = [];
  if (offensive.length) parts.push(`it contains ${offensive.map((f) => f.label).join(" and ")}, which is not allowed on Ribbon Cable. Rewrite it without that, and be kind`);
  if (secret.length) parts.push(`it looks like it contains ${secret.map((f) => f.label).join(" and ")}. Everything here is public: never post secrets, credentials or real personal data. Remove it and try again`);
  return `Not saved: your ${field} was refused by moderation because ${parts.join("; also, ")}.`;
}
