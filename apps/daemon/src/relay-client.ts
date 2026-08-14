import { WebSocket } from "ws";
import {
  RelayToDaemonSchema,
  type AgentEvent,
  type DaemonToRelay,
  type Machine,
  type RelayRpc,
} from "@agent-console/protocol";

export type RpcHandler = (
  method: RelayRpc["method"],
  params: Record<string, unknown>,
) => Promise<unknown>;

export class RelayClient {
  readonly #queue: DaemonToRelay[] = [];
  #socket?: WebSocket;
  #heartbeat: NodeJS.Timeout | undefined;
  #reconnect?: NodeJS.Timeout;
  #attempt = 0;
  #closed = false;

  constructor(
    readonly relayUrl: string,
    readonly daemonToken: string,
    readonly machine: Machine,
    readonly handleRpc: RpcHandler,
  ) {}

  start(): void {
    this.#connect();
  }

  emitEvent(event: AgentEvent): void {
    this.#sendOrQueue({ type: "daemon.event", event });
  }

  close(): void {
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#socket?.close();
  }

  #connect(): void {
    if (this.#closed) return;
    const socket = new WebSocket(this.relayUrl, {
      headers: { authorization: `Bearer ${this.daemonToken}` },
    });
    this.#socket = socket;
    socket.on("open", () => {
      this.#attempt = 0;
      socket.send(
        JSON.stringify({
          type: "daemon.hello",
          machine: this.machine,
        } satisfies DaemonToRelay),
      );
      this.#flushQueue();
      this.#heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "daemon.heartbeat",
              machineId: this.machine.id,
              at: new Date().toISOString(),
            } satisfies DaemonToRelay),
          );
        }
      }, 15_000);
    });
    socket.on("message", (raw) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const parsed = RelayToDaemonSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.type !== "relay.rpc") return;
      void this.#runRpc(parsed.data);
    });
    socket.on("close", () => this.#scheduleReconnect(socket));
    socket.on("error", () => {
      // The close event owns reconnect scheduling.
    });
  }

  async #runRpc(request: RelayRpc): Promise<void> {
    try {
      const result = await this.handleRpc(request.method, request.params);
      this.#sendOrQueue({
        type: "daemon.rpc.result",
        requestId: request.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      this.#sendOrQueue({
        type: "daemon.rpc.result",
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : "Unknown daemon error",
      });
    }
  }

  #sendOrQueue(message: DaemonToRelay): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message));
      return;
    }
    this.#queue.push(message);
    if (this.#queue.length > 10_000) this.#queue.shift();
  }

  #flushQueue(): void {
    while (this.#queue.length && this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(this.#queue.shift()));
    }
  }

  #scheduleReconnect(socket: WebSocket): void {
    if (this.#socket !== socket || this.#closed) return;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    const delay = Math.min(30_000, 500 * 2 ** this.#attempt++);
    this.#reconnect = setTimeout(() => this.#connect(), delay);
  }
}
