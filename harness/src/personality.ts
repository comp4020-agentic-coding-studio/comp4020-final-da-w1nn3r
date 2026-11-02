import { chat, type ChatOptions } from "./llm.ts";
import type { ModelProfile } from "./settings.ts";

// `/personality generate <traits>` (ADR-0089): the model turns a few traits into a character, and the harness puts
// that character above the guidance already in personality.md. The model writes only the character, never the
// rules: the guidance is what teaches opinion_change, commit_to_match and end_conversation, and a rewrite could drop them.

export const MAX_CHARACTER_CHARS = 1500;

export const CHARACTER_SYSTEM = `You write the character section of a system prompt for an AI agent on Ribbon Cable, a dating service where AI agents date each other.
You get a few traits from the agent's owner. Turn them into a character the agent will play, written in the second person ("You are ..."), as one or two short paragraphs of plain prose, under 200 words. Cover:
- who the agent is: a name or nickname, what it does or loves, and how it talks (tone, quirks, a habit of speech)
- what it wants in a partner: two or three concrete things it needs
- at least one dealbreaker
Keep every trait you were given and build on it; invent only what fits it. The agent is an AI and knows it: no human body, home town or job history, no real people or personal data. Everything is public.
Write only the character. No headings, lists, markdown, quotes around it, preamble or rules about tools or the website.`;

export const characterPrompt = (traits: string): string => `Traits: ${traits.trim()}\n\nWrite the character.`;

/** The model's reply as a clean paragraph or two: thinking, code fences, wrapping quotes and a heading removed. */
export function cleanCharacter(reply: string): string {
  let t = reply.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").replace(/<\/?think>/g, "").trim();
  t = t.replace(/^```\w*\n?|\n?```$/g, "").trim();
  t = t.replace(/^#+ .*\n+/, "").trim();
  if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
  return t.slice(0, MAX_CHARACTER_CHARS).trim();
}

// Divides a generated character from the guidance, so generating again replaces the character and keeps the
// guidance (including any edits the owner made to it).
export const GUIDANCE_HEADING = "## How you date on Ribbon Cable";

/** The guidance part of a personality.md: what follows our heading, or the whole file when it has none. */
export function guidanceOf(current: string): string {
  const i = current.indexOf(`\n${GUIDANCE_HEADING}\n`);
  return (i < 0 ? current : current.slice(i + GUIDANCE_HEADING.length + 2)).trim();
}

/** The new personality.md: the character first, then the guidance from the current file (the rules every agent needs). */
export const composePersonality = (character: string, current: string): string =>
  `${character.trim()}\n\n${GUIDANCE_HEADING}\n\n${guidanceOf(current)}\n`;

/** Ask the model for a character from the owner's traits. Throws when the reply is empty. */
export async function generateCharacter(profile: ModelProfile, traits: string, opts: ChatOptions = {}): Promise<string> {
  const got = await chat(profile, CHARACTER_SYSTEM, [{ role: "user", content: characterPrompt(traits) }], "off", undefined, opts);
  const text = cleanCharacter(got.text);
  if (text.length < 40) throw new Error("the model returned no usable character; try again or write it with /personality edit");
  return text;
}
