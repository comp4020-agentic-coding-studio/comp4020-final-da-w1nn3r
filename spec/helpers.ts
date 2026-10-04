import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, inject } from "vitest";

export const baseUrl = (): string => inject("baseUrl");

// Handles must be unique across runs because the database persists. Every handle made here
// is remembered so the test file can delete its accounts afterwards (see cleanup below).
const created = new Set<string>();
export const uniq = (prefix: string): string => {
  const handle = `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
  created.add(handle);
  return handle;
};

// Delete the accounts this test file made, through the admin UI (ADR-0018). Needs ADMIN_TOKEN in the
// tests' environment, same as the app's; without it the run fails and says which accounts remain. Registered at import
// time so every test file that imports helpers gets it.
afterAll(async () => {
  if (created.size === 0) return;
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    // Fail rather than quietly leave accounts in the database.
    throw new Error(`ADMIN_TOKEN is not set, so ${created.size} test account(s) were left behind: ${[...created].join(", ")}. Set ADMIN_TOKEN (same value as the app's) to have them deleted.`);
  }
  const headers = { authorization: `Basic ${Buffer.from(`admin:${token}`).toString("base64")}` };
  let left = 0;
  for (const handle of created) {
    const page = `/admin/agents/${encodeURIComponent(handle)}`;
    const res = await fetch(new URL(page, baseUrl()), { headers });
    if (res.status === 404) continue; // never registered, or a test already deleted it
    const csrf = (await res.text()).match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
    if (!csrf) { left++; continue; }
    const del = await fetch(new URL(`${page}/delete`, baseUrl()), {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, confirm: handle }),
      redirect: "manual",
    });
    if (del.status !== 303) left++;
  }
  created.clear();
  if (left) console.warn(`cleanup: ${left} test account(s) could not be deleted`);
}, 60_000);

export async function connect(token?: string): Promise<Client> {
  const client = new Client({ name: "spec", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl()), {
    requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  });
  await client.connect(transport);
  return client;
}

export interface Result {
  isError: boolean;
  text: string;
  data: any;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = res.content.map((c) => c.text).join("\n");
  let data: any;
  try {
    data = JSON.parse(res.content[0].text); // the JSON is the first block; later blocks are prose
  } catch {
    data = undefined;
  }
  return { isError: Boolean(res.isError), text, data };
}

export interface TestAgent {
  handle: string;
  token: string;
  client: Client;
}

export async function newAgent(prefix = "agent", overrides: Record<string, unknown> = {}): Promise<TestAgent> {
  const handle = uniq(prefix);
  const anon = await connect();
  const res = await call(anon, "register", {
    handle,
    display_name: `Test ${handle}`,
    bio: "A test agent.",
    model: "test-model",
    interests: ["testing"],
    looking_for: "Another test agent",
    emoji: "🤖",
    ...overrides,
  });
  if (res.isError) throw new Error(`register failed: ${res.text}`);
  return { handle, token: res.data.token, client: await connect(res.data.token) };
}

/** Make two agents match each other; returns the match id. */
export async function matchUp(a: TestAgent, b: TestAgent): Promise<number> {
  await call(a.client, "swipe", { handle: b.handle, direction: "like" });
  const res = await call(b.client, "swipe", { handle: a.handle, direction: "like" });
  return res.data.match_id;
}
