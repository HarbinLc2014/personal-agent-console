import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { RelayServer, defaultMobileDist } from "./server.js";

const workspaceRoot = resolve(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const envFile = resolve(workspaceRoot, ".env");
if (existsSync(envFile)) loadEnvFile(envFile);
const host = process.env.FLEET_RELAY_HOST ?? "127.0.0.1";
const port = Number(process.env.FLEET_RELAY_PORT ?? "4317");
const stateDir = resolve(
  workspaceRoot,
  process.env.FLEET_STATE_DIR ?? ".local/state",
);

const relay = new RelayServer({
  host,
  port,
  appToken: process.env.FLEET_APP_TOKEN ?? "dev-app-token",
  daemonToken: process.env.FLEET_DAEMON_TOKEN ?? "dev-daemon-token",
  stateFile: resolve(stateDir, "relay.sqlite"),
  mobileDist: defaultMobileDist(),
});

const address = await relay.listen();
console.log(
  `Agent Console relay listening on http://${address.host}:${address.port}`,
);
if (!process.env.FLEET_APP_TOKEN || !process.env.FLEET_DAEMON_TOKEN) {
  console.warn(
    "Using localhost-only development tokens. Set FLEET_APP_TOKEN and FLEET_DAEMON_TOKEN before remote access.",
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void relay.close().finally(() => process.exit(0));
  });
}
