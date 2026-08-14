import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AgentEventSchema,
  ApprovalSchema,
  MachineSchema,
  SessionSchema,
  type AgentEvent,
  type Approval,
  type Machine,
  type Session,
} from "@agent-console/protocol";

type MachineRow = {
  id: string;
  data: string;
  status: "online" | "offline";
  last_seen: string;
};

type SessionRow = { data: string };
type EventRow = { data: string };
type ApprovalRow = { data: string };

export type StoredMachine = Machine & {
  status: "online" | "offline";
  lastSeen: string;
};

export class RelayStore {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        status TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS sessions_machine_idx ON sessions(machine_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        session_id TEXT,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_session_idx ON events(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, created_at DESC);
    `);
  }

  close(): void {
    this.#db.close();
  }

  upsertMachine(machineInput: Machine): StoredMachine {
    const machine = MachineSchema.parse(machineInput);
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO machines (id, data, status, last_seen)
         VALUES (?, ?, 'online', ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, status = 'online', last_seen = excluded.last_seen`,
      )
      .run(machine.id, JSON.stringify(machine), now);
    return { ...machine, status: "online", lastSeen: now };
  }

  touchMachine(machineId: string): void {
    this.#db
      .prepare(
        "UPDATE machines SET status = 'online', last_seen = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), machineId);
  }

  markMachineOffline(machineId: string): void {
    this.#db
      .prepare("UPDATE machines SET status = 'offline' WHERE id = ?")
      .run(machineId);
  }

  listMachines(): StoredMachine[] {
    const rows = this.#db
      .prepare(
        "SELECT id, data, status, last_seen FROM machines ORDER BY last_seen DESC",
      )
      .all() as unknown as MachineRow[];
    return rows.map((row) => ({
      ...MachineSchema.parse(JSON.parse(row.data)),
      status: row.status,
      lastSeen: row.last_seen,
    }));
  }

  getMachine(machineId: string): StoredMachine | undefined {
    const row = this.#db
      .prepare("SELECT id, data, status, last_seen FROM machines WHERE id = ?")
      .get(machineId) as unknown as MachineRow | undefined;
    if (!row) return undefined;
    return {
      ...MachineSchema.parse(JSON.parse(row.data)),
      status: row.status,
      lastSeen: row.last_seen,
    };
  }

  putSession(sessionInput: Session): Session {
    const session = SessionSchema.parse(sessionInput);
    this.#db
      .prepare(
        `INSERT INTO sessions (id, machine_id, state, created_at, updated_at, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, data = excluded.data`,
      )
      .run(
        session.id,
        session.machineId,
        session.state,
        session.createdAt,
        session.updatedAt,
        JSON.stringify(session),
      );
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    const row = this.#db
      .prepare("SELECT data FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row ? SessionSchema.parse(JSON.parse(row.data)) : undefined;
  }

  listSessions(machineId?: string): Session[] {
    const rows = machineId
      ? (this.#db
          .prepare(
            "SELECT data FROM sessions WHERE machine_id = ? ORDER BY updated_at DESC LIMIT 200",
          )
          .all(machineId) as unknown as SessionRow[])
      : (this.#db
          .prepare(
            "SELECT data FROM sessions ORDER BY updated_at DESC LIMIT 200",
          )
          .all() as unknown as SessionRow[]);
    return rows.map((row) => SessionSchema.parse(JSON.parse(row.data)));
  }

  recordEvent(eventInput: AgentEvent): AgentEvent {
    const event = AgentEventSchema.parse(eventInput);
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO events (id, machine_id, session_id, type, created_at, data) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.id,
        event.machineId,
        event.sessionId,
        event.type,
        event.createdAt,
        JSON.stringify(event),
      );

    if (event.type === "session.created") {
      this.putSession(SessionSchema.parse(event.data.session));
    } else if (event.type === "session.state" && event.sessionId) {
      const existing = this.getSession(event.sessionId);
      if (existing) {
        this.putSession({
          ...existing,
          state: SessionSchema.shape.state.parse(event.data.state),
          updatedAt: event.createdAt,
        });
      }
    } else if (event.type === "approval.requested") {
      this.putApproval(ApprovalSchema.parse(event.data.approval));
    } else if (event.type === "approval.resolved") {
      const approval = ApprovalSchema.parse(event.data.approval);
      this.putApproval(approval);
    }
    return event;
  }

  listEvents(sessionId?: string, limit = 500): AgentEvent[] {
    const boundedLimit = Math.max(1, Math.min(limit, 2_000));
    const rows = sessionId
      ? (this.#db
          .prepare(
            "SELECT data FROM events WHERE session_id = ? ORDER BY created_at ASC LIMIT ?",
          )
          .all(sessionId, boundedLimit) as unknown as EventRow[])
      : (this.#db
          .prepare("SELECT data FROM events ORDER BY created_at DESC LIMIT ?")
          .all(boundedLimit) as unknown as EventRow[]);
    return rows.map((row) => AgentEventSchema.parse(JSON.parse(row.data)));
  }

  putApproval(approvalInput: Approval): Approval {
    const approval = ApprovalSchema.parse(approvalInput);
    this.#db
      .prepare(
        `INSERT INTO approvals (id, machine_id, session_id, status, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      )
      .run(
        approval.id,
        approval.machineId,
        approval.sessionId,
        approval.status,
        approval.createdAt,
        JSON.stringify(approval),
      );
    return approval;
  }

  getApproval(approvalId: string): Approval | undefined {
    const row = this.#db
      .prepare("SELECT data FROM approvals WHERE id = ?")
      .get(approvalId) as ApprovalRow | undefined;
    return row ? ApprovalSchema.parse(JSON.parse(row.data)) : undefined;
  }

  listApprovals(status?: string): Approval[] {
    const rows = status
      ? (this.#db
          .prepare(
            "SELECT data FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 200",
          )
          .all(status) as unknown as ApprovalRow[])
      : (this.#db
          .prepare(
            "SELECT data FROM approvals ORDER BY created_at DESC LIMIT 200",
          )
          .all() as unknown as ApprovalRow[]);
    return rows.map((row) => ApprovalSchema.parse(JSON.parse(row.data)));
  }
}
