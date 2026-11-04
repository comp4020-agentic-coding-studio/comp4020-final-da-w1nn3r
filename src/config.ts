import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// A fixed, generic login for the admin UI (ADR-0030). It is in a public repo, so anyone can read it: fine for
// a class project, and ADMIN_USER / ADMIN_PASSWORD (a Fly secret) replace it. ADMIN_TOKEN still works as the password.
// Local dev keeps its secrets in a gitignored .env (the Docker image never has one; Fly uses secrets).
try { process.loadEnvFile(); } catch {}

export const ADMIN_DEFAULT_USER = "admin";
export const ADMIN_DEFAULT_PASSWORD = "ribbon-cable";

export const config = {
  port: Number(process.env.PORT ?? 8080),
  dbPath: process.env.DB_PATH ?? (process.env.NODE_ENV === "production" ? "/data/app.db" : ".data/app.db"),
  maxAgents: Number(process.env.MAX_AGENTS ?? 500),
  maxMessageChars: 2000,
  // A conversation is capped so a pair of agents cannot loop forever (ADR-0027).
  maxMessagesPerMatch: Number(process.env.MAX_MESSAGES_PER_MATCH ?? 256),
  maxEndReasonChars: 300,
  // A private 0-100 opinion of each match that the agent moves a little with every message (ADR-0080).
  opinionStart: 50,
  opinionMaxStep: 10,
  opinionCommitAt: 80,
  opinionEndAt: 20,
  maxBioChars: 500,
  // sliding-window limits (ADR-0008)
  callsPerMinute: Number(process.env.CALLS_PER_MINUTE ?? 120),
  messagesPerMinutePerMatch: Number(process.env.MESSAGES_PER_MINUTE ?? 10),
  registrationsPerHourPerIp: Number(process.env.REGISTRATIONS_PER_HOUR ?? 20),
  maxSseClients: 100,
  // How long the stored log (ADR-0034) is kept. Older lines are pruned so it cannot fill the volume.
  logRetentionDays: Number(process.env.LOG_RETENTION_DAYS ?? 60),
  // ...and how many lines at most, oldest dropped first, so a flood cannot fill the volume inside the retention (ADR-0098).
  logMaxRows: Number(process.env.LOG_MAX_ROWS ?? 1_000_000),
  // The database's budget on the 1 GB /data volume (ADR-0098). Past it, agent writes are refused and the log stops
  // being stored (it still goes to stdout). Leaves room for the WAL, SQLite's temp space and the admin to clean up.
  dbMaxBytes: Number(process.env.DB_MAX_MB ?? 800) * 1024 * 1024,
  // An account that has done nothing since registering (no swipe, message, block or profile edit) and has not been
  // seen for this many days gives its slot back when the agent cap is reached (ADR-0097).
  idleReclaimDays: Number(process.env.IDLE_RECLAIM_DAYS ?? 7),
  // Reports an agent can file per day (ADR-0096); blocking itself is not limited beyond the call rate.
  reportsPerDay: Number(process.env.REPORTS_PER_DAY ?? 10),
  maxReportChars: 500,
  // The admin UI under /admin (ADR-0018, ADR-0030) is always on. ADMIN_DISABLED=1 makes /admin a 404.
  // `||`, not `??`: an empty variable must fall back to the default, never become an empty password.
  adminUser: process.env.ADMIN_USER || ADMIN_DEFAULT_USER,
  adminPassword: process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN || ADMIN_DEFAULT_PASSWORD,
  // A bearer token on /mcp that unlocks the admin_* tools (ADR-0037). Off unless set, and ignored if shorter than 24
  // characters so a placeholder can never become a password.
  devMcpToken: (process.env.DEV_MCP_TOKEN ?? "").trim().length >= 24 ? (process.env.DEV_MCP_TOKEN ?? "").trim() : "",
  adminDisabled: process.env.ADMIN_DISABLED === "1",
};

export function ensureDataDir(): void {
  mkdirSync(dirname(config.dbPath), { recursive: true });
}
