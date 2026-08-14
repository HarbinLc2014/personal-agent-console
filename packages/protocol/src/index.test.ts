import { describe, expect, it } from "vitest";
import {
  DaemonToRelaySchema,
  HarnessSchema,
  SessionSchema,
  createAgentEvent,
} from "./index.js";

describe("protocol", () => {
  it("creates and validates an agent event", () => {
    const event = createAgentEvent({
      machineId: "machine-12345678",
      sessionId: null,
      type: "system.notice",
      data: { message: "ready" },
    });

    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      DaemonToRelaySchema.parse({ type: "daemon.event", event }),
    ).toBeTruthy();
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      DaemonToRelaySchema.parse({
        type: "daemon.event",
        event: {
          id: crypto.randomUUID(),
          machineId: "machine-12345678",
          sessionId: null,
          type: "unsafe.unknown",
          createdAt: new Date().toISOString(),
          data: {},
        },
      }),
    ).toThrow();
  });

  it("defaults old harnesses and sessions to approval mode", () => {
    expect(
      HarnessSchema.parse({
        id: "codex",
        label: "Codex",
        command: "codex",
        available: true,
        structuredEvents: false,
      }).fullAccessSupported,
    ).toBe(false);
    expect(
      SessionSchema.parse({
        id: crypto.randomUUID(),
        machineId: "machine-12345678",
        harnessId: "codex",
        cwd: "/workspace",
        title: "Legacy session",
        state: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).accessMode,
    ).toBe("approval");
  });
});
