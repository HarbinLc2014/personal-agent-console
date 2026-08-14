import * as pty from "node-pty";
import {
  SessionSchema,
  createAgentEvent,
  type AgentEvent,
  type Harness,
  type Session,
} from "@agent-console/protocol";
import { PathPolicy } from "./path-policy.js";
import { sanitizedChildEnv } from "./config.js";

type ManagedSession = {
  session: Session;
  process: pty.IPty;
  outputBuffer: string;
  flushTimer?: NodeJS.Timeout;
  stopRequested: boolean;
};

export class SessionManager {
  readonly #sessions = new Map<string, ManagedSession>();

  constructor(
    readonly machineId: string,
    readonly policy: PathPolicy,
    readonly harnesses: Harness[],
    readonly emit: (event: AgentEvent) => void,
  ) {}

  start(sessionInput: unknown, initialPromptInput: unknown) {
    const session = SessionSchema.parse(sessionInput);
    if (session.machineId !== this.machineId)
      throw new Error("Session machine id mismatch");
    if (this.#sessions.has(session.id))
      throw new Error("Session already exists");
    const harness = this.harnesses.find(
      (item) => item.id === session.harnessId && item.available,
    );
    if (!harness) throw new Error("Harness is unavailable");
    const cwd = this.policy.assertDirectory(session.cwd);
    const managed: ManagedSession = {
      session: {
        ...session,
        cwd,
        state: "running",
        updatedAt: new Date().toISOString(),
      },
      process: pty.spawn(harness.command, [], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd,
        env: sanitizedChildEnv(),
      }),
      outputBuffer: "",
      stopRequested: false,
    };
    this.#sessions.set(session.id, managed);
    managed.process.onData((chunk) => this.#bufferOutput(managed, chunk));
    managed.process.onExit(({ exitCode, signal }) => {
      this.#flushOutput(managed);
      const state = managed.stopRequested
        ? "stopped"
        : exitCode === 0
          ? "completed"
          : "failed";
      this.#emitState(managed, state, { exitCode, signal });
      this.#sessions.delete(session.id);
    });
    this.emit(
      createAgentEvent({
        machineId: this.machineId,
        sessionId: session.id,
        type: "session.created",
        data: { session: managed.session },
      }),
    );
    this.#emitState(managed, "running");

    const initialPrompt =
      typeof initialPromptInput === "string" ? initialPromptInput : "";
    if (initialPrompt) {
      setTimeout(() => {
        if (this.#sessions.get(session.id) === managed)
          managed.process.write(`${initialPrompt}\r`);
      }, 150);
    }
    return {
      status: "started",
      sessionId: session.id,
      pid: managed.process.pid,
    };
  }

  input(sessionIdInput: unknown, textInput: unknown, submitInput: unknown) {
    const sessionId = asString(sessionIdInput, "sessionId");
    const managed = this.#required(sessionId);
    const text = asString(textInput, "text");
    managed.process.write(submitInput === false ? text : `${text}\r`);
    return { status: "sent" };
  }

  resize(sessionIdInput: unknown, colsInput: unknown, rowsInput: unknown) {
    const managed = this.#required(asString(sessionIdInput, "sessionId"));
    const cols = boundedInteger(colsInput, 20, 400, "cols");
    const rows = boundedInteger(rowsInput, 5, 200, "rows");
    managed.process.resize(cols, rows);
    return { status: "resized", cols, rows };
  }

  interrupt(sessionIdInput: unknown) {
    this.#required(asString(sessionIdInput, "sessionId")).process.write("\x03");
    return { status: "interrupted" };
  }

  stop(sessionIdInput: unknown) {
    const managed = this.#required(asString(sessionIdInput, "sessionId"));
    managed.stopRequested = true;
    managed.process.kill();
    return { status: "stopping" };
  }

  shutdown(): void {
    for (const managed of this.#sessions.values()) {
      if (managed.flushTimer) clearTimeout(managed.flushTimer);
      managed.stopRequested = true;
      managed.process.kill();
    }
    this.#sessions.clear();
  }

  #required(sessionId: string): ManagedSession {
    const managed = this.#sessions.get(sessionId);
    if (!managed)
      throw new Error("Managed session is not running on this daemon");
    return managed;
  }

  #bufferOutput(managed: ManagedSession, chunk: string): void {
    managed.outputBuffer += chunk;
    if (managed.outputBuffer.length >= 64 * 1024) {
      this.#flushOutput(managed);
      return;
    }
    if (!managed.flushTimer)
      managed.flushTimer = setTimeout(() => this.#flushOutput(managed), 50);
  }

  #flushOutput(managed: ManagedSession): void {
    if (managed.flushTimer) clearTimeout(managed.flushTimer);
    delete managed.flushTimer;
    if (!managed.outputBuffer) return;
    const chunk = managed.outputBuffer;
    managed.outputBuffer = "";
    this.emit(
      createAgentEvent({
        machineId: this.machineId,
        sessionId: managed.session.id,
        type: "session.output",
        data: { stream: "pty", chunk },
      }),
    );
  }

  #emitState(
    managed: ManagedSession,
    state: Session["state"],
    extra: Record<string, unknown> = {},
  ): void {
    managed.session = {
      ...managed.session,
      state,
      updatedAt: new Date().toISOString(),
    };
    this.emit(
      createAgentEvent({
        machineId: this.machineId,
        sessionId: managed.session.id,
        type: "session.state",
        data: { state, ...extra },
      }),
    );
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}
