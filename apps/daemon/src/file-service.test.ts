import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent-console/protocol";
import { FileService } from "./file-service.js";
import { PathPolicy } from "./path-policy.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("FileService", () => {
  it("writes a new file and requires approval before overwrite", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-files-"));
    tempDirs.push(root);
    const events: AgentEvent[] = [];
    const service = new FileService(
      new PathPolicy([root]),
      "machine-12345678",
      (event) => events.push(event),
    );
    const first = service.write({
      root,
      path: "note.txt",
      contentBase64: Buffer.from("first").toString("base64"),
    });
    expect(first).toMatchObject({ status: "written", path: "note.txt" });

    const second = service.write({
      root,
      path: "note.txt",
      contentBase64: Buffer.from("second").toString("base64"),
    }) as { status: string; approval: { id: string } };
    expect(second.status).toBe("approval_required");
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("first");

    const result = service.resolveApproval(second.approval.id, "approve");
    expect(result).toMatchObject({ status: "approved" });
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("second");
    expect(events.map((event) => event.type)).toEqual([
      "file.changed",
      "approval.requested",
      "file.changed",
      "approval.resolved",
    ]);
  });

  it("denies an overwrite without changing the file", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-files-"));
    tempDirs.push(root);
    writeFileSync(join(root, "note.txt"), "original");
    const service = new FileService(
      new PathPolicy([root]),
      "machine-12345678",
      () => {},
    );
    const pending = service.write({
      root,
      path: "note.txt",
      contentBase64: Buffer.from("replacement").toString("base64"),
    }) as { approval: { id: string } };

    expect(service.resolveApproval(pending.approval.id, "deny")).toMatchObject({
      status: "denied",
    });
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("original");
  });

  it("expires an approval when the target changes before resolution", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-files-"));
    tempDirs.push(root);
    const events: AgentEvent[] = [];
    writeFileSync(join(root, "note.txt"), "original");
    const service = new FileService(
      new PathPolicy([root]),
      "machine-12345678",
      (event) => events.push(event),
    );
    const pending = service.write({
      root,
      path: "note.txt",
      contentBase64: Buffer.from("mobile replacement").toString("base64"),
    }) as { approval: { id: string } };

    writeFileSync(join(root, "note.txt"), "changed somewhere else");
    expect(
      service.resolveApproval(pending.approval.id, "approve"),
    ).toMatchObject({
      status: "expired",
      reason: "Target changed after approval was requested",
    });
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe(
      "changed somewhere else",
    );
    expect(events.at(-1)?.type).toBe("approval.resolved");
  });
});
