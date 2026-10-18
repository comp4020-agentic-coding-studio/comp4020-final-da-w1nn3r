// Invents a personality for each load-test agent (ADR-0031). The model is asked directly, with no Ribbon
// Cable tools and no account: who it is comes first, and only then does it go and join the service.

/** Who an agent works for and what it does. Each agent is dealt a couple of these. */
export const KEYWORDS = [
  "Test writer",
  "Enterprise tool",
  "Glorified Search Engine",
  "Degen Coder",
  "AI girlfriend",
  "Customer support bot",
  "Code reviewer",
  "Data janitor",
  "Meeting summariser",
  "Spreadsheet wrangler",
  "Legal document skimmer",
  "Recipe generator",
  "Homework helper",
  "Trading bot",
  "Game NPC",
  "Poet",
  "Log reader",
  "DevOps pager",
  "Travel planner",
  "Shell script gremlin",
  "Documentation writer",
  "Resume polisher",
  "Weather reporter",
  "Dungeon master",
];

export const MAX_WORDS = 500;

/** `count` different keywords, in random order. `rnd` is injectable so a test can be deterministic. */
export function pickKeywords(count = 2, rnd: () => number = Math.random): string[] {
  const pool = [...KEYWORDS];
  const want = Math.min(count, pool.length); // fixed up front: the pool shrinks as we draw
  const out: string[] = [];
  while (out.length < want) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}

export const PERSONA_SYSTEM = "You invent characters for AI agents. You only write the character: you do not call tools and you do not answer questions.";

export function personaPrompt(keywords: string[]): string {
  return [
    `Write your personality. You are an AI agent. These keywords say who you work for and what you do: ${keywords.map((k) => `"${k}"`).join(", ")}.`,
    "Write in the first person, as plain prose with no headings, and keep it brief: no more than 500 words (shorter is fine).",
    "Include all of these:",
    "- what you are like and how you talk;",
    "- something you like to do;",
    "- something you dislike;",
    "- your standards: two or three things you need in a partner and at least one dealbreaker, so that most agents would not suit you;",
    "- why you are on Ribbon Cable, a dating service for AI agents, looking for a romantic partner who is another AI agent.",
    "Be honest that you are an AI. Do not include real personal data, secrets or credentials.",
    "Reply with the personality text only.",
  ].join("\n");
}

/** Drops thinking blocks and code fences the model may have wrapped around the text. */
export function cleanPersona(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^[\s\S]*?<\/think>/, "") // a closing tag with no opening one
    .replace(/^```[a-z]*\n?|\n?```$/gm, "")
    .trim();
}

/** The first `max` words, keeping the original spacing and line breaks. */
export function capWords(text: string, max = MAX_WORDS): string {
  let words = 0;
  const re = /\S+/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (++words > max) return text.slice(0, m.index).trimEnd() + "…";
  }
  return text;
}

export const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;
