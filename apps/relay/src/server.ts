import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { WebSocket, WebSocketServer } from "ws";
import {
  AccessModeSchema,
  AppClientMessageSchema,
  DaemonToRelaySchema,
  RelayToDaemonSchema,
  SessionSchema,
  isoNow,
  type AgentEvent,
  type AppServerMessage,
  type DaemonToRelay,
  type RelayRpc,
} from "@agent-console/protocol";
import { RelayStore } from "./store.js";

const StartSessionBodySchema = z.object({
  machineId: z.string().min(8),
  harnessId: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string().min(1).max(120).optional(),
  initialPrompt: z.string().max(100_000).optional(),
  accessMode: AccessModeSchema.default("approval"),
});

const SessionInputBodySchema = z.object({
  text: z.string().max(100_000),
  submit: z.boolean().default(true),
});
const FileWriteBodySchema = z.object({
  machineId: z.string().min(8),
  root: z.string().min(1),
  path: z.string(),
  contentBase64: z.string().max(14_000_000),
  approvalId: z.string().uuid().optional(),
});
const ApprovalResolveBodySchema = z.object({
  decision: z.enum(["approve", "deny"]),
});

export type RelayServerOptions = {
  host: string;
  port: number;
  appToken: string;
  daemonToken: string;
  stateFile: string;
  rpcTimeoutMs?: number;
  mobileDist?: string;
};

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

export class RelayServer {
  readonly store: RelayStore;
  readonly #options: RelayServerOptions;
  readonly #http = createServer(
    (request, response) => void this.#handleHttp(request, response),
  );
  readonly #daemonWss = new WebSocketServer({ noServer: true });
  readonly #appWss = new WebSocketServer({ noServer: true });
  readonly #daemons = new Map<string, WebSocket>();
  readonly #daemonIds = new WeakMap<WebSocket, string>();
  readonly #authenticatedApps = new WeakSet<WebSocket>();
  readonly #pending = new Map<string, PendingRpc>();

  constructor(options: RelayServerOptions) {
    this.#options = options;
    this.store = new RelayStore(options.stateFile);
    this.#wireWebSockets();
  }

  async listen(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolveListen, reject) => {
      this.#http.once("error", reject);
      this.#http.listen(this.#options.port, this.#options.host, () =>
        resolveListen(),
      );
    });
    const address = this.#http.address();
    if (!address || typeof address === "string")
      throw new Error("Relay did not bind a TCP port");
    return { host: this.#options.host, port: address.port };
  }

  async close(): Promise<void> {
    for (const socket of this.#daemons.values()) socket.close();
    for (const client of this.#appWss.clients) client.close();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Relay is shutting down"));
    }
    this.#pending.clear();
    await new Promise<void>((resolveClose, reject) =>
      this.#http.close((error) => (error ? reject(error) : resolveClose())),
    );
    this.store.close();
  }

  async callDaemon(
    machineId: string,
    method: RelayRpc["method"],
    params: Record<string, unknown>,
  ) {
    const socket = this.#daemons.get(machineId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new HttpError(409, `Machine ${machineId} is offline`);
    }
    const requestId = crypto.randomUUID();
    const message = RelayToDaemonSchema.parse({
      type: "relay.rpc",
      requestId,
      method,
      params,
    });
    const timeout = this.#options.rpcTimeoutMs ?? 20_000;
    return await new Promise<unknown>((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        rejectRpc(new HttpError(504, `Daemon RPC timed out: ${method}`));
      }, timeout);
      this.#pending.set(requestId, {
        resolve: resolveRpc,
        reject: rejectRpc,
        timer,
      });
      socket.send(JSON.stringify(message));
    });
  }

  #wireWebSockets(): void {
    this.#http.on("upgrade", (request, socket, head) => {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      if (url.pathname === "/ws/daemon") {
        const authorization = request.headers.authorization;
        if (authorization !== `Bearer ${this.#options.daemonToken}`) {
          socket.write(
            "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n",
          );
          socket.destroy();
          return;
        }
        this.#daemonWss.handleUpgrade(request, socket, head, (webSocket) => {
          this.#daemonWss.emit("connection", webSocket, request);
        });
        return;
      }
      if (url.pathname === "/ws/app") {
        this.#appWss.handleUpgrade(request, socket, head, (webSocket) => {
          this.#appWss.emit("connection", webSocket, request);
        });
        return;
      }
      socket.destroy();
    });

    this.#daemonWss.on("connection", (socket) => {
      const helloTimer = setTimeout(
        () => socket.close(4408, "hello timeout"),
        5_000,
      );
      socket.on("message", (raw) => {
        let message: DaemonToRelay;
        try {
          message = DaemonToRelaySchema.parse(JSON.parse(raw.toString()));
        } catch {
          socket.close(4400, "invalid daemon message");
          return;
        }
        if (message.type === "daemon.hello") {
          clearTimeout(helloTimer);
          const previous = this.#daemons.get(message.machine.id);
          if (previous && previous !== socket)
            previous.close(4409, "replaced by new connection");
          this.#daemons.set(message.machine.id, socket);
          this.#daemonIds.set(socket, message.machine.id);
          this.store.upsertMachine(message.machine);
          this.#broadcast({
            type: "app.machine.status",
            machineId: message.machine.id,
            status: "online",
            at: isoNow(),
          });
          return;
        }
        const machineId = this.#daemonIds.get(socket);
        if (!machineId) {
          socket.close(4401, "hello required");
          return;
        }
        if (message.type === "daemon.heartbeat") {
          if (message.machineId === machineId)
            this.store.touchMachine(machineId);
        } else if (message.type === "daemon.event") {
          if (message.event.machineId !== machineId) {
            socket.close(4403, "machine mismatch");
            return;
          }
          const event = this.store.recordEvent(message.event);
          this.#broadcast({ type: "app.event", event });
        } else if (message.type === "daemon.rpc.result") {
          this.#finishRpc(message);
        }
      });
      socket.on("close", () => {
        clearTimeout(helloTimer);
        const machineId = this.#daemonIds.get(socket);
        if (!machineId || this.#daemons.get(machineId) !== socket) return;
        this.#daemons.delete(machineId);
        this.store.markMachineOffline(machineId);
        this.#broadcast({
          type: "app.machine.status",
          machineId,
          status: "offline",
          at: isoNow(),
        });
      });
    });

    this.#appWss.on("connection", (socket) => {
      const authTimer = setTimeout(
        () => socket.close(4401, "authentication timeout"),
        5_000,
      );
      socket.on("message", (raw) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(raw.toString());
        } catch {
          socket.close(4400, "invalid app message");
          return;
        }
        const parsed = AppClientMessageSchema.safeParse(decoded);
        if (!parsed.success) {
          socket.close(4400, "invalid app message");
          return;
        }
        if (parsed.data.type === "app.auth") {
          const ok = timingSafeEqual(parsed.data.token, this.#options.appToken);
          socket.send(
            JSON.stringify({
              type: "app.auth.result",
              ok,
            } satisfies AppServerMessage),
          );
          if (!ok) {
            socket.close(4401, "unauthorized");
            return;
          }
          clearTimeout(authTimer);
          this.#authenticatedApps.add(socket);
        } else if (this.#authenticatedApps.has(socket)) {
          socket.send(
            JSON.stringify({ type: "app.pong" } satisfies AppServerMessage),
          );
        }
      });
      socket.on("close", () => clearTimeout(authTimer));
    });
  }

  #finishRpc(
    message: Extract<DaemonToRelay, { type: "daemon.rpc.result" }>,
  ): void {
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else
      pending.reject(new HttpError(422, message.error ?? "Daemon RPC failed"));
  }

  #broadcast(message: AppServerMessage): void {
    const encoded = JSON.stringify(message);
    for (const client of this.#appWss.clients) {
      if (
        client.readyState === WebSocket.OPEN &&
        this.#authenticatedApps.has(client)
      )
        client.send(encoded);
    }
  }

  async #handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      if (url.pathname === "/api/health") {
        return json(response, 200, {
          ok: true,
          service: "agent-console-relay",
          at: isoNow(),
        });
      }
      if (url.pathname.startsWith("/api/")) {
        this.#requireAppAuth(request);
        await this.#handleApi(request, response, url);
        return;
      }
      this.#serveMobile(response, url.pathname);
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : 500;
      const message =
        error instanceof z.ZodError
          ? error.issues
              .map(
                (issue) =>
                  `${issue.path.join(".") || "body"}: ${issue.message}`,
              )
              .join("; ")
          : error instanceof Error
            ? error.message
            : "Unknown error";
      json(response, status, { error: message });
    }
  }

  async #handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/machines") {
      return json(response, 200, { machines: this.store.listMachines() });
    }
    if (method === "GET" && url.pathname === "/api/sessions") {
      const machineId = url.searchParams.get("machineId") ?? undefined;
      return json(response, 200, {
        sessions: this.store.listSessions(machineId),
      });
    }
    if (method === "GET" && url.pathname === "/api/events") {
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const limit = Number(url.searchParams.get("limit") ?? "500");
      return json(response, 200, {
        events: this.store.listEvents(sessionId, limit),
      });
    }
    if (method === "GET" && url.pathname === "/api/approvals") {
      return json(response, 200, {
        approvals: this.store.listApprovals(
          url.searchParams.get("status") ?? undefined,
        ),
      });
    }
    if (method === "POST" && url.pathname === "/api/sessions") {
      const body = StartSessionBodySchema.parse(await readJson(request));
      const machine = this.store.getMachine(body.machineId);
      if (!machine || machine.status !== "online")
        throw new HttpError(409, "Machine is offline");
      const harness = machine.harnesses.find(
        (item) => item.id === body.harnessId && item.available,
      );
      if (!harness)
        throw new HttpError(400, "Harness is not available on this machine");
      if (body.accessMode === "full" && !harness.fullAccessSupported) {
        throw new HttpError(
          400,
          "Harness does not support full-access sessions",
        );
      }
      const now = isoNow();
      const session = SessionSchema.parse({
        id: crypto.randomUUID(),
        machineId: body.machineId,
        harnessId: body.harnessId,
        cwd: body.cwd,
        title:
          body.title ??
          body.initialPrompt?.slice(0, 80) ??
          `${harness.label} session`,
        state: "starting",
        accessMode: body.accessMode,
        createdAt: now,
        updatedAt: now,
      });
      this.store.putSession(session);
      try {
        await this.callDaemon(body.machineId, "session.start", {
          session,
          initialPrompt: body.initialPrompt ?? "",
        });
      } catch (error) {
        this.store.putSession({
          ...session,
          state: "failed",
          updatedAt: isoNow(),
        });
        throw error;
      }
      return json(response, 201, { session });
    }

    const sessionAction = url.pathname.match(
      /^\/api\/sessions\/([0-9a-f-]+)\/(input|interrupt|stop)$/,
    );
    if (method === "POST" && sessionAction) {
      const sessionId = sessionAction[1];
      const action = sessionAction[2];
      if (!sessionId || !action)
        throw new HttpError(400, "Invalid session action");
      const session = this.store.getSession(sessionId);
      if (!session) throw new HttpError(404, "Session not found");
      const result =
        action === "input"
          ? await this.callDaemon(session.machineId, "session.input", {
              sessionId,
              ...SessionInputBodySchema.parse(await readJson(request)),
            })
          : await this.callDaemon(
              session.machineId,
              `session.${action}` as "session.interrupt" | "session.stop",
              {
                sessionId,
              },
            );
      return json(response, 200, { result });
    }

    if (method === "GET" && url.pathname === "/api/files") {
      const machineId = requiredParam(url, "machineId");
      const result = await this.callDaemon(machineId, "file.list", {
        root: requiredParam(url, "root"),
        path: url.searchParams.get("path") ?? "",
      });
      return json(response, 200, result);
    }
    if (method === "GET" && url.pathname === "/api/files/read") {
      const machineId = requiredParam(url, "machineId");
      const result = await this.callDaemon(machineId, "file.read", {
        root: requiredParam(url, "root"),
        path: requiredParam(url, "path"),
      });
      return json(response, 200, result);
    }
    if (method === "POST" && url.pathname === "/api/files/write") {
      const body = FileWriteBodySchema.parse(
        await readJson(request, 15_000_000),
      );
      const result = await this.callDaemon(body.machineId, "file.write", body);
      return json(response, 200, result);
    }

    const approvalAction = url.pathname.match(
      /^\/api\/approvals\/([0-9a-f-]+)\/resolve$/,
    );
    if (method === "POST" && approvalAction?.[1]) {
      const approval = this.store.getApproval(approvalAction[1]);
      if (!approval) throw new HttpError(404, "Approval not found");
      const body = ApprovalResolveBodySchema.parse(await readJson(request));
      const result = await this.callDaemon(
        approval.machineId,
        "approval.resolve",
        {
          approvalId: approval.id,
          decision: body.decision,
        },
      );
      return json(response, 200, result);
    }
    throw new HttpError(404, "API route not found");
  }

  #requireAppAuth(request: IncomingMessage): void {
    const received =
      request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!timingSafeEqual(received, this.#options.appToken))
      throw new HttpError(401, "Unauthorized");
  }

  #serveMobile(response: ServerResponse, requestPath: string): void {
    const mobileDist = this.#options.mobileDist;
    if (!mobileDist || !existsSync(mobileDist)) {
      throw new HttpError(
        404,
        "Mobile build not found. Run pnpm --filter @agent-console/mobile build.",
      );
    }
    const cleanPath = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, "");
    let file = resolve(mobileDist, `.${cleanPath}`);
    const delta = relative(resolve(mobileDist), file);
    if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
      throw new HttpError(403, "Invalid asset path");
    }
    if (!existsSync(file) || statSync(file).isDirectory())
      file = join(mobileDist, "index.html");
    response.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control":
        extname(file) === ".html"
          ? "no-store"
          : "public, max-age=31536000, immutable",
    });
    createReadStream(file).pipe(response);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && nodeTimingSafeEqual(a, b);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 1_000_000,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new HttpError(400, `Missing query parameter: ${name}`);
  return value;
}

export function defaultMobileDist(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return resolve(here, "../../mobile/dist");
}
