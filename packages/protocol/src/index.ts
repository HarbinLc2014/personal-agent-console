import { z } from "zod";

export const SessionStateSchema = z.enum([
  "starting",
  "running",
  "waiting",
  "stopped",
  "completed",
  "failed",
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const AccessModeSchema = z.enum(["approval", "full"]);
export type AccessMode = z.infer<typeof AccessModeSchema>;

export const HarnessSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  command: z.string().min(1),
  available: z.boolean(),
  structuredEvents: z.boolean(),
  fullAccessSupported: z.boolean().default(false),
});
export type Harness = z.infer<typeof HarnessSchema>;

export const MachineSchema = z.object({
  id: z.string().min(8),
  name: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  daemonVersion: z.string().min(1),
  allowedRoots: z.array(z.string().min(1)),
  harnesses: z.array(HarnessSchema),
});
export type Machine = z.infer<typeof MachineSchema>;

export const SessionSchema = z.object({
  id: z.string().uuid(),
  machineId: z.string().min(8),
  harnessId: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string().min(1),
  state: SessionStateSchema,
  accessMode: AccessModeSchema.default("approval"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Session = z.infer<typeof SessionSchema>;

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
]);
export const ApprovalRiskSchema = z.enum(["low", "medium", "high"]);

export const ApprovalSchema = z.object({
  id: z.string().uuid(),
  machineId: z.string().min(8),
  sessionId: z.string().uuid().nullable(),
  kind: z.enum(["tool", "file-overwrite", "file-delete", "command"]),
  title: z.string().min(1),
  description: z.string().min(1),
  risk: ApprovalRiskSchema,
  status: ApprovalStatusSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const AgentEventTypeSchema = z.enum([
  "session.created",
  "session.output",
  "session.state",
  "tool.call.started",
  "tool.call.finished",
  "approval.requested",
  "approval.resolved",
  "file.changed",
  "system.notice",
]);

export const AgentEventSchema = z.object({
  id: z.string().uuid(),
  machineId: z.string().min(8),
  sessionId: z.string().uuid().nullable(),
  type: AgentEventTypeSchema,
  createdAt: z.string().datetime(),
  data: z.record(z.string(), z.unknown()),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const FileEntrySchema = z.object({
  name: z.string(),
  relativePath: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number().nonnegative(),
  modifiedAt: z.string().datetime(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const RpcMethodSchema = z.enum([
  "session.start",
  "session.input",
  "session.resize",
  "session.interrupt",
  "session.stop",
  "file.list",
  "file.read",
  "file.write",
  "approval.resolve",
]);
export type RpcMethod = z.infer<typeof RpcMethodSchema>;

export const RelayRpcSchema = z.object({
  type: z.literal("relay.rpc"),
  requestId: z.string().uuid(),
  method: RpcMethodSchema,
  params: z.record(z.string(), z.unknown()),
});
export type RelayRpc = z.infer<typeof RelayRpcSchema>;

export const RelayToDaemonSchema = z.discriminatedUnion("type", [
  RelayRpcSchema,
  z.object({ type: z.literal("relay.ping"), at: z.string().datetime() }),
]);
export type RelayToDaemon = z.infer<typeof RelayToDaemonSchema>;

export const DaemonToRelaySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daemon.hello"), machine: MachineSchema }),
  z.object({
    type: z.literal("daemon.heartbeat"),
    machineId: z.string().min(8),
    at: z.string().datetime(),
  }),
  z.object({ type: z.literal("daemon.event"), event: AgentEventSchema }),
  z.object({
    type: z.literal("daemon.rpc.result"),
    requestId: z.string().uuid(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
]);
export type DaemonToRelay = z.infer<typeof DaemonToRelaySchema>;

export const AppClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("app.auth"), token: z.string().min(1) }),
  z.object({ type: z.literal("app.ping") }),
]);
export type AppClientMessage = z.infer<typeof AppClientMessageSchema>;

export const AppServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("app.auth.result"), ok: z.boolean() }),
  z.object({ type: z.literal("app.event"), event: AgentEventSchema }),
  z.object({
    type: z.literal("app.machine.status"),
    machineId: z.string().min(8),
    status: z.enum(["online", "offline"]),
    at: z.string().datetime(),
  }),
  z.object({ type: z.literal("app.pong") }),
]);
export type AppServerMessage = z.infer<typeof AppServerMessageSchema>;

export function isoNow(): string {
  return new Date().toISOString();
}

export function createAgentEvent(
  input: Omit<AgentEvent, "id" | "createdAt"> &
    Partial<Pick<AgentEvent, "id" | "createdAt">>,
): AgentEvent {
  return AgentEventSchema.parse({
    ...input,
    id: input.id ?? crypto.randomUUID(),
    createdAt: input.createdAt ?? isoNow(),
  });
}
