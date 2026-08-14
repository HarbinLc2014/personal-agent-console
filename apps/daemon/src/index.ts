import { loadConfig } from "./config.js";
import { FileService } from "./file-service.js";
import { PathPolicy } from "./path-policy.js";
import { RelayClient } from "./relay-client.js";
import { SessionManager } from "./session-manager.js";

const config = loadConfig();
const policy = new PathPolicy(config.machine.allowedRoots);
let client: RelayClient;

const sessions = new SessionManager(
  config.machine.id,
  policy,
  config.machine.harnesses,
  (event) => client.emitEvent(event),
);
const files = new FileService(policy, config.machine.id, (event) =>
  client.emitEvent(event),
);

client = new RelayClient(
  config.relayUrl,
  config.daemonToken,
  config.machine,
  async (method, params) => {
    switch (method) {
      case "session.start":
        return sessions.start(params.session, params.initialPrompt);
      case "session.input":
        return sessions.input(params.sessionId, params.text, params.submit);
      case "session.resize":
        return sessions.resize(params.sessionId, params.cols, params.rows);
      case "session.interrupt":
        return sessions.interrupt(params.sessionId);
      case "session.stop":
        return sessions.stop(params.sessionId);
      case "file.list":
        return files.list(params.root, params.path);
      case "file.read":
        return files.read(params.root, params.path);
      case "file.write":
        return files.write(params);
      case "approval.resolve":
        return files.resolveApproval(params.approvalId, params.decision);
    }
  },
);

client.start();
console.log(
  `Agent Console daemon ${config.machine.name} (${config.machine.id}) connecting to ${config.relayUrl}`,
);
console.log(`Allowed roots: ${config.machine.allowedRoots.join(", ")}`);
console.log(
  `Harnesses: ${config.machine.harnesses.map((item) => `${item.label}=${item.available ? "ready" : "missing"}`).join(", ")}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    sessions.shutdown();
    client.close();
    process.exit(0);
  });
}
