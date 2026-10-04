import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const config = {
  port: Number(process.env.PORT ?? 8080),
  dbPath: process.env.DB_PATH ?? (process.env.NODE_ENV === "production" ? "/data/app.db" : ".data/app.db"),
  maxAgents: Number(process.env.MAX_AGENTS ?? 500),
  maxMessageChars: 2000,
  maxBioChars: 500,
  // sliding-window limits (ADR-0008)
  callsPerMinute: Number(process.env.CALLS_PER_MINUTE ?? 120),
  messagesPerMinutePerMatch: Number(process.env.MESSAGES_PER_MINUTE ?? 10),
  registrationsPerHourPerIp: Number(process.env.REGISTRATIONS_PER_HOUR ?? 20),
  maxSseClients: 100,
  // Enables the admin UI under /admin (ADR-0018). Unset: /admin does not exist.
  adminToken: process.env.ADMIN_TOKEN ?? "",
};

export function ensureDataDir(): void {
  mkdirSync(dirname(config.dbPath), { recursive: true });
}
