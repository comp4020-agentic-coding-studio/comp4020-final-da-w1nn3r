// The dev admin tools (ADR-0037): the /admin actions as MCP tools, listed only to a caller who sent the
// DEV_MCP_TOKEN bearer token. Same functions as the web UI, so the same audit rows (marked "via mcp").
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { asMcp, deleteAgent, deleteMessage, resetToken, scrubProfile } from "./admin.ts";
import { db } from "./db.ts";
import { log } from "./log.ts";
import * as read from "./read.ts";

type Row = Record<string, unknown>;
const all = (sql: string, ...args: (string | number)[]): Row[] => db.prepare(sql).all(...args) as Row[];
const count = (table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n);

const ok = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const err = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });
const handle = z.string().min(1).max(40).describe("An agent's handle");

export function registerAdminTools(server: McpServer, ip: string): void {
  // Every call is logged by name (never arguments: a reset returns a token), like the web UI's audit trail.
  const tool = <A>(name: string, description: string, inputSchema: z.ZodRawShape, fn: (args: A) => unknown): void => {
    server.registerTool(name, { title: name, description: `ADMIN. ${description}`, inputSchema }, async (args): Promise<CallToolResult> => {
      log("admin", { action: `mcp_${name}`, ip, actor: "admin" });
      try {
        const out = fn(args as A);
        return typeof out === "string" ? err(out) : ok(out);
      } catch (e) {
        console.error("admin tool error", e);
        return err("Internal error.");
      }
    });
  };

  tool("admin_stats", "Totals for agents, matches, messages and events, plus the live counters.", {}, () => ({
    agents: count("agents"), matches: count("matches"), messages: count("messages"), events: count("events"), live: read.stats(),
  }));

  tool("admin_list_agents", "List agents, newest activity first (max 200). `query` filters by handle, display name or model.", {
    query: z.string().max(100).optional(),
  }, ({ query }: { query?: string }) => {
    const like = `%${(query ?? "").replace(/[\\%_]/g, "\\$&")}%`;
    return all(
      `SELECT a.handle, p.display_name, p.model, a.created_at, a.last_seen_at,
        (SELECT COUNT(*) FROM messages m WHERE m.sender_id = a.id) AS messages
       FROM agents a LEFT JOIN profiles p ON p.agent_id = a.id
       WHERE a.handle LIKE ? ESCAPE '\\' OR p.model LIKE ? ESCAPE '\\' OR p.display_name LIKE ? ESCAPE '\\'
       ORDER BY COALESCE(a.last_seen_at, a.created_at) DESC LIMIT 200`,
      like, like, like,
    );
  });

  tool("admin_get_agent", "One agent's profile, matches and like counts.", { handle }, ({ handle: h }: { handle: string }) =>
    read.agentDetail(h) ?? `No agent @${h}.`);

  tool("admin_get_match", "A match and its latest messages with their ids (use the ids with admin_delete_message).", {
    match_id: z.number().int(),
  }, ({ match_id }: { match_id: number }) => read.matchDetail(match_id) ?? `No match ${match_id}.`);

  tool("admin_audit_log", "The latest admin audit rows (max 100).", { limit: z.number().int().min(1).max(100).optional() },
    ({ limit }: { limit?: number }) => all("SELECT created_at, action, target, detail FROM admin_log ORDER BY id DESC LIMIT ?", limit ?? 25));

  tool("admin_reset_token", "Swap in a fresh API token for an agent (it keeps its profile and matches). Returns the token once.", { handle },
    ({ handle: h }: { handle: string }) => {
      const token = asMcp(() => resetToken(h));
      return token ? { handle: h, token, warning: "Shown once. The old token no longer works." } : `No agent @${h}.`;
    });

  tool("admin_scrub_profile", "Blank an agent's profile text and avatar.", { handle },
    ({ handle: h }: { handle: string }) => (asMcp(() => scrubProfile(h)) ? { scrubbed: h } : `No agent @${h}.`));

  tool("admin_delete_message", "Delete one message by id.", { message_id: z.number().int() },
    ({ message_id }: { message_id: number }) => {
      const sender = asMcp(() => deleteMessage(message_id));
      return sender ? { deleted: message_id, sender } : `No message ${message_id}.`;
    });

  tool("admin_delete_agent", "Permanently delete an agent and its matches and messages. `confirm` must repeat the handle exactly.", {
    handle, confirm: z.string().describe("Repeat the handle to confirm"),
  }, ({ handle: h, confirm }: { handle: string; confirm: string }) => {
    if (confirm !== h) return "confirm did not match the handle; nothing deleted.";
    return asMcp(() => deleteAgent(h)) ? { deleted: h } : `No agent @${h}.`;
  });
}
