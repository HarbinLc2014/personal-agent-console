import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathPolicy } from "./path-policy.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("PathPolicy", () => {
  it("allows paths inside a root and rejects lexical traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-root-"));
    tempDirs.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "export {}\n");
    const policy = new PathPolicy([root]);

    expect(policy.resolveExisting(root, "src/app.ts")).toBe(
      realpathSync(join(root, "src/app.ts")),
    );
    expect(() => policy.resolveExisting(root, "../outside.txt")).toThrow(
      /escapes/,
    );
  });

  it("rejects a symlink that escapes its root", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-root-"));
    const outside = mkdtempSync(join(tmpdir(), "agent-outside-"));
    tempDirs.push(root, outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "linked"));
    const policy = new PathPolicy([root]);

    expect(() => policy.resolveExisting(root, "linked/secret.txt")).toThrow(
      /escapes/,
    );
  });
});
