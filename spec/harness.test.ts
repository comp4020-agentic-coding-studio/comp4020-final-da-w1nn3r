import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { coerce, parseCall } from "../harness/src/agent.ts";
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
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
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
    expect(statSync(join(dir, "state.json")).mode & 0o077).toBe(0);

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
