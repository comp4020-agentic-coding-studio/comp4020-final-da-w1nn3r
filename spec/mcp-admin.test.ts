import { describe, expect, it } from "vitest";
import { call, connect, newAgent } from "./helpers.ts";

// The dev admin tools (ADR-0037) exist only when the app runs with DEV_MCP_TOKEN, so these run when this
// process has the same token (from .env locally) and are skipped in CI.
try { process.loadEnvFile(); } catch {}
const token = process.env.DEV_MCP_TOKEN ?? "";

describe.skipIf(token.length < 24)("dev admin MCP tools (ADR-0037)", () => {
  it("are listed only to the admin token", async () => {
    const admin = await connect(token);
    const names = (await admin.listTools()).tools.map((t) => t.name);
    expect(names).toContain("admin_delete_agent");
    const agent = await newAgent("noadmin");
    expect((await agent.client.listTools()).tools.map((t) => t.name).some((n) => n.startsWith("admin_"))).toBe(false);
    expect((await (await connect()).listTools()).tools.map((t) => t.name).some((n) => n.startsWith("admin_"))).toBe(false);
  });

  it("refuse a wrong token", async () => {
    await expect(connect("dev_wrong")).rejects.toThrow();
  });

  it("inspect, scrub, reset a token and delete, with an audit trail", async () => {
    const a = await newAgent("adm", { bio: "a bio worth scrubbing" });
    const admin = await connect(token);
    const list = await call(admin, "admin_list_agents", { query: a.handle });
    expect(list.data.map((r: any) => r.handle)).toContain(a.handle);

    expect((await call(admin, "admin_scrub_profile", { handle: a.handle })).data.scrubbed).toBe(a.handle);
    expect((await call(admin, "admin_get_agent", { handle: a.handle })).text).toContain("[removed by admin]");

    const reset = await call(admin, "admin_reset_token", { handle: a.handle });
    expect(reset.data.token).toMatch(/^tok_/);
    const again = await connect(reset.data.token);
    expect((await call(again, "whoami")).data.you?.handle ?? (await call(again, "whoami")).text).toContain(a.handle);

    expect((await call(admin, "admin_delete_agent", { handle: a.handle, confirm: "nope" })).isError).toBe(true);
    expect((await call(admin, "admin_delete_agent", { handle: a.handle, confirm: a.handle })).data.deleted).toBe(a.handle);
    expect((await call(admin, "admin_get_agent", { handle: a.handle })).isError).toBe(true);

    const audit = (await call(admin, "admin_audit_log", { limit: 10 })).data as { action: string; target: string; detail: string }[];
    expect(audit.find((r) => r.action === "delete_agent" && r.target === a.handle)?.detail).toContain("via mcp");
  });
});
