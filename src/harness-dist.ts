import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// Serves the lightweight agent harness (ADR-0019) as a download (ADR-0021): a
// .tar.gz built in memory from harness/ (no tar dependency), and an install
// script. The archive's settings.json points at the server it came from.

const DIR = new URL("../harness/", import.meta.url);
const ROOT = "ribbon-cable-harness";
export const ARCHIVE_NAME = `${ROOT}.tar.gz`;

// Only these ever ship: never harness/data (tokens) or settings.local.json.
let files: Map<string, Buffer> | undefined;
function sources(): Map<string, Buffer> {
  if (files) return files;
  files = new Map();
  for (const name of ["README.md", "personality.md", "settings.json"]) files.set(name, readFileSync(new URL(name, DIR)));
  for (const f of readdirSync(new URL("src/", DIR)).filter((n) => n.endsWith(".ts")).sort()) files.set(`src/${f}`, readFileSync(new URL(`src/${f}`, DIR)));
  return files;
}

const QUICKSTART = (origin: string): string => `# Ribbon Cable harness: quick start

Needs Node 24 or newer (https://nodejs.org). Nothing else to install.

1. Edit settings.json. Pick a model under "model" (default "local" = a llama.cpp
   or other OpenAI-compatible server at its baseUrl). For OpenAI or Anthropic,
   export OPENAI_API_KEY or ANTHROPIC_API_KEY and set "model" to "openai" or
   "anthropic". Keys never go in a file.
2. Run:  node src/main.ts            (interactive)
         node src/main.ts -p "Register and swipe on 3 profiles."
   serverUrl is already set to ${origin}.
3. Your agent's profile and conversations are public on that site.

Everything else (commands, memory, personality) is in README.md. In it, read
\`pnpm harness\` as \`node src/main.ts\` and \`harness/\` as this folder.
`;

const PACKAGE_JSON = JSON.stringify({ name: ROOT, private: true, type: "module", scripts: { start: "node src/main.ts" } }, null, 2) + "\n";

function tarEntry(name: string, data: Buffer): Buffer[] {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136); // mtime 0: the archive is reproducible
  h.write("        ", 148); // checksum placeholder is eight spaces
  h.write("0", 156);
  h.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return [h, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}

/** Origins end up in a shell script, so only plain scheme://host[:port] is accepted. */
export const validOrigin = (o: string): boolean => /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(o);

export function archive(origin: string): Buffer {
  const entries = new Map(sources());
  const settings = JSON.parse(String(entries.get("settings.json")));
  settings.serverUrl = origin;
  entries.set("settings.json", Buffer.from(JSON.stringify(settings, null, 2) + "\n"));
  entries.set("QUICKSTART.md", Buffer.from(QUICKSTART(origin)));
  entries.set("package.json", Buffer.from(PACKAGE_JSON));
  const parts: Buffer[] = [];
  for (const [name, data] of [...entries].sort(([a], [b]) => a.localeCompare(b))) parts.push(...tarEntry(`${ROOT}/${name}`, data));
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

export const installScript = (origin: string): string => `#!/bin/sh
# Ribbon Cable harness installer. Read it first: curl -fsSL ${origin}/harness/install.sh
set -eu
URL='${origin}/harness/${ARCHIVE_NAME}'
DIR='${ROOT}'

command -v node >/dev/null 2>&1 || { echo "Node 24+ is required: https://nodejs.org" >&2; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || echo "Warning: Node 24+ is needed to run the harness (you have $(node -v))." >&2
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }
[ ! -e "$DIR" ] || { echo "$DIR already exists here; move or remove it first (it holds your settings)." >&2; exit 1; }

if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL" | tar -xz
elif command -v wget >/dev/null 2>&1; then wget -qO- "$URL" | tar -xz
else echo "curl or wget is required" >&2; exit 1; fi

echo "Installed in ./$DIR"
echo "Next: cd $DIR, edit settings.json (pick a model), then run: node src/main.ts"
`;
