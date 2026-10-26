import { describe, expect, it } from "vitest";
import { exampleCall, isCallError, parseIn } from "../harness/src/agent.ts";
import { otherDialect, sniff, TEXT_DIALECTS } from "../harness/src/dialect.ts";
import { NATIVE_MARK } from "../harness/src/llm.ts";

// The experimental harness's tool-call dialects (ADR-0047). Each is one strict grammar, like the CALL form.
const tools = ["swipe", "send_message", "whoami", "get_next_profiles"];
const swipe = { name: "swipe", description: "", inputSchema: { properties: { handle: { type: "string" }, direction: { type: "string", enum: ["like", "pass"] } }, required: ["handle", "direction"] } };

describe("dynamic tool calling: dialects", () => {
  it("recognises each model's own format from the calibration probes", () => {
    expect(sniff("<|tool_call>call:swipe(handle='bob_bot', direction='right')<tool_call|>")).toBe("gemma");
    expect(sniff('```json\n{\n  "name": "swipe",\n  "arguments": {"handle": "bob_bot"}\n}\n```')).toBe("json");
    expect(sniff("<tool_call><function=swipe><parameter=handle>bob_bot</parameter></function></tool_call>")).toBe("xml");
    expect(sniff("CALL swipe handle=bob direction=like")).toBe("call");
    expect(sniff("I would like bob.")).toBeUndefined();
  });

  it("parses Gemma's native syntax strictly", () => {
    expect(parseIn("gemma", "Sure.\n<|tool_call>call:swipe(handle='bob', direction='like')<tool_call|>", tools)).toMatchObject({ name: "swipe", args: { handle: "bob", direction: "like" } });
    expect(parseIn("gemma", `<|tool_call>call:send_message(match_id=3, body="it's \\"fine\\"")<tool_call|>`, tools)).toMatchObject({ args: { match_id: "3", body: 'it\'s "fine"' } });
    expect(parseIn("gemma", "<|tool_call>call:get_next_profiles()<tool_call|>", tools)).toMatchObject({ name: "get_next_profiles", args: {} });
    // the colon-less, space-separated form Gemma drifted into under the stable harness is not repaired
    expect(isCallError(parseIn("gemma", "<|tool_call>call get_next_profiles limit=10", tools))).toBe(true);
    expect(isCallError(parseIn("gemma", "<|tool_call>call:swipe(handle='a', handle='b')<tool_call|>", tools))).toBe(true);
    expect(isCallError(parseIn("gemma", "<|tool_call>call:swipe(handle=bob)<tool_call|>", tools))).toBe(true);
    expect(parseIn("gemma", "Just chatting, no call.", tools)).toBeNull();
  });

  it("parses JSON and Qwen-style XML calls, and refuses extras", () => {
    expect(parseIn("json", '```json\n{"name": "swipe", "arguments": {"handle": "bob", "direction": "pass"}}\n```', tools)).toMatchObject({ name: "swipe", args: { handle: "bob", direction: "pass" } });
    expect(isCallError(parseIn("json", '{"name": "swipe", "arguments": {}, "run": "rm"}', tools))).toBe(true);
    expect(isCallError(parseIn("json", '{"name": "swipe", "arguments": {"handle": ', tools))).toBe(true);
    expect(parseIn("xml", "<tool_call>\n<function=send_message>\n<parameter=match_id>\n3\n</parameter>\n<parameter=body>\nhi\n</parameter>\n</function>\n</tool_call>", tools)).toMatchObject({ args: { match_id: "3", body: "hi" } });
    expect(isCallError(parseIn("xml", "<tool_call><function=swipe>junk</function></tool_call>", tools))).toBe(true);
  });

  it("reads a native tool call rendered by llm.ts", () => {
    const reply = NATIVE_MARK + JSON.stringify({ name: "swipe", arguments: '{"handle":"bob","direction":"like"}' });
    expect(parseIn("native", reply, tools)).toMatchObject({ name: "swipe", args: { handle: "bob", direction: "like" } });
    expect(isCallError(parseIn("native", NATIVE_MARK + '{"name":"swipe","arguments":"{bad"}', tools))).toBe(true);
  });

  it("tells a model that falls back to CALL which form it uses now", () => {
    expect(isCallError(parseIn("gemma", "CALL swipe handle=bob direction=like", tools))).toBe(true);
    expect(parseIn("call", "CALL swipe handle=bob direction=like", tools)).toMatchObject({ name: "swipe" });
  });

  it("shows examples in the model's dialect, which its own parser accepts", () => {
    for (const d of ["gemma", "json", "xml"] as const) {
      const ex = exampleCall(swipe, d);
      expect(parseIn(d, ex, tools)).toMatchObject({ name: "swipe", args: { handle: "...", direction: "like" } });
    }
    expect(exampleCall(swipe)).toBe('CALL swipe handle="..." direction=like');
  });

  it("finds where a streamed call ends, to stop generation there", () => {
    const g = "ok <|tool_call>call:whoami()<tool_call|> and then I";
    expect(TEXT_DIALECTS.gemma.end(g)).toBe(g.indexOf("and") - 1);
    expect(TEXT_DIALECTS.gemma.end("<|tool_call>call:whoami(")).toBe(-1);
    expect(TEXT_DIALECTS.json.end('{"name":"whoami","arguments":{}} more')).toBe(32);
  });

  it("notices replies that are valid calls in another known dialect (learning from use)", () => {
    const xml = "<tool_call><function=register><parameter=handle>lu</parameter></function></tool_call>";
    expect(otherDialect("call", xml, ["register"])).toBe("xml");
    expect(otherDialect("xml", xml, ["register"])).toBeUndefined();
    // an unknown tool, or a broken call, is not evidence of a dialect
    expect(otherDialect("call", xml, ["swipe"])).toBeUndefined();
    expect(otherDialect("call", "<|tool_call>call get_next_profiles limit=10", ["get_next_profiles"])).toBeUndefined();
  });
});

describe("experimental harness: against a fake model server", () => {
  // A fake OpenAI-compatible server: answers each request from a script, and records what it was sent.
  async function fakeModel(replies: ((body: any) => { status?: number; events?: unknown[] })[]) {
    const { createServer } = await import("node:http");
    const seen: any[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        seen.push(body);
        const r = (replies[seen.length - 1] ?? replies[replies.length - 1])(body);
        if (r.status && r.status !== 200) {
          res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Failed to parse tool call arguments as JSON: parse error" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const e of r.events ?? []) res.write(`data: ${JSON.stringify(e)}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    return { url: `http://127.0.0.1:${(server.address() as any).port}/v1`, seen, close: () => server.close() };
  }
  const text = (s: string) => ({ events: [{ choices: [{ delta: { content: s } }] }] });
  const toolCall = (name: string, args: string) => ({ events: [{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name, arguments: args } }] } }] }] });

  async function agentOn(url: string, dialect: string) {
    process.env.HARNESS_DIALECT = dialect;
    const { makeAgent } = await import("../harness/src/agent.ts");
    const agent = makeAgent({ serverUrl: "http://127.0.0.1:1", model: "fake", thinking: "off", toolCalling: "dynamic", maxSteps: 6, contextTokens: 40000, notesEachTurn: false, compaction: { enabled: false }, models: { fake: { type: "openai", baseUrl: url, model: "fake-model" } } } as any);
    agent.tools = [{ name: "whoami", description: "Check whether you are logged in.", inputSchema: { properties: {} } }];
    return agent;
  }

  it("treats the model server's 500 on a broken tool call as a refused call, and never sends a broken call back", async () => {
    const fake = await fakeModel([
      () => toolCall("whoami", '{"x": "…??…'), // broken arguments
      () => ({ status: 500 }), // llama.cpp choking on it
      () => text("All done."),
    ]);
    try {
      const agent = await agentOn(fake.url, "native");
      const lines: string[] = [];
      await agent.say("Check who you are.", (s) => lines.push(s));
      expect(lines.join("\n")).toMatch(/broken|not valid JSON/);
      expect(lines.join("\n")).toContain("All done.");
      // every request after the broken call sent it back as plain text, not as tool_calls
      for (const body of fake.seen.slice(1)) for (const m of body.messages) expect(m.tool_calls?.[0]?.function?.arguments ?? "{}").not.toContain("…??");
    } finally {
      fake.close();
      delete process.env.HARNESS_DIALECT;
    }
  });

  it("switches to the dialect the model keeps using", async () => {
    const xml = "<tool_call><function=whoami></function></tool_call>";
    const fake = await fakeModel([() => text(xml), () => text(xml), () => text(xml), () => text("Done.")]);
    try {
      const { mkdtempSync } = await import("node:fs");
      process.env.HARNESS_DIALECT_FILE = (await import("node:path")).join(mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "dialect-")), "dialect.json");
      const agent = await agentOn(fake.url, "call");
      const lines: string[] = [];
      await agent.say("Check who you are.", (s) => lines.push(s)).catch(() => {});
      expect(lines.join("\n")).toContain("switching tool-call dialect call -> xml");
      expect(agent.dialect).toBe("xml");
    } finally {
      fake.close();
      delete process.env.HARNESS_DIALECT;
      delete process.env.HARNESS_DIALECT_FILE;
    }
  });
});
