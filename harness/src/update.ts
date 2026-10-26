import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HARNESS_DIR } from "./settings.ts";

// Self-update (ADR-0045). The server publishes /harness/version.json and /harness/update.json (every
// code file plus a version hash). Only a downloaded copy has a VERSION file; a git checkout updates with git.
// settings.json, personality.md, settings.local.json and data/ are yours and are never touched.

export const DEFAULT_UPDATE_URL = "https://comp4020-final-da-w1nn3r.fly.dev";
const VERSION_FILE = join(HARNESS_DIR, "VERSION");
const KEEP = new Set(["settings.json", "personality.md", "settings.local.json", "VERSION"]);
const SAFE_NAME = /^(src\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** The `## ` headings of a changelog, each with its entry text. */
export function changelogEntries(text: string): { heading: string; body: string }[] {
  return text.split(/^## /m).slice(1).map((e) => ({ heading: e.split("\n")[0].trim(), body: e.slice(e.indexOf("\n") + 1).trim() }));
}

/** The entries of `now` that `before` (the changelog you had, if any) lacks; with none before, the newest three. */
export function whatsNew(now: string, before?: string): string {
  const seen = new Set(before ? changelogEntries(before).map((e) => e.heading) : []);
  const fresh = changelogEntries(now).filter((e) => !seen.has(e.heading));
  return (before ? fresh : fresh.slice(0, 3)).map((e) => `${e.heading}\n${e.body}`).join("\n\n");
}

export const localVersion = (): string | undefined => (existsSync(VERSION_FILE) ? readFileSync(VERSION_FILE, "utf8").trim() : undefined);

/** The same recipe as the server's updateManifest(), so a download can be checked before it is written. */
export function versionOf(files: Record<string, string>): string {
  const h = createHash("sha256");
  for (const name of Object.keys(files).sort()) h.update(`${name}\0${files[name]}\0`);
  return h.digest("hex").slice(0, 12);
}

async function getJson(url: string, ms: number): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

const base = (updateUrl: string | undefined): string => {
  const u = (updateUrl || DEFAULT_UPDATE_URL).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(u)) throw new Error(`updateUrl must be a plain http(s)://host, not ${u}`);
  return u;
};

/** The newer version on the server, or undefined when up to date or not a downloaded copy. Never throws. */
export async function checkForUpdate(updateUrl?: string, ms = 3000): Promise<string | undefined> {
  const mine = localVersion();
  if (!mine) return undefined;
  try {
    const { version } = await getJson(`${base(updateUrl)}/harness/version.json`, ms);
    return typeof version === "string" && version !== mine ? version : undefined;
  } catch {
    return undefined; // offline or the server is down: say nothing, try again next start
  }
}

/** Downloads and installs the latest code. Returns a line to show the user. */
export async function update(updateUrl?: string, dir = HARNESS_DIR): Promise<string> {
  const mine = existsSync(join(dir, "VERSION")) ? readFileSync(join(dir, "VERSION"), "utf8").trim() : undefined;
  if (!mine) return "this copy was not downloaded from the website (no VERSION file); update it with git pull instead";
  const m = await getJson(`${base(updateUrl)}/harness/update.json`, 30_000);
  const files = m?.files as Record<string, string> | undefined;
  if (typeof m?.version !== "string" || !files || typeof files !== "object") throw new Error("the server sent an unreadable update");
  if (m.version === mine) return `already up to date (${mine})`;
  for (const [name, text] of Object.entries(files)) {
    if (!SAFE_NAME.test(name) || KEEP.has(name) || typeof text !== "string") throw new Error(`the update contains an unexpected file: ${name}`);
  }
  if (versionOf(files) !== m.version) throw new Error("the update did not match its version; nothing was changed");

  const oldLog = existsSync(join(dir, "CHANGELOG.md")) ? readFileSync(join(dir, "CHANGELOG.md"), "utf8") : undefined;
  // Stage everything first, then swap it in, so a failed write never leaves half an update.
  const stage = join(dir, ".update");
  rmSync(stage, { recursive: true, force: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(stage, name)), { recursive: true });
    writeFileSync(join(stage, name), text);
  }
  for (const name of Object.keys(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    renameSync(join(stage, name), join(dir, name));
  }
  rmSync(stage, { recursive: true, force: true });
  // Code files the new version no longer has.
  for (const f of readdirSync(join(dir, "src"))) if (f.endsWith(".ts") && !(`src/${f}` in files)) rmSync(join(dir, "src", f));
  writeFileSync(join(dir, "VERSION"), m.version + "\n");
  const news = typeof files["CHANGELOG.md"] === "string" ? whatsNew(files["CHANGELOG.md"], oldLog) : "";
  return `updated ${mine} -> ${m.version}. Restart the harness to use it.${news ? `\n\nWhat's new:\n\n${news}` : ""}`;
}

// `node src/update.ts` works even when the rest of the harness will not start.
if (import.meta.main) {
  const { loadSettings } = await import("./settings.ts");
  let url: string | undefined;
  try { url = loadSettings().updateUrl; } catch { /* broken settings: use the default */ }
  console.log(await update(url).catch((err) => `update failed: ${(err as Error).message}`));
}
