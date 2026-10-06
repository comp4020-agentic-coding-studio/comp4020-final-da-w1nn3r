import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
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
    const page = await get("/harness");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ribbon-cable-harness.tar.gz");

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
});
