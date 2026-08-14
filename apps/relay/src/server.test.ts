import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RelayServer } from "./server.js";

const servers: RelayServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("relay HTTP", () => {
  it("serves health and rejects an unauthenticated fleet request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-console-relay-"));
    tempDirs.push(dir);
    const server = new RelayServer({
      host: "127.0.0.1",
      port: 0,
      appToken: "app-secret",
      daemonToken: "daemon-secret",
      stateFile: join(dir, "state.sqlite"),
    });
    servers.push(server);
    const address = await server.listen();

    const health = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      service: "agent-console-relay",
    });

    const denied = await fetch(`http://127.0.0.1:${address.port}/api/machines`);
    expect(denied.status).toBe(401);

    const accepted = await fetch(
      `http://127.0.0.1:${address.port}/api/machines`,
      {
        headers: { authorization: "Bearer app-secret" },
      },
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ machines: [] });
  });
});
