import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-console-e2e-"));
const children = [];
const logs = [];
const appToken = "e2e-app-token";
const daemonToken = "e2e-daemon-token";

try {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const sharedEnv = {
    FLEET_RELAY_PORT: String(port),
    FLEET_RELAY_HOST: "127.0.0.1",
    FLEET_APP_TOKEN: appToken,
    FLEET_DAEMON_TOKEN: daemonToken,
    FLEET_STATE_DIR: join(temporaryRoot, "state"),
  };

  startProcess("relay", "apps/relay/dist/index.js", sharedEnv);
  await waitFor(
    async () => (await fetch(`${baseUrl}/api/health`)).ok,
    "relay health",
  );

  startProcess("daemon", "apps/daemon/dist/index.js", {
    ...sharedEnv,
    FLEET_RELAY_URL: `ws://127.0.0.1:${port}/ws/daemon`,
    FLEET_ALLOWED_ROOTS: temporaryRoot,
    FLEET_ENABLE_SHELL: "1",
    FLEET_MACHINE_NAME: "E2E computer",
  });

  const machine = await waitFor(async () => {
    const response = await api(baseUrl, "/api/machines");
    return response.machines.find((item) => item.status === "online");
  }, "daemon registration");
  assert(
    machine.harnesses.some((item) => item.id === "shell" && item.available),
    "managed shell missing",
  );

  const started = await api(baseUrl, "/api/sessions", {
    method: "POST",
    body: {
      machineId: machine.id,
      harnessId: "shell",
      cwd: temporaryRoot,
      title: "Automated E2E PTY",
    },
  });
  await api(baseUrl, `/api/sessions/${started.session.id}/input`, {
    method: "POST",
    body: { text: "printf E2E_PTY_OK; exit", submit: true },
  });

  const terminalResult = await waitFor(async () => {
    const eventResponse = await api(
      baseUrl,
      `/api/events?sessionId=${encodeURIComponent(started.session.id)}&limit=200`,
    );
    const output = eventResponse.events
      .filter((event) => event.type === "session.output")
      .map((event) => String(event.data.chunk ?? ""))
      .join("");
    const sessionResponse = await api(
      baseUrl,
      `/api/sessions?machineId=${encodeURIComponent(machine.id)}`,
    );
    const session = sessionResponse.sessions.find(
      (item) => item.id === started.session.id,
    );
    if (!output.includes("E2E_PTY_OK") || session?.state !== "completed")
      return undefined;
    return { output, state: session.state };
  }, "managed PTY output");

  const firstContent = Buffer.from("MOBILE_TO_PC_OK").toString("base64");
  const written = await api(baseUrl, "/api/files/write", {
    method: "POST",
    body: {
      machineId: machine.id,
      root: temporaryRoot,
      path: "mobile.txt",
      contentBase64: firstContent,
    },
  });
  assert(written.status === "written", "new file was not written");
  const received = await api(
    baseUrl,
    `/api/files/read?${new URLSearchParams({ machineId: machine.id, root: temporaryRoot, path: "mobile.txt" })}`,
  );
  assert(
    Buffer.from(received.contentBase64, "base64").toString() ===
      "MOBILE_TO_PC_OK",
    "file read mismatch",
  );

  const overwrite = await api(baseUrl, "/api/files/write", {
    method: "POST",
    body: {
      machineId: machine.id,
      root: temporaryRoot,
      path: "mobile.txt",
      contentBase64: Buffer.from("OVERWRITE_APPROVAL_OK").toString("base64"),
    },
  });
  assert(
    overwrite.status === "approval_required",
    "overwrite did not require approval",
  );
  const resolved = await api(
    baseUrl,
    `/api/approvals/${overwrite.approval.id}/resolve`,
    {
      method: "POST",
      body: { decision: "approve" },
    },
  );
  assert(resolved.status === "approved", "overwrite approval was not applied");

  const finalFile = await api(
    baseUrl,
    `/api/files/read?${new URLSearchParams({ machineId: machine.id, root: temporaryRoot, path: "mobile.txt" })}`,
  );
  assert(
    Buffer.from(finalFile.contentBase64, "base64").toString() ===
      "OVERWRITE_APPROVAL_OK",
    "approved overwrite content mismatch",
  );

  const mobileHtml = await (await fetch(`${baseUrl}/`)).text();
  assert(
    mobileHtml.includes("Agent Console"),
    "relay did not serve the mobile build",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        machine: machine.name,
        terminal: terminalResult.state,
        terminalMarker: terminalResult.output.includes("E2E_PTY_OK"),
        fileRoundTrip: true,
        overwriteApproval: true,
        mobileServed: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(logs.join(""));
  throw error;
} finally {
  await Promise.all(children.reverse().map(stopProcess));
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function startProcess(label, entry, env) {
  const child = spawn(process.execPath, [resolve(workspaceRoot, entry)], {
    cwd: workspaceRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => logs.push(`[${label}] ${chunk}`));
  children.push(child);
  return child;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}

async function api(baseUrl, path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("authorization", `Bearer ${appToken}`);
  if (options.body !== undefined)
    headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(`${response.status} ${payload.error ?? "request failed"}`);
  return payload;
}

async function waitFor(operation, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("Could not allocate port"));
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port),
      );
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
