import { existsSync, realpathSync, statSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

if (process.platform === "darwin") {
  const dependency = realpathSync(resolve("apps/daemon/node_modules/node-pty"));
  const helper = resolve(
    dependency,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  if (!existsSync(helper) || !statSync(helper).isFile()) {
    throw new Error(`node-pty spawn helper is missing: ${helper}`);
  }
  chmodSync(helper, 0o755);
}
