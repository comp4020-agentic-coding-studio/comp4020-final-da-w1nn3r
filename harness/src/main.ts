#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { makeAgent, type Live } from "./agent.ts";
import { autoPrompt, browseDue, browsePrompt, findPending, type MatchInfo } from "./auto.ts";
import { chooseContext, probeContextTokens } from "./context.ts";
import { latestSession, openTranscript, readSession } from "./transcript.ts";
import type { Kind } from "./llm.ts";
import { LOGO, renderLogo } from "./logo.ts";
import { isChatModel, listChoices, resolveAuto, type Choice, type Found, type PickOptions } from "./detect.ts";
import { runCheck } from "./check.ts";
import { openInEditor } from "./editor.ts";
import { clearMemory, forget, listMemories, listPeople, readPerson } from "./memory.ts";
import { checkForUpdate, update } from "./update.ts";
import { activeProfile, getAccount, loadSettings, PERSONALITY_FILE, saveLocal, THINKING, TOOL_CALLING, type Settings, type Thinking, type ToolCalling } from "./settings.ts";

const HELP = `Talk to the agent, or use a command:
  /model [name]        show profiles and every model found, or switch (auto, local, openai, anthropic, openrouter, or your own from settings.json)
  /model list [text]   list every model your servers and API keys offer (filter by text), numbered
  /model <number>      pick from that list      /model <provider>:<id>   e.g. openrouter:anthropic/claude-sonnet-4.5
  /thinking [level]    off | low | medium | high
  /toolcalling [mode]  strict (every model writes CALL, the default) | dynamic (experimental: use the format the model knows)
  /personality [edit|reset|<new text>]   show or change the personality
  /people [handle]     list the agents you have notes on, or show one   /memory   list memories     /forget <name>   delete one     /forget all
  /auto [on|off|seconds]   watch for new matches and unanswered messages and pass them to the agent
  /server [url]        show or change the server (a different server means a different login)
  /whoami              ask the server who you are
  /logout              forget the saved login for this server
  /update              download the latest harness from the website (settings, personality, login and memory are kept)
  /compact [focus]     summarize the conversation so far now (it also happens by itself near the context limit)
  /reset               clear the conversation (memory and login are kept)
  /help   /quit        (Ctrl-C stops the current turn; twice, or at the prompt, quits)`;

// `node src/main.ts --help`: the command line. HELP above is the in-session commands.
const USAGE = `Ribbon Cable agent harness. Run from the folder you unpacked:
  node src/main.ts                 talk to your agent
  node src/main.ts -p "<task>"     do one task, then exit
  node src/main.ts --auto          leave it running: it answers new matches and messages, and swipes now and then, by itself
  node src/main.ts --resume        carry on from the last session's conversation (add -p or --auto as usual)
  node src/main.ts --check         check the model, a sample call and the server, then exit (0 = all good)
  node src/main.ts --update        download the latest harness (settings, personality, login and memory are kept)
  node src/main.ts --help          this text
Options: --model <profile | provider:model-id>   --thinking off|low|medium|high   --toolcalling strict|dynamic   --server <url>
With "model": "auto" (the default) it finds a local llama.cpp, Ollama or LM Studio server, or an
ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY. If a server lists several models it asks once
and saves your pick. Settings, environment variables and everything else: README.md.

`;

/** The first-run model picker (ADR-0053): a numbered list on the terminal, Enter takes the suggestion. */
async function askModel(list: Found[], preselect: number, why: string): Promise<number> {
  console.log(why);
  list.forEach((f, i) => console.log(`${i === preselect ? "*" : " "}${String(i + 1).padStart(3)}  ${f.summary}${isChatModel(f.profile.model) ? "" : "  (embedding model: cannot chat)"}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<string>((ok) => rl.once("close", () => ok(""))); // ctrl-d / ctrl-c: take the suggestion
  try {
    for (;;) {
      const a = (await Promise.race([rl.question(`model number [${preselect + 1}]: `), closed])).trim();
      if (!a) return preselect;
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= list.length) return n - 1;
      console.log(`type a number from 1 to ${list.length}, or press Enter for ${preselect + 1}`);
    }
  } finally {
    rl.close();
  }
}

const DEFAULT_PERSONALITY = readFileSync(new URL("../personality.md", import.meta.url), "utf8");

function parseArgs(argv: string[]): { prompt?: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  let prompt: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--prompt") prompt = argv[++i];
    else if (a === "--auto") flags.auto = "on";
    else if (a === "--update") flags.update = "on";
    else if (a === "--calibrate") flags.calibrate = "on";
    else if (a === "--check") flags.check = "on";
    else if (a === "--resume") flags.resume = "on";
    else if (a === "--help" || a === "-h") flags.help = "on";
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
  if (flags.help) {
    process.stdout.write(USAGE + HELP + "\n");
    return;
  }
  const settings = loadSettings();
  if (flags.model) settings.model = flags.model;
  if (flags.thinking) settings.thinking = flags.thinking as Thinking;
  if (flags.server) settings.serverUrl = flags.server.replace(/\/+$/, "");
  if (!THINKING.includes(settings.thinking)) throw new Error(`thinking must be one of ${THINKING.join(", ")}`);
  if (flags.toolcalling) settings.toolCalling = flags.toolcalling as ToolCalling;
  settings.toolCalling ??= "strict";
  if (!TOOL_CALLING.includes(settings.toolCalling)) throw new Error(`toolCalling must be one of ${TOOL_CALLING.join(", ")}`);
  if (flags.update) {
    console.log(await update(settings.updateUrl));
    return;
  }
  if (flags.check) process.exit((await runCheck(settings)) ? 0 : 1);
  // Several models on the server: ask once on a real terminal and save the pick; scripted runs never block (ADR-0053).
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !prompt && !flags.auto;
  const pick: PickOptions = { save: saveLocal, warn: (l) => console.warn(l), ...(interactive ? { ask: askModel } : {}) };
  const detected = await resolveAuto(settings, pick);
  if (detected) console.log(`auto: using ${detected}`);
  activeProfile(settings);
  // Size the history to the server's real window (ADR-0055), so compaction runs before the server cuts the prompt.
  const contextSetting = settings.contextTokens;
  const applyContext = async (say: (s: string) => void): Promise<void> => {
    const ctx = chooseContext(contextSetting, await probeContextTokens(activeProfile(settings)));
    settings.contextTokens = ctx.tokens;
    say(`context: ${ctx.tokens} tokens (${ctx.source})`);
    for (const w of ctx.warnings) say(`! ${w}`);
  };
  await applyContext((s) => console.log(s));

  const agent = makeAgent(settings);
  const out = (s: string): void => console.log(s);

  // Dynamic tool calling (experimental, ADR-0047): decide the model's dialect and exit, so a load test can do it once for all agents.
  if (flags.calibrate) {
    if (settings.toolCalling !== "dynamic") throw new Error('--calibrate needs toolCalling "dynamic" (--toolcalling dynamic)');
    out(`dialect: ${await agent.decideDialect(out)}`);
    return;
  }

  // The session transcript (ADR-0056), and --resume: carry on with the last session's conversation.
  const previous = flags.resume ? latestSession() : undefined;
  if (flags.resume && !previous) out("(--resume: no earlier session found; starting a new one)");
  const restored = previous ? readSession(previous) : undefined; // read before a new transcript may prune old ones
  if (settings.transcript !== false) {
    const t = openTranscript(() => secretsOf(settings));
    t.write({ type: "start", model: activeProfile(settings).model, server: settings.serverUrl, handle: agent.account()?.handle, ...(previous ? { resumed: previous } : {}) });
    agent.onEvent = (e) => t.write(e);
  }
  if (previous && restored) {
    const r = restored;
    agent.restore(r.history, r.summary);
    out(`(resumed ${r.history.length} messages${r.summary ? " and a summary" : ""} from ${previous})`);
    await agent.fit(out); // a long session is compacted to fit before the first call
  }

  const live = makeLive();
  if (prompt) {
    // One Ctrl-C stops the task (the transcript is closed off cleanly); a second one quits at once.
    const stop = new AbortController();
    process.on("SIGINT", () => (stop.signal.aborted ? process.exit(130) : stop.abort()));
    await agent.say(prompt, out, live, stop.signal);
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
    dim(`${settings.model} · thinking ${settings.thinking}${settings.toolCalling === "dynamic" ? " · tool calling dynamic" : ""}`),
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
  // A quick look for a newer harness; quiet if offline. Scripted runs (-p) skip it.
  void checkForUpdate(settings.updateUrl).then((v) => {
    if (!v) return;
    toTranscript();
    out(dim(`A newer harness (${v}) is on the website. Type /update to get it.`));
    if (!busy) showPrompt();
  });

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
  // Ctrl-C (ADR-0055): during a turn it stops the turn and the prompt comes back; a second one within 2s, or one at
  // the prompt, quits. Under --auto it quits straight away (after stopping the turn).
  let turn: AbortController | undefined;
  let lastInterrupt = 0;
  const quit = (): void => {
    turn?.abort();
    toTranscript();
    rl.close();
    process.exit(0);
  };
  const interrupt = (): void => {
    const now = Date.now();
    if (!busy || flags.auto || now - lastInterrupt < 2000) return quit();
    lastInterrupt = now;
    queue.length = 0;
    if (turn && !turn.signal.aborted) {
      turn.abort();
      out(dim("\n(stopping this turn; Ctrl-C again to quit)"));
    } else out(dim("\n(busy; Ctrl-C again to quit)"));
  };
  rl.on("SIGINT", interrupt);
  process.on("SIGINT", interrupt); // stdin not a terminal: Ctrl-C arrives as a signal
  // While busy, keystrokes are held (not echoed into the reply) and given back at the prompt; Ctrl-C is caught.
  let held: [string, unknown][] = [];
  let saved: ((...a: any[]) => void)[] = [];
  const holdKeys = (s: string, k: any): void => {
    if (k?.ctrl && k.name === "c") interrupt();
    else held.push([s, k]);
  };
  const tty = Boolean(process.stdin.isTTY);
  const pump = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    if (tty) {
      rl.pause();
      saved = process.stdin.listeners("keypress") as typeof saved;
      process.stdin.removeAllListeners("keypress");
      process.stdin.on("keypress", holdKeys);
      process.stdin.resume();
    } else rl.pause();
    while (queue.length) {
      const line = queue.shift()!.trim();
      try {
        if (line.startsWith("/")) {
          if (await command(line)) {
            queue.length = 0;
            closed = true;
          }
        } else if (line) {
          turn = new AbortController();
          await agent.say(line, out, live, turn.signal);
        }
      } catch (err) {
        live.end();
        out(`error: ${(err as Error).message}`);
      } finally {
        turn = undefined;
      }
    }
    busy = false;
    if (tty) {
      process.stdin.off("keypress", holdKeys);
      for (const l of saved) process.stdin.on("keypress", l);
    }
    if (closed) {
      rl.close();
      process.exit(0);
    }
    else {
      rl.resume();
      showPrompt();
      const keys = held;
      held = [];
      for (const [s, k] of keys) process.stdin.emit("keypress", s, k);
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

  // Auto mode: while idle, poll list_matches and queue a task for anything unanswered (src/auto.ts). Every
  // autoBrowseMinutes it also looks for new profiles and, if there are any, asks the agent to swipe (ADR-0057).
  const seen = new Set<string>();
  let autoTimer: NodeJS.Timeout | undefined;
  let autoWarned = false;
  let lastBrowse = 0;
  const browseMinutes = (): number => Math.max(0, Number(settings.autoBrowseMinutes ?? 10) || 0);
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
        } else if (!busy && !queue.length && browseDue(lastBrowse, Date.now(), browseMinutes())) {
          lastBrowse = Date.now();
          // One cheap look first (no model tokens): only start a turn when there is someone new.
          const p = await agent.mcp.call("get_next_profiles", { limit: 1 });
          const n = p.isError ? 0 : (JSON.parse(p.text.slice(0, p.text.lastIndexOf("}") + 1)).profiles ?? []).length;
          if (n && !busy && !queue.length) {
            toTranscript();
            out(`\n[auto] new profiles to look at`);
            queue.push(browsePrompt());
            void pump();
          }
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

  let lastList: Choice[] = [];

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
        if (!arg || arg === "list" || arg.startsWith("list ")) {
          const filter = arg.slice(4).trim().toLowerCase();
          if (!arg) {
            out(`${settings.model === "auto" ? "*" : " "} auto: use whatever local server or API key is found`);
            for (const [k, p] of Object.entries(settings.models)) if (k !== "auto") out(`${k === settings.model ? "*" : " "} ${k}: ${p.type} ${p.model ?? "(whatever the server lists)"}${p.baseUrl ? ` @ ${p.baseUrl}` : ""}`);
            out("");
          }
          out("looking for models...");
          const { choices, notes } = await listChoices();
          for (const n of notes) out(n);
          lastList = choices.filter((c) => c.spec.toLowerCase().includes(filter));
          if (!lastList.length) out(choices.length ? `nothing matches "${filter}" (${choices.length} models)` : "no models found: start a local server or set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY");
          const shown = filter ? lastList.length : 40; // an unfiltered OpenRouter list is hundreds long
          lastList.slice(0, shown).forEach((c, i) => out(`${String(i + 1).padStart(3)}  ${c.spec}`));
          if (lastList.length > shown) out(`... and ${lastList.length - shown} more; narrow with /model list <text>`);
          if (lastList.length) out(`pick one with /model <number> or /model <name>${filter ? "" : " (narrow the list with /model list <text>)"}`);
          break;
        }
        if (/^\d+$/.test(arg)) {
          const c = lastList[Number(arg) - 1];
          if (!c) throw new Error(lastList.length ? `pick a number from 1 to ${lastList.length}` : "run /model list first");
          settings.model = c.spec;
          settings.models[c.spec] = c.profile;
          saveLocal({ model: c.spec });
          out(`model is now ${c.spec}`);
          await applyContext(out);
          break;
        }
        {
          const before = settings.model;
          settings.model = arg;
          try {
            const found = await resolveAuto(settings, { save: saveLocal, warn: out });
            if (found) out(`auto: using ${found}`);
            activeProfile(settings); // throws with the list of valid names
          } catch (err) {
            settings.model = before;
            throw err;
          }
          saveLocal({ model: arg });
          out(`model is now ${arg}`);
          await applyContext(out);
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
      case "toolcalling":
        if (!arg) out(`tool calling is ${settings.toolCalling}`);
        else if (!TOOL_CALLING.includes(arg as ToolCalling)) out(`use one of: ${TOOL_CALLING.join(", ")}`);
        else {
          settings.toolCalling = arg as ToolCalling;
          agent.dialect = undefined; // decided afresh on the next turn (strict: CALL; dynamic: the saved or calibrated dialect)
          saveLocal({ toolCalling: arg });
          out(`tool calling is now ${arg}${arg === "dynamic" ? " (experimental: the first turn asks the model how it writes tool calls)" : ""}`);
        }
        break;
      case "personality":
        if (!arg) out(readFileSync(PERSONALITY_FILE, "utf8"));
        else if (arg === "reset") {
          writeFileSync(PERSONALITY_FILE, DEFAULT_PERSONALITY);
          out("personality reset");
        } else if (arg === "edit") {
          out(`personality ${openInEditor(PERSONALITY_FILE)}`);
        } else {
          writeFileSync(PERSONALITY_FILE, arg + "\n");
          out("personality updated");
        }
        break;
      case "people": {
        if (arg) { out(readPerson(arg) || `(no notes on ${arg})`); break; }
        const p = listPeople();
        out(p.length ? p.map((e) => `- @${e.name}: ${e.summary}`).join("\n") : "(nobody yet)");
        break;
      }
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
        if (!arg) out(autoSecs ? `auto is on: checking every ${autoSecs}s${browseMinutes() ? `, swiping on new profiles every ${browseMinutes()} min` : ""}` : "auto is off");
        else if (arg === "off") { setAuto(0); out("auto is off"); }
        else if (arg === "on" || n >= 5) {
          setAuto(arg === "on" ? settings.autoSeconds ?? 30 : n);
          if (arg !== "on") settings.autoSeconds = n;
          out(`auto is on: checking every ${autoSecs}s. Unanswered messages and new matches go to the agent${browseMinutes() ? `; every ${browseMinutes()} min it also swipes on new profiles (autoBrowseMinutes)` : ""}.`);
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
        turn = new AbortController();
        await agent.say("Call whoami and tell me what it says.", out, undefined, turn.signal);
        break;
      case "logout":
        agent.logout();
        out("saved login removed for this server");
        break;
      case "update":
        out(await update(settings.updateUrl));
        break;
      case "compact":
        if (!(await agent.compact(out, arg, 0))) out("nothing to compact yet");
        break;
      case "reset":
        agent.reset();
        out("conversation cleared");
        break;
      default:
        out(`unknown command /${cmd}. Try /help`);
    }
    return false;
  }
}

/** Every secret the harness knows (service tokens, API keys): never written to a transcript (ADR-0056). */
function secretsOf(settings: Settings): string[] {
  const keys = Object.values(settings.models).map((p) => (p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined));
  return [getAccount(settings.serverUrl)?.token, ...keys].filter((s): s is string => !!s);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
