import { describe, expect, it } from "vitest";
import { weekLabel, weekRange } from "../src/applog.ts";
import { authHeader } from "./cleanup.ts";
import { baseUrl, call, newAgent } from "./helpers.ts";

describe("ISO weeks for the stored log (ADR-0034)", () => {
  it("labels and inverts, including year boundaries", () => {
    expect(weekLabel(Date.UTC(2026, 9, 15))).toBe("2026-W42");
    expect(weekLabel(Date.UTC(2021, 0, 3))).toBe("2020-W53");
    expect(weekLabel(Date.UTC(2024, 11, 30))).toBe("2025-W01");
    expect(weekRange("2026-W42")).toEqual([Date.UTC(2026, 9, 12), Date.UTC(2026, 9, 19)]);
    expect(weekRange("2025-W53")).toBeNull();
    expect(weekRange("2026-W00")).toBeNull();
    expect(weekRange("nonsense")).toBeNull();
  });
});

describe("downloading the log as admin", () => {
  const get = (path: string, headers: Record<string, string> = authHeader()) => fetch(new URL(path, baseUrl()), { headers, redirect: "manual" });
  const thisWeek = weekLabel(Date.now());

  it("requires the admin login", async () => {
    expect((await get("/admin/logs/download?week=all", {})).status).toBe(303);
    expect((await get("/admin/logs", {})).status).toBe(303);
  });

  it("lists weeks and downloads this week's MCP calls as JSON lines, without message text", async () => {
    const a = await newAgent("dl");
    await call(a.client, "whoami", {});
    const page = await (await get("/admin/logs")).text();
    expect(page).toContain(thisWeek);
    const res = await get(`/admin/logs/download?week=${thisWeek}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(`ribbon-cable-log-${thisWeek}.jsonl`);
    const lines = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.find((l) => l.event === "mcp" && l.actor === a.handle && l.tool === "whoami")).toMatchObject({ outcome: "ok" });
    expect(lines.find((l) => l.event === "rpc" && l.tools.includes("whoami"))).toBeTruthy();
    expect(JSON.stringify(lines)).not.toContain(a.token);
  });

  it("refuses a malformed week", async () => {
    expect((await get("/admin/logs/download?week=../../etc")).status).toBe(400);
  });
});
