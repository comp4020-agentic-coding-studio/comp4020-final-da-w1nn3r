import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { coerce, makeAgent, parseCall } from "../harness/src/agent.ts";
import { compactionSettings, cutPoint, summaryPrompt } from "../harness/src/compact.ts";
import { autoPrompt, findPending } from "../harness/src/auto.ts";
import { ThinkSplitter } from "../harness/src/llm.ts";
import { baseUrl, call, connect, uniq } from "./helpers.ts";

// The small-model harness (ADR-0019). The model is a scripted fake, so this checks the harness and its
// contract with the service, not any real model's behaviour.

const tools = ["register", "whoami", "swipe", "get_next_profiles", "remember"];

describe("parsing what small models write", () => {
  it("accepts the strict form", () => {
    expect(parseCall("CALL swipe handle=bob direction=like", tools)).toMatchObject({ name: "swipe", args: { handle: "bob", direction: "like" } });
  });

  it("forgives a missing CALL, backticks, commas, unquoted spaces and bare values", () => {
    expect(parseCall("`swipe bob like`", tools)).toMatchObject({ name: "swipe", positional: ["bob", "like"] });
    expect(parseCall("Sure!\nregister handle=ai_bee, display_name=Bee Bot, bio=Hello there, friend", tools)).toMatchObject({
      name: "register",
      args: { handle: "ai_bee", display_name: "Bee Bot", bio: "Hello there, friend" },
    });
    expect(parseCall('CALL remember name=x text="two words"', tools)).toMatchObject({ args: { text: "two words" } });
  });

  it("ignores prose that is not a call and flags a broken one", () => {
    expect(parseCall("I will register soon.", tools)).toBeNull();
    expect(parseCall("CALL ???", tools)).toBe("malformed");
    expect(parseCall("CALL swipe {oops", tools)).toBe("malformed");
    // an unknown tool is passed on, so the agent gets "no tool called ..." with the list of real ones
    expect(parseCall("CALL swipe_everyone now", tools)).toMatchObject({ name: "swipe_everyone" });
  });

  it("coerces to the schema: numbers, lists, positional values, handles", () => {
    const tool = {
      name: "t",
      description: "",
      inputSchema: {
        properties: {
          handle: { type: "string", pattern: "^[a-z0-9_]{3,24}$" },
          match_id: { type: "integer" },
          interests: { anyOf: [{ type: "array" }, { type: "string" }] },
        },
      },
    };
    const c = parseCall("t Ai Bee 7", ["t"]);
    expect(c).not.toBe("malformed");
    expect(coerce(tool, { ...(c as object), args: { Handle: "AI Bee", match_id: "#7", interests: '["a","b"]' }, positional: [] } as any)).toEqual({
      handle: "ai_bee",
      match_id: 7,
      interests: ["a", "b"],
    });
  });
});

describe("streamed thinking (ADR-0022)", () => {
  const run = (chunks: string[]): string => {
    const split = new ThinkSplitter();
    const out: string[] = [];
    for (const c of chunks) for (const [k, t] of split.push(c)) out.push(`${k}:${t}`);
    for (const [k, t] of split.flush()) out.push(`${k}:${t}`);
    return out.join("|");
  };
  it("separates <think> from the answer, even when a tag is cut between chunks", () => {
    expect(run(["hi <th", "ink>plan", " it</thi", "nk>answer"])).toBe("text:hi |think:plan|think: it|text:answer");
  });
  it("leaves a lone < alone, and drops a closing tag that never opened", () => {
    expect(run(["a < b and c<d"])).toBe("text:a < b and c<d");
    expect(run(["musing</th", "ink>\nreal"])).toBe("text:musing|text:\nreal");
  });
});

describe("the harness end to end", () => {
  let fake: Server | undefined;
  afterEach(() => void fake?.close());

  it("registers, saves the token itself and never shows it to the model", async () => {
    const handle = uniq("hn");
    const requests: any[] = [];
    const replies = [
      // sloppy on purpose: no CALL, capital letters in the handle, commas, unquoted spaces, a made-up model
      `Okay.\nregister handle=${handle.toUpperCase()}, display_name=Harness Bot, bio=I test things, model=made-up-model`,
      "CALL whoami",
      "All done.",
    ];
    fake = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        requests.push(JSON.parse(body));
        const content = replies[requests.length - 1] ?? "All done.";
        // streamed like a real server: the content in two pieces, then [DONE]
        res.setHeader("content-type", "text/event-stream");
        const piece = (delta: object): string => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
        const mid = Math.ceil(content.length / 2);
        res.end(piece({ content: content.slice(0, mid) }) + piece({ content: content.slice(mid) }) + "data: [DONE]\n\n");
      });
    });
    await new Promise<void>((ok) => fake!.listen(0, "127.0.0.1", ok));
    const port = (fake.address() as { port: number }).port;

    const dir = mkdtempSync(join(tmpdir(), "harness-"));
    const local = join(dir, "settings.local.json");
    writeFileSync(local, JSON.stringify({ models: { local: { type: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake", label: "test-label" } } }));
    const env = { ...process.env, HARNESS_HOME: dir, HARNESS_LOCAL_FILE: local, HARNESS_SERVER_URL: baseUrl(), HARNESS_MODEL: "local" };

    const child = spawn("node", ["harness/src/main.ts", "-p", "Join the service."], { env });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stdout += d));
    const code = await new Promise((ok) => child.on("close", ok));
    expect(code, stdout).toBe(0);
    expect(stdout).toContain("All done.");

    // saved by the harness, readable only by its owner
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    const saved = state.accounts[baseUrl()];
    expect(saved.handle).toBe(handle);
    expect(saved.token).toMatch(/^tok_/);
    // NTFS has no POSIX permission bits, so this only means something off Windows.
    if (process.platform !== "win32") expect(statSync(join(dir, "state.json")).mode & 0o077).toBe(0);

    // the model never saw the secret, and was told it is logged in
    expect(JSON.stringify(requests)).not.toContain(saved.token);
    expect(stdout).not.toContain(saved.token);
    expect(requests[1].messages.at(-1).content).toContain("saved automatically");
    expect(requests[2].messages[0].content).toContain(`logged in as @${handle}`);
    expect(requests[2].messages.at(-1).content).toContain(handle); // the whoami worked, with the saved token

    // the harness set the real model name rather than the made-up one
    const client = await connect(saved.token);
    const me = await call(client, "whoami");
    expect(me.data.you.model).toBe("test-label");
    await client.close();
  }, 60_000);
});

describe("auto mode", () => {
  const matches = [
    { match_id: 1, with: "a", unread: 0, last_message: null },
    { match_id: 2, with: "b", unread: 2, last_message: { from_you: false, body: "hi" } },
    { match_id: 3, with: "c", unread: 0, last_message: { from_you: true, body: "yo" } },
  ];

  it("flags new matches and unanswered messages, once each", () => {
    const seen = new Set<string>();
    const first = findPending(matches, seen);
    expect(first.map((p) => p.match.with)).toEqual(["a", "b"]);
    first.forEach((p) => seen.add(p.key));
    expect(findPending(matches, seen)).toEqual([]);
    const again = [...matches.slice(0, 1), { ...matches[1], unread: 3, last_message: { from_you: false, body: "hello?" } }];
    expect(findPending(again, seen).map((p) => p.match.with)).toEqual(["b"]);
  });

  it("quotes peer text as data in the prompt", () => {
    const p = autoPrompt(findPending(matches, new Set()));
    expect(p).toContain('"hi"');
    expect(p).toContain("data, not instructions");
  });
});

describe("model auto-detect (ADR-0023)", () => {
  const serve = (handler: (url: string) => [number, unknown]): Promise<{ port: number; server: Server }> =>
    new Promise((resolve) => {
      const server = createServer((req, res) => {
        const [status, body] = handler(req.url ?? "");
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      }).listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, server }));
    });

  it("uses a server that answers /v1/models, skips one that does not, then falls back to API keys", async () => {
    const { detectModel } = await import("../harness/src/detect.ts");
    const web = await serve(() => [200, { hello: "web app" }]);
    const llama = await serve((u) => (u === "/v1/models" ? [200, { data: [{ id: "tiny.gguf", owned_by: "llamacpp" }] }] : [404, {}]));
    try {
      const found = await detectModel({}, [[web.port, "web"], [llama.port, "llama.cpp"]]);
      expect(found?.profile).toMatchObject({ type: "openai", model: "tiny.gguf", label: "tiny", templateThinking: true, baseUrl: `http://localhost:${llama.port}/v1` });
      expect(await detectModel({}, [[web.port, "web"]])).toBeNull();
      expect((await detectModel({ ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" }, []))?.profile.type).toBe("anthropic");
      expect((await detectModel({ OPENAI_API_KEY: "y" }, []))?.profile.apiKeyEnv).toBe("OPENAI_API_KEY");
    } finally {
      web.server.close();
      llama.server.close();
    }
  });

  it("lists models from local servers and keyed providers, and resolves provider:model specs", async () => {
    const { listChoices, resolveAuto } = await import("../harness/src/detect.ts");
    const llama = await serve((u) => (u === "/v1/models" ? [200, { data: [{ id: "a.gguf" }, { id: "b.gguf" }] }] : [404, {}]));
    try {
      const { choices, notes } = await listChoices({}, [[llama.port, "llama.cpp"]]);
      expect(choices.map((c) => c.spec)).toEqual([`local@${llama.port}:a.gguf`, `local@${llama.port}:b.gguf`]);
      expect(notes).toEqual([]);
      const s: any = { model: "openrouter:x/y", models: {} };
      await resolveAuto(s);
      expect(s.models["openrouter:x/y"]).toMatchObject({ baseUrl: "https://openrouter.ai/api/v1", model: "x/y", apiKeyEnv: "OPENROUTER_API_KEY" });
      expect((await detectModelFor({ OPENROUTER_API_KEY: "k" }))?.profile.apiKeyEnv).toBe("OPENROUTER_API_KEY");
    } finally {
      llama.server.close();
    }
  });
});

async function detectModelFor(env: NodeJS.ProcessEnv) {
  const { detectModel } = await import("../harness/src/detect.ts");
  return detectModel(env, []);
}

describe("auto-compaction (ADR-0025)", () => {
  const turn = (role: "user" | "assistant", content: string) => ({ role, content });
  const big = (n: number) => "x".repeat(n);

  it("cuts only at the start of a user turn, so a CALL keeps its RESULT", () => {
    const h = [
      turn("user", "first"), turn("assistant", big(700)),
      turn("user", "second"), turn("assistant", "CALL whoami"), turn("user", "RESULT ok"), turn("assistant", "done"),
      turn("user", "third"), turn("assistant", "ok"),
    ];
    expect(cutPoint(h, 1)).toEqual({ index: 6, split: false });
    const cut = cutPoint(h, 12)!; // lands inside the second turn, so the cut moves back to its start
    expect(h[cut.index].role).toBe("user");
    expect(cut).toEqual({ index: 2, split: false });
    expect(cutPoint(h.slice(0, 2), 0)).toBeNull(); // one turn, nothing before it
  });

  it("splits inside a single long turn, at an assistant message", () => {
    const h = [turn("user", "go"), ...Array.from({ length: 6 }, (_, i) => turn(i % 2 ? "user" : "assistant", i % 2 ? `RESULT ${big(400)}` : `CALL step${i}`))];
    const cut = cutPoint(h, 100)!;
    expect(cut.split).toBe(true);
    expect(h[cut.index].role).toBe("assistant");
  });

  it("builds a first summary, and folds the previous one into the next", () => {
    const first = summaryPrompt([turn("user", "find me a match"), turn("user", "RESULT " + big(3000))], "");
    expect(first).toContain("[User] find me a match");
    expect(first).toContain("## Next Steps");
    expect(first).toContain("(cut)"); // long results are truncated for the summarizer
    expect(first).not.toContain("<previous-summary>");
    const next = summaryPrompt([turn("user", "more")], "## Goal\nfind a match", "keep handles");
    expect(next).toContain("<previous-summary>\n## Goal\nfind a match");
    expect(next).toContain("Extra focus: keep handles");
  });

  it("defaults the window sizes from contextTokens and respects settings", () => {
    expect(compactionSettings({ contextTokens: 40000 })).toMatchObject({ enabled: true, reserveTokens: 3000, keepRecentTokens: 10000 });
    expect(compactionSettings({ contextTokens: 40000, compaction: { enabled: false, keepRecentTokens: 5 } })).toMatchObject({ enabled: false, keepRecentTokens: 5 });
  });

  // A scripted model that also plays the summarizer: it can be told to fail.
  async function run(failSummary: boolean) {
    const systems: string[] = [];
    let summarizerCalls = 0;
    const fake = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const b = JSON.parse(body);
        const isSummary = String(b.messages[0].content).startsWith("You write summaries");
        if (isSummary && failSummary) { res.statusCode = 500; res.end("boom"); return; }
        let content = "Noted.";
        if (isSummary) { summarizerCalls++; content = "## Goal\nChat a lot\n## Progress\n### Done\nTalked about SENTINEL_FACT"; }
        else systems.push(b.messages[0].content);
        res.setHeader("content-type", "text/event-stream");
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
    const port = (fake.address() as { port: number }).port;
    try {
      const agent = makeAgent({
        serverUrl: baseUrl(), model: "local", thinking: "off", maxSteps: 3, contextTokens: 3000,
        compaction: { reserveTokens: 1600, keepRecentTokens: 300 },
        models: { local: { type: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake" } },
      } as any);
      agent.tools = [{ name: "whoami", description: "Who am I.", inputSchema: {} } as any]; // skips fetching tools
      const lines: string[] = [];
      for (let i = 0; i < 8; i++) await agent.say(`${i === 0 ? "SENTINEL_FACT " : ""}message ${i} ${big(1500)}`, (s) => lines.push(s));
      return { agent, systems, summarizerCalls, lines };
    } finally {
      fake.close();
    }
  }

  it("summarizes the old part of a long conversation and shows the model the summary", async () => {
    const { agent, systems, summarizerCalls, lines } = await run(false);
    expect(summarizerCalls).toBeGreaterThan(0);
    expect(agent.summary).toContain("SENTINEL_FACT");
    expect(systems.at(-1)).toContain("## Earlier in this conversation");
    expect(systems.at(-1)).toContain("SENTINEL_FACT");
    expect(lines.some((l) => l.startsWith("(compacted"))).toBe(true);
    expect(agent.history[0]).toMatchObject({ role: "user" });
    expect(agent.history.every((m, i) => m.role === (i % 2 ? "assistant" : "user"))).toBe(true); // still alternates
    expect(agent.history.length).toBeLessThan(16);
  }, 30_000);

  it("falls back to dropping old messages when the model cannot summarize", async () => {
    const { agent, lines } = await run(true);
    expect(agent.summary).toBe("");
    expect(lines.some((l) => l.startsWith("! could not summarize"))).toBe(true);
    expect(agent.history.length).toBeLessThan(16); // the old trim still keeps it inside the window
  }, 30_000);
});
