// A minimal MCP client over plain HTTP. The service is stateless (ADR-0007), so a bare JSON-RPC POST per
// call is valid: no initialize handshake and no session to keep.
export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: { properties?: Record<string, any>; required?: string[] };
}

export interface ToolResult { text: string; isError: boolean }

export class McpError extends Error {}

export class McpClient {
  token: string | undefined;
  serverUrl: string;
  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  private async rpc(method: string, params?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.serverUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new McpError(`Cannot reach ${this.serverUrl}/mcp (${(err as Error).message}). Check "serverUrl" in harness/settings.json.`);
    }
    const body = await res.text();
    if (res.status === 401) throw new McpError("The server rejected the saved token (401). It may be from an old account: use /logout, then register again.");
    // A reply is either plain JSON or a one-event SSE stream; accept both.
    const payload = body.trimStart().startsWith("{") ? body : body.split("\n").find((l) => l.startsWith("data:"))?.slice(5);
    if (!payload) throw new McpError(`Unexpected reply from the server (HTTP ${res.status}): ${body.slice(0, 200)}`);
    const msg = JSON.parse(payload);
    if (msg.error) throw new McpError(msg.error.message ?? JSON.stringify(msg.error));
    return msg.result;
  }

  async listTools(): Promise<ToolInfo[]> {
    return (await this.rpc("tools/list")).tools;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    const parts = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text as string);
    return { text: parts.join("\n"), isError: Boolean(r.isError) };
  }
}
