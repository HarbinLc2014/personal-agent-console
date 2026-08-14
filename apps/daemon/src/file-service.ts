import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import {
  ApprovalSchema,
  createAgentEvent,
  isoNow,
  type AgentEvent,
  type Approval,
  type FileEntry,
} from "@agent-console/protocol";
import { PathPolicy } from "./path-policy.js";

type PendingOverwrite = {
  approval: Approval;
  target: string;
  root: string;
  content: Buffer;
  expectedSize: number;
  expectedMtimeMs: number;
};

export class FileService {
  readonly #pending = new Map<string, PendingOverwrite>();

  constructor(
    readonly policy: PathPolicy,
    readonly machineId: string,
    readonly emit: (event: AgentEvent) => void,
    readonly maxFileBytes = 10 * 1024 * 1024,
  ) {}

  list(
    rootInput: unknown,
    pathInput: unknown,
  ): { root: string; path: string; entries: FileEntry[] } {
    const root = this.policy.assertRoot(asString(rootInput, "root"));
    const directory = this.policy.resolveExisting(
      root,
      asString(pathInput ?? "", "path"),
    );
    if (!statSync(directory).isDirectory())
      throw new Error("Path is not a directory");
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry): FileEntry => {
        const absolute = join(directory, entry.name);
        const stat = lstatSync(absolute);
        return {
          name: entry.name,
          relativePath: relative(root, absolute),
          kind: entry.isDirectory() ? "directory" : "file",
          size: entry.isFile() ? stat.size : 0,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) =>
        a.kind === b.kind
          ? a.name.localeCompare(b.name)
          : a.kind === "directory"
            ? -1
            : 1,
      );
    return { root, path: relative(root, directory), entries };
  }

  read(rootInput: unknown, pathInput: unknown) {
    const root = this.policy.assertRoot(asString(rootInput, "root"));
    const file = this.policy.resolveExisting(root, asString(pathInput, "path"));
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error("Path is not a file");
    if (stat.size > this.maxFileBytes)
      throw new Error(`File exceeds ${this.maxFileBytes} byte limit`);
    return {
      root,
      path: relative(root, file),
      name: basename(file),
      size: stat.size,
      mimeType: mimeType(file),
      contentBase64: readFileSync(file).toString("base64"),
    };
  }

  write(params: Record<string, unknown>) {
    const root = this.policy.assertRoot(asString(params.root, "root"));
    const target = this.policy.resolveForWrite(
      root,
      asString(params.path, "path"),
    );
    const content = Buffer.from(
      asString(params.contentBase64, "contentBase64"),
      "base64",
    );
    if (content.length > this.maxFileBytes)
      throw new Error(`File exceeds ${this.maxFileBytes} byte limit`);

    if (existsSync(target)) {
      const stat = statSync(target);
      if (!stat.isFile())
        throw new Error("Only regular files can be overwritten");
      const now = Date.now();
      const approval = ApprovalSchema.parse({
        id: randomUUID(),
        machineId: this.machineId,
        sessionId: null,
        kind: "file-overwrite",
        title: `Overwrite ${basename(target)}`,
        description: `Replace ${relative(root, target)} with ${content.length} bytes uploaded from the mobile console.`,
        risk: "medium",
        status: "pending",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 5 * 60_000).toISOString(),
      });
      this.#pending.set(approval.id, {
        approval,
        target,
        root,
        content,
        expectedSize: stat.size,
        expectedMtimeMs: stat.mtimeMs,
      });
      this.emit(
        createAgentEvent({
          machineId: this.machineId,
          sessionId: null,
          type: "approval.requested",
          data: { approval },
        }),
      );
      return { status: "approval_required", approval };
    }

    writeFileSync(target, content, { flag: "wx", mode: 0o600 });
    this.#emitFileChanged(root, target, "created");
    return {
      status: "written",
      path: relative(root, target),
      size: content.length,
    };
  }

  resolveApproval(approvalIdInput: unknown, decisionInput: unknown) {
    const approvalId = asString(approvalIdInput, "approvalId");
    const decision = asString(decisionInput, "decision");
    if (decision !== "approve" && decision !== "deny")
      throw new Error("Invalid approval decision");
    const pending = this.#pending.get(approvalId);
    if (!pending)
      throw new Error("Approval is missing, expired, or already resolved");

    let status: Approval["status"] =
      decision === "approve" ? "approved" : "denied";
    let reason: string | undefined;
    if (Date.now() > Date.parse(pending.approval.expiresAt)) status = "expired";
    if (status === "approved") {
      let current;
      try {
        current = statSync(pending.target);
      } catch {
        status = "expired";
        reason = "Target no longer exists";
      }
      if (
        current &&
        (current.size !== pending.expectedSize ||
          current.mtimeMs !== pending.expectedMtimeMs)
      ) {
        status = "expired";
        reason = "Target changed after approval was requested";
      }
      if (status === "approved" && current) {
        const temporary = join(
          dirname(pending.target),
          `.${basename(pending.target)}.${randomUUID()}.tmp`,
        );
        try {
          writeFileSync(temporary, pending.content, {
            flag: "wx",
            mode: current.mode,
          });
          renameSync(temporary, pending.target);
        } finally {
          if (existsSync(temporary)) unlinkSync(temporary);
        }
        this.#emitFileChanged(pending.root, pending.target, "overwritten");
      }
    }

    this.#pending.delete(approvalId);
    const approval = ApprovalSchema.parse({ ...pending.approval, status });
    this.emit(
      createAgentEvent({
        machineId: this.machineId,
        sessionId: null,
        type: "approval.resolved",
        data: { approval },
      }),
    );
    return { status, approval, ...(reason ? { reason } : {}) };
  }

  #emitFileChanged(root: string, target: string, operation: string): void {
    this.emit(
      createAgentEvent({
        machineId: this.machineId,
        sessionId: null,
        type: "file.changed",
        data: { root, path: relative(root, target), operation, at: isoNow() },
      }),
    );
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function mimeType(file: string): string {
  const extension = extname(file).toLowerCase();
  return (
    {
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".json": "application/json",
      ".js": "text/javascript",
      ".ts": "text/typescript",
      ".tsx": "text/typescript",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".pdf": "application/pdf",
      ".zip": "application/zip",
    }[extension] ?? "application/octet-stream"
  );
}
