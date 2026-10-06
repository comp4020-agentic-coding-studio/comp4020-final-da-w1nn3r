#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { makeAgent, type Live } from "./agent.ts";
import { autoPrompt, findPending, type MatchInfo } from "./auto.ts";
import type { Kind } from "./llm.ts";
import { LOGO, renderLogo } from "./logo.ts";
import { resolveAuto } from "./detect.ts";
import { clearMemory, forget, listMemories } from "./memory.ts";
import { activeProfile, loadSettings, PERSONALITY_FILE, saveLocal, THINKING, type Thinking } from "./settings.ts";

const HELP = `Talk to the agent, or use a command:
  /model [name]        show models, or switch (auto, local, openai, anthropic, or your own from settings.json)
  /thinking [level]    off | low | medium | high
  /personality [edit|reset|<new text>]   show or change the personality
  /memory              list memories     /forget <name>   delete one     /forget all
  /auto [on|off|seconds]   watch for new matches and unanswered messages and pass them to the agent
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
    else if (a === "--auto") flags.auto = "on";
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i];
    else if (!prompt) prompt = a;
  }
  return { prompt, flags };
}

/** Prints the model's output as it streams: thinking dimmed under a "(thinking)" label, the answer plain. */
function makeLive(): Live {
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const dim = color ? "\x1b[2m" : "";
  const reset = color ? "\x1b[0m" : "";
  let mode: Kind | undefined;
  let fresh = true; // nothing but whitespace printed in this section yet
  return {
    token(kind, s) {
      if (kind !== mode) {
        if (mode) process.stdout.write(`${mode === "think" ? reset : ""}\n`);
        mode = kind;
        fresh = true;
        if (kind === "think") process.stdout.write(`${dim}(thinking) `);
      }
      if (fresh) {
        s = s.replace(/^\s+/, "");
        if (!s) return;
        fresh = false;
      }
      process.stdout.write(s);
    },
    end() {
      if (mode) process.stdout.write(`${mode === "think" ? reset : ""}\n`);
      mode = undefined;
    },
  };
}

async function main(): Promise<void> {
  const { prompt, flags } = parseArgs(process.argv.slice(2));
  const settings = loadSettings();
  if (flags.model) settings.model = flags.model;
  if (flags.thinking) settings.thinking = flags.thinking as Thinking;
  if (flags.server) settings.serverUrl = flags.server.replace(/\/+$/, "");
  if (!THINKING.includes(settings.thinking)) throw new Error(`thinking must be one of ${THINKING.join(", ")}`);
  const detected = await resolveAuto(settings);
  if (detected) console.log(`auto: using ${detected}`);
  activeProfile(settings);

  const agent = makeAgent(settings);
  const out = (s: string): void => console.log(s);

  const live = makeLive();
  if (prompt) {
    await agent.say(prompt, out, live);
    return;
  }

  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const dim = (t: string): string => (color ? `\x1b[2m${t}\x1b[0m` : t);
  const bold = (t: string): string => (color ? `\x1b[1m${t}\x1b[0m` : t);
  const cols = process.stdout.columns || 80;

  // On a real terminal the screen is ours, like pi's: cleared, with the last two rows (status rule and input)
  // pinned to the bottom and everything else scrolling in the region above them.
  const rows = process.stdout.rows ?? 0;
  const fixed = Boolean(process.stdout.isTTY) && rows >= 16;
  const write = (t: string): void => void process.stdout.write(t);
  if (fixed) {
    write(`\x1b[2J\x1b[3J\x1b[1;${rows - 2}r\x1b[H`);
    process.on("exit", () => write(`\x1b[r\x1b[${rows};1H\n`));
  }

  // Banner, laid out like pi's: the logo with the title and hints beside it (below it on a narrow terminal).
  const acct = agent.account();
  const host = settings.serverUrl.replace(/^https?:\/\//, "");
  const info = [
    bold("Ribbon Cable") + dim(" harness"),
    dim("Connecting Agents for Love"),
    "",
    acct?.handle ? `logged in as @${acct.handle}` : "not registered yet: ask me to join",
    dim(`${settings.model} · thinking ${settings.thinking}`),
    dim(host),
    "",
    dim("/help commands · /auto watch · /quit exit"),
  ];
  const logo = renderLogo(Boolean(color));
  if (cols >= 90) logo.forEach((l, i) => out(`${l}${" ".repeat(Math.max(0, 46 - (LOGO[i]?.length ?? 0)))}${info[i] ?? ""}`));
  else {
    logo.forEach((l) => out(l));
    out(info.join("\n"));
  }
  out("");

  // The line above the prompt, like pi's editor frame: a rule that carries the current status.
  const showPrompt = (): void => {
    const a = agent.account();
    const label = ` ${a?.handle ? "@" + a.handle : "no account"} · ${settings.model} · thinking ${settings.thinking} · auto ${autoSecs ? autoSecs + "s" : "off"} `;
    const width = Math.min(cols, 100);
    const rule = dim("──" + label + "─".repeat(Math.max(2, width - label.length - 2)));
    if (!fixed) {
      out(rule);
      rl.prompt();
      return;
    }
    if (!atPrompt) write("\x1b7"); // remember where the transcript left off
    atPrompt = true;
    write(`\x1b[${rows - 1};1H\x1b[2K${rule}\x1b[${rows};1H\x1b[2K`);
    rl.prompt();
  };
  /** Leave the input row and go back to the end of the transcript, so output lands there. */
  const toTranscript = (): void => {
    if (!fixed || !atPrompt) return;
    atPrompt = false;
    write(`\x1b[${rows};1H\x1b[2K\x1b8`);
  };

  // One line at a time. Lines typed while the agent is busy wait their turn, and the prompt
  // only comes back when everything has been answered.
  let atPrompt = false;
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "› " });
  const queue: string[] = [];
  let autoSecs = 0; // 0 = off
  let busy = false;
  let closed = false;
  const pump = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    rl.pause(); // keystrokes wait in the terminal instead of being echoed into the reply
    while (queue.length) {
      const line = queue.shift()!.trim();
      try {
        if (line.startsWith("/")) {
          if (await command(line)) {
            queue.length = 0;
            closed = true;
          }
        } else if (line) {
          await agent.say(line, out, live);
        }
      } catch (err) {
        live.end();
        out(`error: ${(err as Error).message}`);
      }
    }
    busy = false;
    if (closed) {
      rl.close();
      process.exit(0);
    }
    else {
      rl.resume();
      showPrompt();
    }
  };
  rl.on("line", (l) => {
    if (fixed && atPrompt && l.trim()) {
      toTranscript();
      out(dim(`› ${l}`)); // the line you typed joins the transcript
    }
    queue.push(l);
    void pump();
  });
  rl.on("close", () => {
    closed = true; // input ended (quit, ctrl-d, or piped stdin): finish what is queued, then exit
    if (!busy) process.exit(0);
  });
  showPrompt();

  // Auto mode: while idle, poll list_matches and queue a task for anything unanswered (src/auto.ts).
  const seen = new Set<string>();
  let autoTimer: NodeJS.Timeout | undefined;
  let autoWarned = false;
  const autoTick = async (): Promise<void> => {
    autoTimer = undefined;
    if (!autoSecs) return;
    try {
      if (!busy && !queue.length && agent.account()) {
        const r = await agent.mcp.call("list_matches", {});
        const found = findPending(JSON.parse(r.text.slice(0, r.text.lastIndexOf("}") + 1)).matches as MatchInfo[], seen);
        if (found.length && !busy && !queue.length) {
          found.forEach((p) => seen.add(p.key));
          toTranscript();
          out(`\n[auto] ${found.length} waiting: ${found.map((p) => "@" + p.match.with).join(", ")}`);
          queue.push(autoPrompt(found));
          void pump();
        }
        autoWarned = false;
      }
    } catch (err) {
      if (!autoWarned) toTranscript();
      if (!autoWarned) out(`\n[auto] check failed, will keep trying: ${(err as Error).message}`);
      autoWarned = true;
    }
    if (autoSecs) autoTimer = setTimeout(autoTick, autoSecs * 1000);
  };
  const setAuto = (secs: number): void => {
    autoSecs = secs;
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = secs ? setTimeout(autoTick, 0) : undefined;
  };
  if (flags.auto) setAuto(settings.autoSeconds ?? 30);

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
          out(`${settings.model === "auto" ? "*" : " "} auto: use whatever local server or API key is found`);
          for (const [k, p] of Object.entries(settings.models)) if (k !== "auto") out(`${k === settings.model ? "*" : " "} ${k}: ${p.type} ${p.model}${p.baseUrl ? ` @ ${p.baseUrl}` : ""}`);
        } else {
          const before = settings.model;
          settings.model = arg;
          try {
            const found = await resolveAuto(settings);
            if (found) out(`auto: using ${found}`);
            activeProfile(settings); // throws with the list of valid names
          } catch (err) {
            settings.model = before;
            throw err;
          }
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
      case "auto": {
        const n = Number(arg);
        if (!arg) out(autoSecs ? `auto is on: checking every ${autoSecs}s` : "auto is off");
        else if (arg === "off") { setAuto(0); out("auto is off"); }
        else if (arg === "on" || n >= 5) {
          setAuto(arg === "on" ? settings.autoSeconds ?? 30 : n);
          if (arg !== "on") settings.autoSeconds = n;
          out(`auto is on: checking every ${autoSecs}s. Unanswered messages and new matches go to the agent.`);
        } else out("use /auto on, /auto off, or /auto <seconds> (5 or more)");
        break;
      }
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
