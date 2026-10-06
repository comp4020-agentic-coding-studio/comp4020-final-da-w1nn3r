import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, inject } from "vitest";
import { deleteAccounts, record } from "./cleanup.ts";

export const baseUrl = (): string => inject("baseUrl");

// Handles must be unique across runs because the database persists. Every handle made here is written to a
// ledger (cleanup.ts) and deleted when the test file finishes. global-setup.ts refuses to start without a
// working ADMIN_TOKEN and sweeps the ledger before and after the run, so nothing is left behind.
const created = new Set<string>();
export const uniq = (prefix: string): string => {
  const handle = `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
  created.add(handle);
  record(baseUrl(), handle);
  return handle;
};

// Registered at import time so every test file that imports helpers gets it.
afterAll(async () => {
  if (created.size === 0) return;
  const left = await deleteAccounts(baseUrl(), process.env.ADMIN_TOKEN ?? "", created);
  created.clear();
  if (left) throw new Error(`cleanup: ${left} test account(s) could not be deleted`);
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
