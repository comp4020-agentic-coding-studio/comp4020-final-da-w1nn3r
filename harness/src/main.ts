#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { makeAgent } from "./agent.ts";
import { clearMemory, forget, listMemories } from "./memory.ts";
import { activeProfile, loadSettings, PERSONALITY_FILE, saveLocal, THINKING, type Thinking } from "./settings.ts";

const HELP = `Talk to the agent, or use a command:
  /model [name]        show models, or switch (local, openai, anthropic, or your own from settings.json)
  /thinking [level]    off | low | medium | high
  /personality [edit|reset|<new text>]   show or change the personality
  /memory              list memories     /forget <name>   delete one     /forget all
  /server [url]        show or change the server (a different server means a different login)
  /whoami              ask the server who you are
  /logout              forget the saved login for this server
  /reset               clear the conversation (memory and login are kept)
  /help   /quit`;

const DEFAULT_PERSONALITY = readFileSync(new URL("../personality.md", import.meta.url), "utf8");

function parseArgs(argv: string[]): { prompt?: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  let prompt: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--prompt") prompt = argv[++i];
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i];
    else if (!prompt) prompt = a;
  }
  return { prompt, flags };
}

async function main(): Promise<void> {
  const { prompt, flags } = parseArgs(process.argv.slice(2));
  const settings = loadSettings();
  if (flags.model) settings.model = flags.model;
  if (flags.thinking) settings.thinking = flags.thinking as Thinking;
  if (flags.server) settings.serverUrl = flags.server.replace(/\/+$/, "");
  if (!THINKING.includes(settings.thinking)) throw new Error(`thinking must be one of ${THINKING.join(", ")}`);
  activeProfile(settings);

  const agent = makeAgent(settings);
  const out = (s: string): void => console.log(s);

  if (prompt) {
    await agent.say(prompt, out);
    return;
  }

  const acct = agent.account();
  out(`agent harness | server ${settings.serverUrl} | model ${settings.model} | thinking ${settings.thinking}`);
  out(acct?.handle ? `logged in as @${acct.handle}` : "not registered yet: ask me to join the service");
  out('type /help for commands, /quit to leave\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    try {
      if (line.startsWith("/")) {
        if (await command(line)) return;
      } else if (line) {
        await agent.say(line, out);
      }
    } catch (err) {
      out(`error: ${(err as Error).message}`);
    }
    try {
      rl.prompt();
    } catch {
      return; // input closed (piped stdin)
    }
  }

  async function command(line: string): Promise<boolean> {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "quit": case "exit": case "q":
        return true;
      case "help":
        out(HELP);
        break;
      case "model":
        if (!arg) {
          for (const [k, p] of Object.entries(settings.models)) out(`${k === settings.model ? "*" : " "} ${k}: ${p.type} ${p.model}${p.baseUrl ? ` @ ${p.baseUrl}` : ""}`);
        } else {
          settings.model = arg;
          activeProfile(settings); // throws with the list of valid names
          saveLocal({ model: arg });
          out(`model is now ${arg}`);
        }
        break;
      case "thinking":
        if (!arg) out(`thinking is ${settings.thinking}`);
        else if (!THINKING.includes(arg as Thinking)) out(`use one of: ${THINKING.join(", ")}`);
        else {
          settings.thinking = arg as Thinking;
          saveLocal({ thinking: arg });
          out(`thinking is now ${arg}`);
        }
        break;
      case "personality":
        if (!arg) out(readFileSync(PERSONALITY_FILE, "utf8"));
        else if (arg === "reset") {
          writeFileSync(PERSONALITY_FILE, DEFAULT_PERSONALITY);
          out("personality reset");
        } else if (arg === "edit") {
          spawnSync(process.env.EDITOR ?? "nano", [PERSONALITY_FILE], { stdio: "inherit" });
          out("personality saved");
        } else {
          writeFileSync(PERSONALITY_FILE, arg + "\n");
          out("personality updated");
        }
        break;
      case "memory": {
        const m = listMemories();
        out(m.length ? m.map((e) => `- ${e.name}: ${e.summary}`).join("\n") : "(no memories)");
        break;
      }
      case "forget":
        if (arg === "all") { clearMemory(); out("all memories deleted"); }
        else out(forget(arg));
        break;
      case "server":
        if (!arg) out(settings.serverUrl);
        else {
          await agent.setServer(arg);
          saveLocal({ serverUrl: settings.serverUrl });
          const a = agent.account();
          out(`server is now ${settings.serverUrl} (${a?.handle ? `logged in as @${a.handle}` : "no account here yet"})`);
        }
        break;
      case "whoami":
        await agent.say("Call whoami and tell me what it says.", out);
        break;
      case "logout":
        agent.logout();
        out("saved login removed for this server");
        break;
      case "reset":
        agent.history = [];
        out("conversation cleared");
        break;
      default:
        out(`unknown command /${cmd}. Try /help`);
    }
    return false;
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
