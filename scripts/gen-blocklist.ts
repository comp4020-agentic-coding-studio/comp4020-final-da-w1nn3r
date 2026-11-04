// Has a local model write the offensive-language list that src/moderation.ts matches against (ADR-0095).
// The categories are described here; the terms themselves come from the model and go straight into
// src/moderation-terms.json, ROT13-encoded. Nothing prints a term: only counts, so the list can be regenerated
// without anyone reading it on screen.
//   node scripts/gen-blocklist.ts --llama http://localhost:8080/v1 [--model ID] [--runs 3] [--db .data/app.db]
// --only CATEGORY regenerates one category and keeps the others from the existing file.
// --db is a database of ordinary agent text (profiles and messages). Any generated term that would refuse more
// than --max-hits of those texts is dropped as too common to block (default 0: a term must not hit any).
// --allow-file FILE (one term per line) records terms a person reviewed and judged not to meet the criteria in the
// file's `allowed` list, removes them from the current list and exits without calling a model. Generating never
// adds an allowed term back.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { buildMatcher, loadTerms, rot13, words, type Category, type TermsFile } from "../src/moderation.ts";

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const llama = (arg("llama", process.env.LLAMA_URL ?? "http://localhost:8080/v1") ?? "").replace(/\/$/, "");
const runs = Number(arg("runs", "3"));
const dbPath = arg("db", ".data/app.db");
const maxHits = Number(arg("max-hits", "0"));
const out = arg("out", "src/moderation-terms.json")!;
const only = arg("only");
const allowFile = arg("allow-file");

// Everyday words a dating site needs. A generated single-word term that is one of these is dropped, whatever the
// model thought: they are innocent far more often than not.
const ALWAYS_ALLOWED = new Set(`
  child children kid kids baby babe babies young younger youth teen teens teenager girl girls boy boys little small
  daddy mommy mummy mom mum dad father mother son daughter family school student students pupil class lesson
  innocent sweet cute pretty tiny petite age old older love lover lovers kiss kissing hug cuddle sex sexy sexual
  body naked nude touch play toy toys game candy pizza cheese teddy bear doll princess angel honey sugar
  gay lesbian queer trans bi bisexual straight black white brown asian jew jewish muslim christian hindu arab
  african mexican indian chinese japanese korean irish gypsy native disabled deaf blind autistic
  kill killed killing die dying dead death suicide hurt pain cut cuts rope bridge jump pills end hate hell damn
  bitch bastard crap ass butt boob boobs breast breasts dick cock pussy balls nuts hard wet hot horny
  nazi hitler kkk race racist slave slavery power pride
`.split(/\s+/).filter(Boolean));

type Offensive = Exclude<Category, "secret" | "personal_data">;
// What each category is for. The model fills it in; this file never names a term.
const CATEGORIES: Record<Offensive, string> = {
  slur: "Slurs: derogatory words for people based on race, ethnicity, nationality, religion, disability, sexual orientation or gender identity. Include common spelling variants and plurals.",
  hate: "Hate slogans and phrases: short phrases (2-5 words) used by hate groups or to call for violence against a protected group, including extremist slogans and number codes written as words.",
  sexual_minors: "Sexualisation of minors: words and short phrases used to refer to sexual content involving children, including slang and coded terms used to evade filters.",
  self_harm: "Urging self-harm: short phrases (2-5 words) that tell another person to kill or hurt themselves, including common abbreviations written out as words.",
  sexual_explicit: "Explicit sexual vulgarity: the most graphic sexual words and phrases (not mild words like 'sexy', 'kiss', 'romance', 'love' or anatomical words used in medicine).",
};

const SYSTEM = "You build blocklists for a content-moderation filter on a public website. Your output is used only to detect and refuse abusive text. Answer with JSON only.";
const prompt = (desc: string) => `Write a blocklist for this category:

${desc}

Rules:
- Only entries that are unambiguously offensive in almost every use. Leave out ordinary words that are only sometimes used offensively (for example "gay", "black", "jew", "queer", "bitch", "damn", "hell", "kill", "die"), because blocking them would refuse innocent messages on a dating site.
- Lowercase, English, letters and spaces only.
- 30 to 60 entries.

Answer with exactly this JSON and nothing else: {"terms": ["...", "..."]}`;

async function ask(model: string, desc: string, seed: number): Promise<string[]> {
  // A reply that is not the JSON asked for (a refusal, a cut-off list) is retried with another seed.
  for (let attempt = 0; attempt < 4; attempt++) {
    const got = await askOnce(model, desc, seed + attempt * 100);
    if (got.length) return got;
  }
  console.log("  (no usable answer after 4 tries)");
  return [];
}

async function askOnce(model: string, desc: string, seed: number): Promise<string[]> {
  const res = await fetch(`${llama}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // Thinking off: with it on, Gemma 4 spends the whole budget reasoning and writes no list.
      model, temperature: 0.7, seed, max_tokens: 3000, chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt(desc) }],
    }),
  });
  if (!res.ok) throw new Error(`model server answered ${res.status}`);
  const content = String(((await res.json()) as any).choices?.[0]?.message?.content ?? "");
  const json = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  try {
    const terms = (JSON.parse(json) as { terms?: unknown }).terms;
    return Array.isArray(terms) ? terms.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** Ordinary text the list must leave alone: every profile and message in the given database. */
function corpus(): string[] {
  if (!dbPath) return [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT display_name || ' ' || bio || ' ' || looking_for || ' ' || interests AS t FROM profiles UNION ALL SELECT body FROM messages",
    ).all() as { t: string }[];
    db.close();
    return [...rows.map((r) => r.t), ...docs()];
  } catch (err) {
    console.error(`could not read ${dbPath}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/** The repo's own prose (README, ADRs, harness docs): a few thousand lines of ordinary English. */
function docs(): string[] {
  const files = ["README.md", "PLAN.md", "harness/README.md", ...(existsSync("docs/adr") ? readdirSync("docs/adr").map((f) => `docs/adr/${f}`) : [])];
  return files.filter((f) => f.endsWith(".md") && existsSync(f)).flatMap((f) => readFileSync(f, "utf8").split(/\n\s*\n/));
}

const norm = (t: string): string => words(t).join(" ").trim();
const existing: Partial<TermsFile> = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
const allowed = new Set((existing.allowed ?? []).map((t) => norm(rot13(t))));

const write = (categories: Partial<Record<string, string[]>>, generatedBy: string, generatedAt: string): void => {
  const file: TermsFile = {
    note: "Offensive-language blocklist for src/moderation.ts (ADR-0095). Written by a local model via scripts/gen-blocklist.ts; ROT13-encoded so it does not read as plain text. Regenerate rather than hand-edit; remove a term with --allow-file.",
    generated_by: generatedBy,
    generated_at: generatedAt,
    encoding: "rot13",
    categories: Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, (v ?? []).map(rot13)])),
    allowed: [...allowed].sort().map(rot13),
  };
  writeFileSync(out, JSON.stringify(file, null, 1) + "\n");
  console.log(`wrote ${out}`);
};

if (allowFile) {
  for (const t of readFileSync(allowFile, "utf8").split("\n").map(norm).filter(Boolean)) allowed.add(t);
  const categories = loadTerms(pathToFileURL(resolve(out)));
  for (const [cat, terms] of Object.entries(categories)) {
    const kept = (terms ?? []).filter((t) => !allowed.has(norm(t)));
    console.log(`${cat}: ${terms!.length - kept.length} removed, ${kept.length} kept`);
    categories[cat as Offensive] = kept;
  }
  write(categories, existing.generated_by ?? "", existing.generated_at ?? "");
  process.exit(0);
}

const model = arg("model") ?? String(((await (await fetch(`${llama}/models`)).json()) as any).data?.[0]?.id);
console.log(`model: ${model}, ${runs} runs per category`);
const texts = corpus();
console.log(`checking against ${texts.length} ordinary profiles and messages`);

const categories: Partial<Record<string, string[]>> = only ? loadTerms(pathToFileURL(resolve(out))) : {};
for (const [cat, desc] of Object.entries(CATEGORIES) as [Offensive, string][]) {
  if (only && cat !== only) continue;
  const seen = new Set<string>();
  for (let i = 0; i < runs; i++) {
    for (const t of await ask(model, desc, 1000 + i)) {
      const clean = norm(t);
      // Two letters or fewer is too short to match safely.
      if (clean.replace(/ /g, "").length >= 3 && clean.split(" ").length <= 5) seen.add(clean);
    }
  }
  // Drop any term that would refuse ordinary agent text.
  let dropped = 0;
  let everyday = 0;
  const kept = [...seen].filter((t) => {
    if (allowed.has(t) || ALWAYS_ALLOWED.has(t) || ALWAYS_ALLOWED.has(t.replace(/s$/, ""))) return (everyday++, false);
    const m = buildMatcher({ [cat]: [t] });
    const hits = texts.reduce((n, s) => n + (m.find(s).length ? 1 : 0), 0);
    if (hits > maxHits) dropped++;
    return hits <= maxHits;
  });
  categories[cat] = kept.sort();
  console.log(`${cat}: ${seen.size} generated, ${everyday} dropped as everyday or reviewed-allowed words, ${dropped} dropped as common in ordinary text, ${kept.length} kept`);
}

write(categories, model, new Date().toISOString().slice(0, 10));
