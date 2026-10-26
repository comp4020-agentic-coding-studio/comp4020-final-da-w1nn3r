import { chooseContext, probeContextTokens } from "./context.ts";
import { resolveAuto } from "./detect.ts";
import { chat } from "./llm.ts";
import { McpClient, McpError } from "./mcp.ts";
import { activeProfile, getAccount, type Settings } from "./settings.ts";
import { checkForUpdate, localVersion } from "./update.ts";

// `node src/main.ts --check` (ADR-0053): a non-interactive look at everything the harness needs, then exit
// 0 when all of it works and 1 when something does not. It never starts the TUI and never asks a question.

const SAMPLE_TIMEOUT_MS = 120_000; // a cold local model can take a while to load its first prompt

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000}s`)), ms)));
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export async function runCheck(settings: Settings, out: (line: string) => void = console.log): Promise<boolean> {
  let ok = true;
  const pass = (s: string): void => out(`ok    ${s}`);
  const fail = (s: string): void => {
    ok = false;
    out(`FAIL  ${s}`);
  };
  const info = (s: string): void => out(`      ${s}`);

  out(`Ribbon Cable harness ${localVersion() ?? "(git checkout)"}`);

  // 1. Model: the same choice a normal start makes, but never asking (a saved pick, else the best candidate, with a warning).
  let modelOk = false;
  try {
    const found = await resolveAuto(settings, { warn: info });
    const p = activeProfile(settings);
    const endpoint = p.type === "anthropic" ? (p.baseUrl ?? "https://api.anthropic.com") : (p.baseUrl ?? "https://api.openai.com/v1");
    pass(`model profile "${settings.model}"${found ? `: ${found}` : ""}`);
    info(`endpoint: ${endpoint}`);
    info(`model:    ${p.model}${p.label ? `  (shown on your profile as ${p.label})` : ""}`);
    if (p.apiKeyEnv) info(`key:      ${p.apiKeyEnv} is ${process.env[p.apiKeyEnv] ? "set" : "NOT set"}`);
    // The same context probe a normal start uses (ADR-0055): the server's real window against contextTokens.
    const ctx = chooseContext(settings.contextTokens, await probeContextTokens(p));
    info(`context:  ${ctx.tokens} tokens (${ctx.source})`);
    for (const w of ctx.warnings) info(`warning: ${w}`);
    modelOk = true;
  } catch (err) {
    fail(`model: ${(err as Error).message}`);
  }

  // 2. One tiny model call, so a wrong model id, a missing key or a stuck server shows up now and not mid-chat.
  if (modelOk) {
    const t0 = Date.now();
    try {
      const r = await withTimeout(chat(activeProfile(settings), "You are being health-checked. Reply with one word.", [{ role: "user", content: "Say ready." }], "off"), SAMPLE_TIMEOUT_MS, "the sample call");
      const text = r.text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (text) pass(`sample call answered in ${secs}s: ${JSON.stringify(text.slice(0, 60))}`);
      else if (r.reasoning || r.text) pass(`sample call answered in ${secs}s, but only with thinking and no answer (a reasoning model may need a bigger maxTokens)`);
      else fail(`sample call returned nothing after ${secs}s`);
    } catch (err) {
      fail(`sample call: ${(err as Error).message}`);
    }
  }

  // 3. The service: MCP reachable, and the saved login (if any) still accepted. The token itself is never printed.
  const mcp = new McpClient(settings.serverUrl);
  try {
    const tools = await mcp.listTools();
    pass(`server ${settings.serverUrl}: MCP answers, ${tools.length} tools`);
  } catch (err) {
    fail(`server ${settings.serverUrl}: ${(err as Error).message}`);
  }
  const acct = getAccount(settings.serverUrl);
  if (!acct) info("login: none saved for this server yet (start the harness and ask your agent to register)");
  else {
    mcp.token = acct.token;
    try {
      const r = await mcp.call("whoami", {});
      if (r.isError || !/logged in as/i.test(r.text)) fail(`login @${acct.handle}: the server did not accept it: ${r.text.slice(0, 160)}`);
      else pass(`login @${acct.handle} accepted`);
    } catch (err) {
      fail(`login @${acct.handle}: ${err instanceof McpError ? err.message : (err as Error).message}`);
    }
  }

  const newer = await checkForUpdate(settings.updateUrl);
  if (newer) info(`a newer harness (${newer}) is on the website: node src/main.ts --update`);
  out(ok ? "All checks passed." : "Some checks failed.");
  return ok;
}
