import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test accounts live in the app's database, so the specs delete what they create, through the admin UI
// (ADR-0018). Plain Node, no vitest imports: global-setup.ts uses it too.

// The admin login (ADR-0030): a fixed username and password, overridable with ADMIN_USER / ADMIN_PASSWORD, and
// ADMIN_TOKEN (what CI sets) still works as the password. Must match what the app under test was started with.
export const adminUser = (): string => process.env.ADMIN_USER || "admin";
export const adminPassword = (): string => process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN || "ribbon-cable";

export const authHeader = (password: string = adminPassword()): Record<string, string> => ({ authorization: `Basic ${Buffer.from(`${adminUser()}:${password}`).toString("base64")}` });

/** Every handle the specs register is written here first, so a run that crashes or is killed can be swept next time. */
export const ledgerPath = (baseUrl: string): string => join(tmpdir(), `ribbon-spec-accounts-${Buffer.from(baseUrl).toString("hex").slice(0, 40)}.txt`);
export const record = (baseUrl: string, handle: string): void => appendFileSync(ledgerPath(baseUrl), handle + "\n");
export const recorded = (baseUrl: string): string[] => (existsSync(ledgerPath(baseUrl)) ? readFileSync(ledgerPath(baseUrl), "utf8").split("\n").filter(Boolean) : []);
export const clearLedger = (baseUrl: string): void => rmSync(ledgerPath(baseUrl), { force: true });

/** Can the admin UI delete accounts? Run before any test creates one. Returns why not, or undefined. */
export async function adminProblem(baseUrl: string, password: string = adminPassword()): Promise<string | undefined> {
  const res = await fetch(new URL("/admin", baseUrl), { headers: authHeader(password), redirect: "manual" });
  if (res.status !== 200) return `the admin UI at ${baseUrl}/admin answered ${res.status} to the admin login (${adminUser()} / ${password === "ribbon-cable" ? "the default password" : "ADMIN_PASSWORD or ADMIN_TOKEN"}). The specs create accounts and delete them afterwards through /admin, so the app must be started with the same login as the tests.`;
}

/** Delete accounts by handle. Returns how many could not be deleted. Handles that no longer exist are fine. */
export async function deleteAccounts(baseUrl: string, password: string, handles: Iterable<string>): Promise<number> {
  const headers = authHeader(password);
  let left = 0;
  for (const handle of new Set(handles)) {
    const page = `/admin/agents/${encodeURIComponent(handle)}`;
    const res = await fetch(new URL(page, baseUrl), { headers });
    if (res.status === 404) continue; // never registered, or already deleted
    const csrf = (await res.text()).match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
    if (!csrf) { left++; continue; }
    const del = await fetch(new URL(`${page}/delete`, baseUrl), {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, confirm: handle }),
      redirect: "manual",
    });
    if (del.status !== 303) left++;
  }
  return left;
}
