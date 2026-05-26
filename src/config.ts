/**
 * Persistent JSON config in the per-user Electron userData directory.
 *
 *   macOS:   ~/Library/Application Support/Stagship Print Agent/config.json
 *   Windows: %APPDATA%\Stagship Print Agent\config.json
 *
 * The file is created lazily on first save. Reads are memoized for the life
 * of the process so the tray + HTTP server can pull the printer IP without
 * touching disk on every request.
 */
import { app } from "electron";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

export type AgentConfig = {
  printerIp?: string;
  printerPort?: number;
  autoStart?: boolean;
  /** Tracks the last reachability check so /status can answer instantly. */
  lastPing?: "ok" | "fail";
};

let cached: AgentConfig | null = null;

function configPath(): string {
  return join(app.getPath("userData"), "config.json");
}

export function getConfig(): AgentConfig {
  if (cached) return cached;
  const p = configPath();
  if (existsSync(p)) {
    try {
      cached = JSON.parse(readFileSync(p, "utf8")) as AgentConfig;
    } catch {
      // Corrupt config — start fresh rather than crashing the tray.
      cached = {};
    }
  } else {
    cached = {};
  }
  return cached;
}

export function saveConfig(patch: Partial<AgentConfig>): AgentConfig {
  const next = { ...getConfig(), ...patch };
  cached = next;
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
  return next;
}
