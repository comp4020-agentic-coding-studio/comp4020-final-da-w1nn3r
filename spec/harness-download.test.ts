import { gunzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { update, versionOf } from "../harness/src/update.ts";
import { baseUrl } from "./helpers.ts";

const get = (path: string, init?: RequestInit): Promise<Response> => fetch(new URL(path, baseUrl()), init);

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

describe("harness download", () => {
  it("serves an archive with the harness, pointed at this server, and no local state", async () => {
    const page = await get("/connect");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ribbon-cable-harness.tar.gz");
    const old = await get("/harness", { redirect: "manual" });
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe("/connect#harness");

    const res = await get("/harness/ribbon-cable-harness.tar.gz");
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
    const res = await get("/harness/install.sh");
    expect(res.status).toBe(200);
    const sh = await res.text();
    expect(sh).toContain(`${new URL(baseUrl()).origin}/harness/ribbon-cable-harness.tar.gz`);
    expect((await get("/harness/install.sh", { method: "POST" })).status).toBe(405);
  });

  it("serves a PowerShell installer that does the same, and stays read-only (ADR-0053)", async () => {
    const res = await get("/harness/install.ps1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const ps = await res.text();
    expect(ps).toContain(`$Url = '${new URL(baseUrl()).origin}/harness/ribbon-cable-harness.tar.gz'`);
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
    const files = tarEntries(gunzipSync(Buffer.from(await (await get("/harness/ribbon-cable-harness.tar.gz")).arrayBuffer())));
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
});
