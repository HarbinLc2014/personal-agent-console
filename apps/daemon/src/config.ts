import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, platform, arch } from "node:os";
import { delimiter, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { Harness, Machine } from "@agent-console/protocol";

export type DaemonConfig = {
  relayUrl: string;
  daemonToken: string;
  machine: Machine;
};

const workspaceRoot = resolve(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const envFile = resolve(workspaceRoot, ".env");
if (existsSync(envFile)) loadEnvFile(envFile);
const stateDir = resolve(
  workspaceRoot,
  process.env.FLEET_STATE_DIR ?? ".local/state",
);

function stableMachineId(): string {
  mkdirSync(stateDir, { recursive: true });
  const file = resolve(stateDir, "machine-id");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const id = crypto.randomUUID();
  writeFileSync(file, `${id}\n`, { mode: 0o600, flag: "wx" });
  return id;
}

function findExecutable(command: string): string | undefined {
  const locator = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\r?\n/).find(Boolean)?.trim();
}

function detectHarnesses(): Harness[] {
  const candidates = [
    { id: "codex", label: "Codex", command: "codex", structuredEvents: false },
    {
      id: "claude",
      label: "Claude Code",
      command: "claude",
      structuredEvents: false,
    },
    { id: "pi", label: "Pi", command: "pi", structuredEvents: false },
    {
      id: "opencode",
      label: "OpenCode",
      command: "opencode",
      structuredEvents: false,
    },
  ];
  const detected = candidates.map((candidate) => ({
    ...candidate,
    command: findExecutable(candidate.command) ?? candidate.command,
    available: Boolean(findExecutable(candidate.command)),
  }));
  if (process.env.FLEET_ENABLE_SHELL === "1") {
    const configuredShell = process.env.SHELL;
    const command =
      configuredShell && existsSync(configuredShell)
        ? configuredShell
        : process.platform === "win32"
          ? "powershell.exe"
          : "/bin/sh";
    detected.push({
      id: "shell",
      label: "Managed shell",
      command,
      available: existsSync(command) || Boolean(findExecutable(command)),
      structuredEvents: false,
    });
  }
  return detected;
}

function allowedRoots(): string[] {
  const configured = process.env.FLEET_ALLOWED_ROOTS?.split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const roots = configured?.length ? configured : [workspaceRoot];
  return roots.map((root) => realpathSync(resolve(root)));
}

export function loadConfig(): DaemonConfig {
  const roots = allowedRoots();
  return {
    relayUrl: process.env.FLEET_RELAY_URL ?? "ws://127.0.0.1:4317/ws/daemon",
    daemonToken: process.env.FLEET_DAEMON_TOKEN ?? "dev-daemon-token",
    machine: {
      id: stableMachineId(),
      name: process.env.FLEET_MACHINE_NAME ?? hostname(),
      platform: platform(),
      arch: arch(),
      daemonVersion: "0.1.0",
      allowedRoots: roots,
      harnesses: detectHarnesses(),
    },
  };
}

export function sanitizedChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("FLEET_")) continue;
    env[key] = value;
  }
  env.HOME = process.env.HOME ?? homedir();
  env.TERM = "xterm-256color";
  env.AGENT_CONSOLE_MANAGED = "1";
  return env;
}
