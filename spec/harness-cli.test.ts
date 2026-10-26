import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bestIndex, isChatModel, resolveAuto } from "../harness/src/detect.ts";
import { baseUrl } from "./helpers.ts";

// The harness command line and first-run model choice (ADR-0053).

let fake: Server;
let port = 0;
let models = ["nomic-embed-text-v1.5.gguf", "Qwen3.6-35B-A3B-Q4_K_M.gguf", "llama-3.2-3b.gguf"];
const chats: string[] = [];

beforeAll(async () => {
  fake = createServer((req, res) => {
    if (req.url === "/v1/models") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: models.map((id) => ({ id, owned_by: "llamacpp" })) }));
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const m = JSON.parse(body || "{}").model;
      chats.push(m);
      if (m === "broken") return void res.writeHead(400).end('{"error":"no such model"}');
      res.writeHead(200, { "content-type": "text/event-stream" }).end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ready" } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  port = (fake.address() as { port: number }).port;
});
afterAll(() => fake.close());

const opts = (o: object = {}) => ({ ports: [[port, "llama.cpp"]] as [number, string][], hosts: ["127.0.0.1"], env: {}, ...o });
const settings = (extra: object = {}): any => ({ model: "auto", models: {}, ...extra });

describe("choosing among several models (ADR-0053)", () => {
  it("never suggests an embedding model, and prefers the target range", () => {
    expect(isChatModel("nomic-embed-text-v1.5.gguf")).toBe(false);
    expect(isChatModel("bge-reranker-v2")).toBe(false);
    expect(isChatModel("gpt-oss-20b")).toBe(true);
    const f = (id: string) => ({ summary: id, profile: { type: "openai" as const, model: id } });
    expect(bestIndex([f("all-MiniLM-L6"), f("llama-3.2-3b"), f("Qwen3.6-35B-A3B")])).toBe(2);
    // gpt-oss left the target range (ADR-0059): listed, it is just another chat model.
    expect(bestIndex([f("all-MiniLM-L6"), f("llama-3.2-3b"), f("gpt-oss-20b")])).toBe(1);
    expect(bestIndex([f("e5-large"), f("llama-3.2-3b")])).toBe(1);
  });

  it("asks once on a terminal, saves the pick, then uses it silently", async () => {
    const asked: string[][] = [];
    const saved: any[] = [];
    const ask = async (list: any[], pre: number) => {
      asked.push(list.map((f) => f.profile.model));
      expect(list[pre].profile.model).toBe("Qwen3.6-35B-A3B-Q4_K_M.gguf");
      return list.findIndex((f) => f.profile.model === "llama-3.2-3b.gguf");
    };
    const s = settings();
    await resolveAuto(s, opts({ ask, save: (p: any) => saved.push(p) }));
    expect(asked).toEqual([["Qwen3.6-35B-A3B-Q4_K_M.gguf", "llama-3.2-3b.gguf"]]); // embedding model left out
    expect(s.models.auto.model).toBe("llama-3.2-3b.gguf");
    expect(saved).toEqual([{ chosenModels: { auto: `local@127.0.0.1:${port}:llama-3.2-3b.gguf` } }]);

    const again = settings({ chosenModels: saved[0].chosenModels });
    await resolveAuto(again, opts({ ask: async () => { throw new Error("should not ask"); } }));
    expect(again.models.auto.model).toBe("llama-3.2-3b.gguf");
  });

  it("asks again, showing every model, when the saved one is gone", async () => {
    let shown: string[] = [];
    const s = settings({ chosenModels: { auto: `local@127.0.0.1:${port}:deleted.gguf` } });
    const saved: any[] = [];
    await resolveAuto(s, opts({ ask: async (list: any[], pre: number) => ((shown = list.map((f) => f.profile.model)), pre), save: (p: any) => saved.push(p) }));
    expect(shown).toEqual(models);
    expect(s.models.auto.model).toBe("Qwen3.6-35B-A3B-Q4_K_M.gguf");
    expect(saved[0].chosenModels.auto).toContain("Qwen3.6");
  });

  it("never blocks without a terminal: best candidate, a warning, nothing saved", async () => {
    const warnings: string[] = [];
    const saved: any[] = [];
    const s = settings();
    await resolveAuto(s, opts({ warn: (l: string) => warnings.push(l), save: (p: any) => saved.push(p) }));
    expect(s.models.auto.model).toBe("Qwen3.6-35B-A3B-Q4_K_M.gguf");
    expect(warnings.join()).toContain("2 models found");
    expect(saved).toEqual([]);
  });

  it("fills in a profile with no model from the server's list, and labels it from the id", async () => {
    const s = settings({ model: "local", models: { local: { type: "openai", baseUrl: `http://127.0.0.1:${port}/v1` } }, chosenModels: { local: "llama-3.2-3b.gguf" } });
    await resolveAuto(s, opts());
    expect(s.models.local).toMatchObject({ model: "llama-3.2-3b.gguf", label: "llama-3.2-3b" });
  });

  it("says what to start, without repo-only commands, when nothing is found", async () => {
    const err = await resolveAuto(settings(), { ports: [], hosts: [], env: {} }).catch((e) => e as Error);
    expect(String(err)).toContain("llama-server");
    expect(String(err)).not.toContain("docker");
  });
});

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((ok) => {
    const child = spawn(process.execPath, ["harness/src/main.ts", ...args], { env: { ...process.env, NO_COLOR: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => ok({ code, out }));
  });
}

describe("harness command line (ADR-0053)", () => {
  const home = (): Record<string, string> => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-"));
    return { HARNESS_HOME: dir, HARNESS_LOCAL_FILE: join(dir, "settings.local.json"), HARNESS_SERVER_URL: baseUrl() };
  };

  it("--help prints usage and exits before reading settings or looking for a model", async () => {
    const env = home();
    writeFileSync(env.HARNESS_LOCAL_FILE, "{ not json"); // would make any later step fail
    for (const flag of ["--help", "-h"]) {
      const { code, out } = await run([flag], env);
      expect(code, out).toBe(0);
      expect(out).toContain("--check");
      expect(out).toContain("/personality");
    }
  });

  it("--check reports model, sample call and server, and exits 0 when all work", async () => {
    const env = home();
    writeFileSync(env.HARNESS_LOCAL_FILE, JSON.stringify({ model: "local", models: { local: { type: "openai", baseUrl: `http://127.0.0.1:${port}/v1` } } }));
    const { code, out } = await run(["--check"], env);
    expect(code, out).toBe(0);
    expect(out).toContain(`endpoint: http://127.0.0.1:${port}/v1`);
    expect(out).toContain("sample call answered");
    expect(out).toMatch(/server .*MCP answers/);
    expect(out).toContain("warning: 2 models found"); // no terminal: picks without asking
  }, 30_000);

  it("--check exits 1 when the model call fails", async () => {
    const env = home();
    writeFileSync(env.HARNESS_LOCAL_FILE, JSON.stringify({ model: "local", models: { local: { type: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, model: "broken" } } }));
    const { code, out } = await run(["--check"], env);
    expect(code, out).toBe(1);
    expect(out).toContain("FAIL  sample call");
  }, 30_000);
});
