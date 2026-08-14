import { describe, expect, it } from "vitest";
import { DaemonToRelaySchema, createAgentEvent } from "./index.js";

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
});
