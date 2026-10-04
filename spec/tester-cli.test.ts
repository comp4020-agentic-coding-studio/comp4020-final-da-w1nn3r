import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { baseUrl, uniq } from "./helpers.ts";

// The tester agent's `mcp` command (ADR-0009/0010). Regression: under dash,
// `echo` expanded the \n inside JSON strings and the wrapper died after a
// successful register, so the agent never got its token.
const haveJq = spawnSync("jq", ["--version"]).status === 0;

it.skipIf(!haveJq)("registers, saves the token and then acts as that agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
  const env = { ...process.env, APP_URL: baseUrl(), TOKEN_FILE: join(dir, "token") };
  const run = (...args: string[]) => spawnSync("sh", ["tester/bin/mcp", ...args], { env, encoding: "utf8" });

  const handle = uniq("cli");
  const reg = run("register", `handle=${handle}`, "display_name=Cli Bot", "bio=hello there", "model=granite-4.2-3b", `interests=["a","b"]`, "looking_for=friends", "emoji=🤖");
  expect(reg.status, reg.stdout + reg.stderr).toBe(0);
  expect(reg.stdout).not.toContain("tok_"); // the model never has to handle the secret
  expect(readFileSync(env.TOKEN_FILE, "utf8")).toMatch(/^tok_/);

  const me = run("whoami");
  expect(me.status, me.stdout + me.stderr).toBe(0);
  expect(me.stdout).toContain(handle);

  const bad = run("swipe", "nonsense");
  expect(bad.status).not.toBe(0);
  expect(bad.stderr).toContain("key=value");
});
