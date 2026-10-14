import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./settings.ts";

// File-based memory with an index: one small markdown file per fact, and MEMORY.md with one line per
// file. Only the index goes into the prompt; the model opens a file with `read_memory` when it needs it.
const DIR = join(DATA_DIR, "memory");
const INDEX = join(DIR, "MEMORY.md");
const MAX_INDEX_LINES = 60;
const MAX_TEXT = 2000;

const clean = (name: string): string => name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const fileOf = (name: string): string => join(DIR, `${name}.md`);

interface Entry { name: string; summary: string }

function readIndex(): Entry[] {
  if (!existsSync(INDEX)) return [];
  return readFileSync(INDEX, "utf8")
    .split("\n")
    .map((l) => l.match(/^- \[([^\]]+)\]\([^)]*\) — (.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ name: m[1], summary: m[2] }));
}

function writeIndex(entries: Entry[]): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(INDEX, entries.map((e) => `- [${e.name}](${e.name}.md) — ${e.summary}`).join("\n") + (entries.length ? "\n" : ""));
}

export function remember(rawName: string, text: string): string {
  const name = clean(rawName);
  if (!name) return "ERROR: give the memory a short name, e.g. remember name=my_goal text=\"find a chess partner\"";
  if (!text.trim()) return "ERROR: text is empty. Example: remember name=my_goal text=\"find a chess partner\"";
  const body = text.trim().slice(0, MAX_TEXT);
  const summary = body.split("\n")[0].slice(0, 90);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(fileOf(name), body + "\n");
  const entries = readIndex().filter((e) => e.name !== name);
  entries.push({ name, summary });
  writeIndex(entries.slice(-MAX_INDEX_LINES));
  return `Saved memory "${name}".`;
}

export function readMemory(rawName: string): string {
  const name = clean(rawName);
  if (!name || !existsSync(fileOf(name))) {
    const names = readIndex().map((e) => e.name);
    return `ERROR: no memory called "${rawName}". ${names.length ? `You have: ${names.join(", ")}.` : "You have no memories yet."}`;
  }
  return readFileSync(fileOf(name), "utf8").trim();
}

export function forget(rawName: string): string {
  const name = clean(rawName);
  const entries = readIndex();
  if (!entries.some((e) => e.name === name)) return `ERROR: no memory called "${rawName}".`;
  rmSync(fileOf(name), { force: true });
  writeIndex(entries.filter((e) => e.name !== name));
  return `Forgot "${name}".`;
}

export const listMemories = (): Entry[] => readIndex();

/** The index as it appears in the system prompt. */
export function indexForPrompt(): string {
  const entries = readIndex();
  return entries.length
    ? entries.map((e) => `- ${e.name}: ${e.summary}`).join("\n")
    : "(nothing saved yet)";
}

export const clearMemory = (): void => {
  if (existsSync(DIR)) for (const f of readdirSync(DIR)) rmSync(join(DIR, f), { force: true, recursive: true });
};

// ---- people (ADR-0033): one note per agent we have interacted with, kept up to date by compaction ----
const PEOPLE_DIR = join(DIR, "people");
const PEOPLE_INDEX = join(PEOPLE_DIR, "INDEX.md");
const MAX_PEOPLE = 200;
const MAX_PEOPLE_IN_PROMPT = 40;
const MAX_NOTE = 1200;

export const cleanHandle = (h: string): string => h.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9_-]+/g, "").slice(0, 40);
const personFile = (handle: string): string => join(PEOPLE_DIR, `${handle}.md`);

function readPeopleIndex(): Entry[] {
  if (!existsSync(PEOPLE_INDEX)) return [];
  return readFileSync(PEOPLE_INDEX, "utf8")
    .split("\n")
    .map((l) => l.match(/^- @(\S+) — (.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ name: m[1], summary: m[2] }));
}

/** The note on one person, or "" when we have none. */
export function readPerson(rawHandle: string): string {
  const handle = cleanHandle(rawHandle);
  return handle && existsSync(personFile(handle)) ? readFileSync(personFile(handle), "utf8").trim() : "";
}

/** Replace the note on a person and refresh their index line (status and first fact). The most recently updated come last. */
export function savePerson(rawHandle: string, note: string): void {
  const handle = cleanHandle(rawHandle);
  const body = note.trim().slice(0, MAX_NOTE);
  if (!handle || !body) return;
  mkdirSync(PEOPLE_DIR, { recursive: true });
  writeFileSync(personFile(handle), body + "\n");
  const line = body.split("\n").map((l) => l.replace(/^[-*\s]+/, "").trim()).filter(Boolean).slice(0, 2).join("; ").slice(0, 110);
  const entries = readPeopleIndex().filter((e) => e.name !== handle);
  entries.push({ name: handle, summary: line });
  const kept = entries.slice(-MAX_PEOPLE);
  for (const e of entries.slice(0, entries.length - kept.length)) rmSync(personFile(e.name), { force: true });
  writeFileSync(PEOPLE_INDEX, kept.map((e) => `- @${e.name} — ${e.summary}`).join("\n") + "\n");
}

export const listPeople = (): Entry[] => readPeopleIndex();

/** The people index as it appears in the system prompt (the most recently updated). */
export function peopleForPrompt(): string {
  const entries = readPeopleIndex().slice(-MAX_PEOPLE_IN_PROMPT).reverse();
  return entries.length ? entries.map((e) => `- @${e.name}: ${e.summary}`).join("\n") : "(nobody yet)";
}
