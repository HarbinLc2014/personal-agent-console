import {
  AppServerMessageSchema,
  type AgentEvent,
  type Approval,
  type Machine,
  type Session,
} from "@agent-console/protocol";

export type StoredMachine = Machine & {
  status: "online" | "offline";
  lastSeen: string;
};

export type FileEntry = {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
};

export type FileListing = {
  root: string;
  path: string;
  entries: FileEntry[];
};

export type FileRead = {
  root: string;
  path: string;
  name: string;
  size: number;
  mimeType: string;
  contentBase64: string;
};

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown };

export class FleetApi {
  constructor(readonly token: string) {}

  machines(): Promise<{ machines: StoredMachine[] }> {
    return this.request("/api/machines");
  }

  sessions(machineId?: string): Promise<{ sessions: Session[] }> {
    const query = machineId
      ? `?machineId=${encodeURIComponent(machineId)}`
      : "";
    return this.request(`/api/sessions${query}`);
  }

  events(sessionId: string): Promise<{ events: AgentEvent[] }> {
    return this.request(
      `/api/events?sessionId=${encodeURIComponent(sessionId)}&limit=1000`,
    );
  }

  approvals(status?: Approval["status"]): Promise<{ approvals: Approval[] }> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.request(`/api/approvals${query}`);
  }

  startSession(input: {
    machineId: string;
    harnessId: string;
    cwd: string;
    title?: string;
    initialPrompt?: string;
    accessMode?: "approval" | "full";
  }): Promise<{ session: Session }> {
    return this.request("/api/sessions", { method: "POST", body: input });
  }

  input(sessionId: string, text: string): Promise<unknown> {
    return this.request(`/api/sessions/${sessionId}/input`, {
      method: "POST",
      body: { text, submit: true },
    });
  }

  interrupt(sessionId: string): Promise<unknown> {
    return this.request(`/api/sessions/${sessionId}/interrupt`, {
      method: "POST",
    });
  }

  stop(sessionId: string): Promise<unknown> {
    return this.request(`/api/sessions/${sessionId}/stop`, { method: "POST" });
  }

  listFiles(machineId: string, root: string, path = ""): Promise<FileListing> {
    const query = new URLSearchParams({ machineId, root, path });
    return this.request(`/api/files?${query}`);
  }

  readFile(machineId: string, root: string, path: string): Promise<FileRead> {
    const query = new URLSearchParams({ machineId, root, path });
    return this.request(`/api/files/read?${query}`);
  }

  writeFile(
    machineId: string,
    root: string,
    path: string,
    contentBase64: string,
  ): Promise<unknown> {
    return this.request("/api/files/write", {
      method: "POST",
      body: { machineId, root, path, contentBase64 },
    });
  }

  resolveApproval(id: string, decision: "approve" | "deny"): Promise<unknown> {
    return this.request(`/api/approvals/${id}/resolve`, {
      method: "POST",
      body: { decision },
    });
  }

  connect(
    onMessage: (
      message: ReturnType<typeof AppServerMessageSchema.parse>,
    ) => void,
    onStatus: (
      status: "connecting" | "online" | "offline" | "unauthorized",
    ) => void,
  ): () => void {
    let closed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let attempts = 0;

    const connect = () => {
      if (closed) return;
      onStatus("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/app`);
      socket.addEventListener("open", () => {
        attempts = 0;
        socket?.send(JSON.stringify({ type: "app.auth", token: this.token }));
      });
      socket.addEventListener("message", (event) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const parsed = AppServerMessageSchema.safeParse(decoded);
        if (!parsed.success) return;
        if (parsed.data.type === "app.auth.result") {
          onStatus(parsed.data.ok ? "online" : "unauthorized");
        }
        onMessage(parsed.data);
      });
      socket.addEventListener("close", (event) => {
        if (closed) return;
        if (event.code === 4401) {
          onStatus("unauthorized");
          return;
        }
        onStatus("offline");
        const delay = Math.min(15_000, 500 * 2 ** attempts++);
        reconnectTimer = window.setTimeout(connect, delay);
      });
      socket.addEventListener("error", () => socket?.close());
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }

  private async request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (options.body !== undefined)
      headers.set("content-type", "application/json");
    const response = await fetch(path, {
      ...options,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (!response.ok)
      throw new Error(payload.error ?? `Request failed (${response.status})`);
    return payload as T;
  }
}
