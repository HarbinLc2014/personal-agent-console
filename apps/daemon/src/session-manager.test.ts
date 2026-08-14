import { describe, expect, it } from "vitest";
import { harnessLaunchArgs } from "./session-manager.js";

describe("harnessLaunchArgs", () => {
  it("keeps normal sessions in the harness default permission mode", () => {
    expect(harnessLaunchArgs("codex", "approval")).toEqual([]);
    expect(harnessLaunchArgs("claude", "approval")).toEqual([]);
  });

  it("uses the installed harness bypass flags only for full-access sessions", () => {
    expect(harnessLaunchArgs("codex", "full")).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(harnessLaunchArgs("claude", "full")).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });
});
