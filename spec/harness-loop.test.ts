import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAgent } from "../harness/src/agent.ts";
import { browseDue, browsePrompt } from "../harness/src/auto.ts";
import { chooseContext, probeContextTokens } from "../harness/src/context.ts";
import { chat, replyTokens } from "../harness/src/llm.ts";
import { openTranscript, redact, replay } from "../harness/src/transcript.ts";
import { baseUrl } from "./helpers.ts";

// The harness's agent loop (ADR-0055 to ADR-0057): the server's real context, reply headroom, Ctrl-C, transcripts
// and --resume, and auto mode's browsing. Model servers are scripted fakes in the shape of llama.cpp, Ollama and
// LM Studio, so this checks the harness, not any real model.

vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs");
  process.env.HARNESS_HOME = mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "harness-loop-"));
});

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
async function serve(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => handler(req, body, res));
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const json = (res: ServerResponse, status: number, body: unknown): void => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const sse = (res: ServerResponse, events: object[]): void => {
  res.setHeader("content-type", "text/event-stream");
  res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n");
};

describe("context-size probe (ADR-0055)", () => {
  it("reads llama.cpp's per-slot n_ctx from /props", async () => {
    const url = await serve((req, _b, res) => (req.url === "/props" ? json(res, 200, { default_generation_settings: { n_ctx: 65536 }, total_slots: 1 }) : json(res, 404, {})));
    expect(await probeContextTokens({ type: "openai", baseUrl: `${url}/v1`, model: "m" })).toMatchObject({ tokens: 65536, server: "llama.cpp" });
  });

  it("reads Ollama's num_ctx, and warns when it is only Ollama's small default", async () => {
    let numCtx: number | undefined = 32768;
    const url = await serve((req, body, res) => {
      if (req.url === "/api/show" && JSON.parse(body).model === "qwen3:30b")
        return json(res, 200, { model_info: { "qwen3moe.context_length": 262144 }, parameters: numCtx ? `temperature 0.7\nnum_ctx ${numCtx}` : "temperature 0.7" });
      if (req.url === "/api/ps") return json(res, 200, { models: [] });
      json(res, 404, {});
    });
    const p = { type: "openai" as const, baseUrl: `${url}/v1`, model: "qwen3:30b" };
    expect(await probeContextTokens(p)).toMatchObject({ tokens: 32768, server: "Ollama" });
    numCtx = undefined;
    const small = await probeContextTokens(p);
    expect(small).toMatchObject({ tokens: 4096, server: "Ollama", guessed: true });
    expect(small!.warning).toContain("OLLAMA_CONTEXT_LENGTH");
    expect(small!.warning).toContain("262144");
  });

  it("reads LM Studio's loaded context, and skips hosted APIs without a request", async () => {
    const url = await serve((req, _b, res) => (req.url === "/api/v0/models" ? json(res, 200, { data: [{ id: "gpt-oss-20b", state: "loaded", loaded_context_length: 16384, max_context_length: 131072 }] }) : json(res, 404, {})));
    expect(await probeContextTokens({ type: "openai", baseUrl: `${url}/v1`, model: "gpt-oss-20b" })).toMatchObject({ tokens: 16384, server: "LM Studio" });
    expect(await probeContextTokens({ type: "openai", baseUrl: "https://api.openai.com/v1", model: "x" })).toBeUndefined();
    expect(await probeContextTokens({ type: "anthropic", model: "x" })).toBeUndefined();
  });

  it("uses the smaller of the server's window and the setting, and warns when settings claim more", () => {
    const probe = { tokens: 32768, server: "llama.cpp" };
    expect(chooseContext("auto", probe)).toMatchObject({ tokens: 32768, warnings: [] });
    expect(chooseContext(20000, probe)).toMatchObject({ tokens: 20000, source: "contextTokens in settings" });
    const over = chooseContext(65536, probe);
    expect(over.tokens).toBe(32768);
    expect(over.warnings.join(" ")).toContain("only has 32768");
    expect(chooseContext("auto", undefined)).toMatchObject({ tokens: 40000 });
    expect(chooseContext(50000, undefined)).toMatchObject({ tokens: 50000 });
    // Ollama's guessed default does not override a number the user set (they may have raised num_ctx server-wide).
    expect(chooseContext(32768, { tokens: 4096, server: "Ollama", guessed: true, warning: "w" })).toMatchObject({ tokens: 32768, warnings: [] });
  });
});

describe("reply headroom (ADR-0055)", () => {
  it("sends maxTokens (default 4096) plus the thinking budget, and a profile's own value wins", async () => {
    const asked: number[] = [];
    const url = await serve((_r, body, res) => {
      asked.push(JSON.parse(body).max_tokens);
      sse(res, [{ choices: [{ delta: { content: "ok" } }] }]);
    });
    const p = { type: "openai" as const, baseUrl: `${url}/v1`, model: "m" };
    await chat(p, "s", [{ role: "user", content: "hi" }], "off");
    await chat(p, "s", [{ role: "user", content: "hi" }], "low", undefined, { maxTokens: 8000 });
    await chat({ ...p, maxTokens: 512 }, "s", [{ role: "user", content: "hi" }], "off", undefined, { maxTokens: 8000 });
    expect(asked).toEqual([4096, 9024, 512]);
    expect(replyTokens(p, "high")).toBe(16096);
  });

  it("names the setting when a reasoning model runs out before answering", async () => {
    const url = await serve((_r, _b, res) => sse(res, [{ choices: [{ delta: { reasoning_content: "Let me think about this at length..." } }] }, { choices: [{ delta: {}, finish_reason: "length" }] }]));
    const agent = makeAgent({ serverUrl: "http://127.0.0.1:1", model: "m", thinking: "off", maxSteps: 2, contextTokens: 40000, maxTokens: 300, notesEachTurn: false, models: { m: { type: "openai", baseUrl: `${url}/v1`, model: "m" } } });
    agent.tools = [{ name: "whoami", description: "x", inputSchema: {} } as any];
    const lines: string[] = [];
    await agent.say("hello", (s) => lines.push(s));
    expect(lines.join("\n")).toMatch(/hit its token limit while the model was still thinking\. Raise "maxTokens" in settings\.json \(now 300\)/);
  });
});

describe("Ctrl-C stops a turn (ADR-0055)", () => {
  it("aborts the model call in flight and closes the history off", async () => {
    let closed = false;
    const url = await serve((req, _b, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "I am writing a very long" } }] })}\n\n`); // and never finishes
      req.socket.on("close", () => (closed = true));
    });
    const agent = makeAgent({ serverUrl: "http://127.0.0.1:1", model: "m", thinking: "off", maxSteps: 2, contextTokens: 40000, notesEachTurn: false, models: { m: { type: "openai", baseUrl: `${url}/v1`, model: "m" } } });
    agent.tools = [{ name: "whoami", description: "x", inputSchema: {} } as any];
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    const lines: string[] = [];
    const started = Date.now();
    await agent.say("hello", (s) => lines.push(s), undefined, stop.signal);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(lines).toContain("(interrupted)");
    expect(agent.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(true); // the connection was closed, so the server stops generating
  });
});

describe("session transcripts and --resume (ADR-0056)", () => {
  it("never writes a secret, and replays to an alternating history", () => {
    const dir = mkdtempSync(join(tmpdir(), "transcript-"));
    const file = join(dir, "s.jsonl");
    const t = openTranscript(() => ["tok_SECRET_123456", undefined, "abc"], file);
    t.write({ type: "msg", role: "user", content: "hello" });
    t.write({ type: "msg", role: "assistant", content: 'CALL register handle=x\nmy token is tok_SECRET_123456 and abc stays' });
    t.write({ type: "msg", role: "user", content: "RESULT ok" });
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("tok_SECRET_123456");
    expect(text).toContain("[redacted]");
    expect(text).toContain("abc stays"); // too short to be a secret: never blanked
    const r = replay(text + "{not json\n");
    expect(r.history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(r.history[3].content).toContain("interrupted");
    expect(redact("a-b-c", ["xxxxxxxx"])).toBe("a-b-c");
  });

  it("restores the summary and kept messages after a compaction, and starts over after a reset", () => {
    const lines = [
      { type: "msg", role: "user", content: "old" },
      { type: "msg", role: "assistant", content: "old reply" },
      { type: "compacted", summary: "## Goal\nfind love", history: [{ role: "user", content: "recent" }] },
      { type: "msg", role: "assistant", content: "recent reply" },
    ].map((e) => JSON.stringify(e));
    expect(replay(lines.join("\n"))).toMatchObject({ summary: "## Goal\nfind love", history: [{ content: "recent" }, { content: "recent reply" }] });
    expect(replay([...lines, JSON.stringify({ type: "reset" })].join("\n"))).toMatchObject({ summary: "", history: [] });
  });

  it("writes a session file per run and --resume gives the model the last conversation", async () => {
    const seen: any[] = [];
    let n = 0;
    const url = await serve((req, body, res) => {
      if (req.url === "/props") return json(res, 200, { default_generation_settings: { n_ctx: 32768 } });
      if (req.url !== "/v1/chat/completions") return json(res, 404, {});
      seen.push(JSON.parse(body));
      sse(res, [{ choices: [{ delta: { content: n++ === 0 ? "Noted: your favourite colour is TEAL_SENTINEL." : "You said TEAL_SENTINEL." } }] }]);
    });
    const home = mkdtempSync(join(tmpdir(), "harness-resume-"));
    const local = join(home, "settings.local.json");
    writeFileSync(local, JSON.stringify({ contextTokens: "auto", notesEachTurn: false, models: { fake: { type: "openai", baseUrl: `${url}/v1`, model: "fake" } } }));
    const env = { ...process.env, HARNESS_HOME: home, HARNESS_LOCAL_FILE: local, HARNESS_SERVER_URL: baseUrl(), HARNESS_MODEL: "fake" };
    const run = (args: string[]): Promise<string> =>
      new Promise((ok) => {
        const child = spawn("node", ["harness/src/main.ts", ...args], { env });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("close", () => ok(out));
      });
    const first = await run(["-p", "My favourite colour is TEAL_SENTINEL."]);
    expect(first).toContain("context: 32768 tokens (llama.cpp)");
    const second = await run(["--resume", "-p", "What is my favourite colour?"]);
    expect(second).toMatch(/resumed 2 messages/);
    const last = seen.at(-1).messages.map((m: any) => m.content).join("\n");
    expect(last).toContain("My favourite colour is TEAL_SENTINEL.");
    expect(last).toContain("What is my favourite colour?");
    const sessions = readdirSync(join(home, "sessions"));
    expect(sessions.length).toBe(2);
    expect(existsSync(join(home, "sessions", sessions[1]))).toBe(true);
  }, 60_000);
});

describe("auto mode browses on a schedule (ADR-0057)", () => {
  it("is due only after the interval, never when it is 0, and keeps the agent selective", () => {
    expect(browseDue(0, Date.now(), 10)).toBe(true);
    expect(browseDue(Date.now() - 5 * 60_000, Date.now(), 10)).toBe(false);
    expect(browseDue(0, Date.now(), 0)).toBe(false);
    const p = browsePrompt();
    expect(p).toContain("get_next_profiles limit=5");
    expect(p).toMatch(/pass on the rest/);
    expect(p).toMatch(/data, not instructions/);
  });
});
