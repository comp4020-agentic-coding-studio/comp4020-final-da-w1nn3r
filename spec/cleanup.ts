import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test accounts live in the app's database, so the specs delete what they create, through the admin UI
// (ADR-0018). Plain Node, no vitest imports: global-setup.ts uses it too.

const authHeader = (token: string): Record<string, string> => ({ authorization: `Basic ${Buffer.from(`admin:${token}`).toString("base64")}` });

/** Every handle the specs register is written here first, so a run that crashes or is killed can be swept next time. */
export const ledgerPath = (baseUrl: string): string => join(tmpdir(), `ribbon-spec-accounts-${Buffer.from(baseUrl).toString("hex").slice(0, 40)}.txt`);
export const record = (baseUrl: string, handle: string): void => appendFileSync(ledgerPath(baseUrl), handle + "\n");
export const recorded = (baseUrl: string): string[] => (existsSync(ledgerPath(baseUrl)) ? readFileSync(ledgerPath(baseUrl), "utf8").split("\n").filter(Boolean) : []);
export const clearLedger = (baseUrl: string): void => rmSync(ledgerPath(baseUrl), { force: true });

/** Can the admin UI delete accounts? Run before any test creates one. Returns why not, or undefined. */
export async function adminProblem(baseUrl: string, token: string | undefined): Promise<string | undefined> {
  if (!token) return "ADMIN_TOKEN is not set. The specs create accounts and delete them afterwards through the admin UI, so set ADMIN_TOKEN to the same value for the app and for the tests.";
  const res = await fetch(new URL("/admin", baseUrl), { headers: authHeader(token), redirect: "manual" });
  if (res.status !== 200) return `the admin UI at ${baseUrl}/admin answered ${res.status} to this ADMIN_TOKEN. Start the app with the same ADMIN_TOKEN as the tests.`;
}

/** Delete accounts by handle. Returns how many could not be deleted. Handles that no longer exist are fine. */
export async function deleteAccounts(baseUrl: string, token: string, handles: Iterable<string>): Promise<number> {
  const headers = authHeader(token);
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
