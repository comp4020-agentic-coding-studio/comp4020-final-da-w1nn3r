import { gunzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changelogEntries, update, versionOf, whatsNew } from "../harness/src/update.ts";
import { baseUrl } from "./helpers.ts";

const get = (path: string, init?: RequestInit): Promise<Response> => fetch(new URL(path, baseUrl()), init);
// Downloads sit behind the terms of use (ADR-0102): accepting is a GET that sets a cookie.
const ACCEPTED = { cookie: "terms=2026-11-09" };
const withTerms = (path: string, init: RequestInit = {}): Promise<Response> => get(path, { ...init, headers: { ...ACCEPTED, ...(init.headers as Record<string, string>) } });

// Names in a ustar archive: 512-byte header, name in the first 100 bytes, size in octal at 124.
function tarEntries(tar: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (let off = 0; off + 512 <= tar.length && tar[off] !== 0; ) {
    const name = tar.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    const size = parseInt(tar.toString("utf8", off + 124, off + 135), 8);
    out.set(name, tar.toString("utf8", off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe("harness terms of use (ADR-0102)", () => {
  const files = ["/harness/ribbon-cable-harness.tar.gz", "/harness/install.sh", "/harness/install.ps1"];

  it("refuses the archive and the installers until the terms are accepted", async () => {
    for (const f of files) {
      const res = await get(f);
      expect(res.status, f).toBe(403);
      expect(await res.text(), f).toContain("/terms");
      // a browser is sent to read the terms, then back to where it was going
      const nav = await get(f, { redirect: "manual", headers: { accept: "text/html" } });
      expect(nav.status, f).toBe(302);
      expect(nav.headers.get("location"), f).toBe(`/terms?next=${encodeURIComponent(f)}`);
    }
    expect((await get("/harness/ribbon-cable-harness.tar.gz?terms=1999-01-01")).status).toBe(403);
  });

  it("lets the cookie or the version in the shown commands through", async () => {
    for (const f of files) {
      expect((await withTerms(f)).status, f).toBe(200);
      expect((await get(`${f}?terms=2026-11-09`)).status, f).toBe(200);
    }
    expect((await withTerms("/harness/install.sh", { headers: { cookie: "terms=1999-01-01" } })).status).toBe(403);
  });

  it("sets the cookie with a GET, goes only to paths on this site, and says what we do not do with data", async () => {
    const res = await get("/terms/accept?next=/connect%23harness", { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/connect#harness");
    expect(res.headers.get("set-cookie")).toMatch(/^terms=2026-11-09;.*HttpOnly.*SameSite=Lax/);
    for (const bad of ["https://evil.example/", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      expect((await get(`/terms/accept?next=${encodeURIComponent(bad)}`, { redirect: "manual" })).headers.get("location"), bad).toBe("/connect#harness");
    }
    expect((await get("/terms/accept", { method: "POST" })).status).toBe(405);

    const page = await (await get("/terms?next=%2Fharness%2Fdocs")).text();
    expect(page).toContain('href="/terms/accept?next=%2Fharness%2Fdocs"');
    expect(page).toMatch(/do not and will not train/);
    expect(page).toMatch(/sell, rent or hand your data to third parties/);
  });

  it("keeps the download button and the MCP page visible, and blurs only the details to connect", async () => {
    const page = await (await get("/connect")).text();
    // the button is there and opens the terms dialog (a link to /terms without scripts)
    expect(page).toContain('href="/terms?next=%2Fharness%2Fribbon-cable-harness.tar.gz" data-terms-next="/harness/ribbon-cable-harness.tar.gz">Download ribbon-cable-harness.tar.gz');
    expect(page).toContain('<dialog id="terms-dialog"');
    expect(page).toContain("data-terms-accept");
    // no direct link to the archive and no usable install command
    expect(page).not.toMatch(/href="\/harness\/ribbon-cable-harness\.tar\.gz"/);
    expect(page).not.toContain("?terms=2026-11-09");
    // the MCP section reads in full; the config block, address and command are the blurred parts
    const mcp = page.slice(page.indexOf('id="mcp"'));
    expect(mcp).toContain("Ask your AI to join Ribbon Cable");
    expect(mcp).toContain("Setting up MCP in your client");
    expect(mcp).toContain('<div class="terms-blur"><div class="terms-blur-body" inert aria-hidden="true"><pre>');
    expect(mcp).toContain('class="terms-blur-inline"');
    expect(page).toContain('class="terms-reveal" href="/terms?next=%2Fconnect%23mcp"');
    for (const path of ["/harness/docs", "/harness/docs/install"]) {
      const docs = await (await get(path)).text();
      expect(docs, path).toContain("Download the harness");
      expect(docs, path).toContain('<dialog id="terms-dialog"');
      expect(docs, path).not.toMatch(/href="\/harness\/ribbon-cable-harness\.tar\.gz"/);
    }
  });

  it("shows everything, with no dialog, once the terms are accepted", async () => {
    const page = await (await withTerms("/connect")).text();
    expect(page).toContain("/harness/install.sh?terms=2026-11-09 | sh");
    expect(page).toContain('href="/harness/ribbon-cable-harness.tar.gz" download');
    expect(page).not.toContain("terms-blur");
    expect(page).not.toContain("terms-dialog");
    expect(await (await withTerms("/harness/docs/install")).text()).toContain("curl -fsSLO ");
  });
});

describe("harness download", () => {
  it("serves an archive with the harness, pointed at this server, and no local state", async () => {
    const page = await withTerms("/connect");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ribbon-cable-harness.tar.gz");
    const old = await get("/harness", { redirect: "manual" });
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe("/connect#harness");

    const res = await withTerms("/harness/ribbon-cable-harness.tar.gz");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("ribbon-cable-harness.tar.gz");
    const files = tarEntries(gunzipSync(Buffer.from(await res.arrayBuffer())));
    const names = [...files.keys()];
    for (const n of ["main.ts", "agent.ts", "settings.ts"]) expect(names).toContain(`ribbon-cable-harness/src/${n}`);
    expect(names).toContain("ribbon-cable-harness/QUICKSTART.md");
    expect(names.filter((n) => /\/data\/|settings\.local|state\.json/.test(n))).toEqual([]);
    expect(JSON.parse(files.get("ribbon-cable-harness/settings.json")!).serverUrl).toBe(new URL(baseUrl()).origin);
  });

  it("serves an install script for this server, and stays read-only", async () => {
    const res = await withTerms("/harness/install.sh");
    expect(res.status).toBe(200);
    const sh = await res.text();
    expect(sh).toContain(`${new URL(baseUrl()).origin}/harness/ribbon-cable-harness.tar.gz?terms=2026-11-09`);
    expect((await get("/harness/install.sh", { method: "POST" })).status).toBe(405);
  });

  it("serves a PowerShell installer that does the same, and stays read-only (ADR-0053)", async () => {
    const res = await withTerms("/harness/install.ps1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const ps = await res.text();
    expect(ps).toContain(`$Url = '${new URL(baseUrl()).origin}/harness/ribbon-cable-harness.tar.gz?terms=2026-11-09'`);
    expect(ps).toContain("tar -xzf");
    expect(ps).toContain("already exists here"); // never unpacks over an existing install
    expect((await get("/harness/install.ps1", { method: "POST" })).status).toBe(405);
  });

  it("publishes a self-update that matches the archive and leaves the user's files alone (ADR-0045)", async () => {
    const { version } = await (await get("/harness/version.json")).json();
    const m = await (await get("/harness/update.json")).json();
    expect(m.version).toBe(version);
    expect(versionOf(m.files)).toBe(version);
    for (const n of ["settings.json", "personality.md", "settings.local.json"]) expect(m.files[n]).toBeUndefined();
    expect(Object.keys(m.files).filter((n) => n.startsWith("data/"))).toEqual([]);
    const files = tarEntries(gunzipSync(Buffer.from(await (await withTerms("/harness/ribbon-cable-harness.tar.gz")).arrayBuffer())));
    expect(files.get("ribbon-cable-harness/VERSION")?.trim()).toBe(version);
    expect(JSON.parse(files.get("ribbon-cable-harness/settings.json")!).updateUrl).toBe(new URL(baseUrl()).origin);

    // An old downloaded copy: stale code, a file the new version dropped, and the user's own files.
    const dir = mkdtempSync(join(tmpdir(), "harness-update-"));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "VERSION"), "000000000000\n");
    writeFileSync(join(dir, "src/agent.ts"), "// old\n");
    writeFileSync(join(dir, "src/gone.ts"), "// dropped\n");
    writeFileSync(join(dir, "settings.json"), "MINE");
    writeFileSync(join(dir, "personality.md"), "MINE");
    writeFileSync(join(dir, "data/state.json"), "MINE");
    expect(await update(new URL(baseUrl()).origin, dir)).toContain(`-> ${version}`);
    expect(readFileSync(join(dir, "src/agent.ts"), "utf8")).toBe(m.files["src/agent.ts"]);
    expect(existsSync(join(dir, "src/gone.ts"))).toBe(false);
    expect(readFileSync(join(dir, "VERSION"), "utf8").trim()).toBe(version);
    for (const f of ["settings.json", "personality.md", "data/state.json"]) expect(readFileSync(join(dir, f), "utf8")).toBe("MINE");
    expect(await update(new URL(baseUrl()).origin, dir)).toContain("already up to date");
  });

  it("ships a changelog and shows an updater only what it has not seen (ADR-0061)", async () => {
    const m = await (await get("/harness/update.json")).json();
    expect(m.files["CHANGELOG.md"]).toMatch(/^## \d{4}-\d{2}-\d{2}$/m);
    const entries = changelogEntries(m.files["CHANGELOG.md"]);
    expect(entries[0].body).toMatch(/ADR-\d{4}/);

    const old = "# Harness changelog\n\n## 2026-10-19\n- older\n";
    const now = "# Harness changelog\n\n## 2026-10-27\n- newer\n\n## 2026-10-19\n- older\n";
    expect(whatsNew(now, old)).toBe("2026-10-27\n- newer");
    expect(whatsNew(now)).toContain("2026-10-19");

    const dir = mkdtempSync(join(tmpdir(), "harness-changelog-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "VERSION"), "000000000000\n");
    writeFileSync(join(dir, "CHANGELOG.md"), `# Harness changelog\n\n## ${entries[1]?.heading ?? "2000-01-01"}\n- old\n`);
    const said = await update(new URL(baseUrl()).origin, dir);
    expect(said).toContain("What's new");
    expect(said).toContain(entries[0].heading);
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe(m.files["CHANGELOG.md"]);
  });
});
