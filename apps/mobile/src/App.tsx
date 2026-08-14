import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { AgentEvent, Approval, Session } from "@agent-console/protocol";
import {
  FleetApi,
  type FileEntry,
  type FileListing,
  type StoredMachine,
} from "./api";

type Tab = "sessions" | "files" | "approvals";
type ConnectionStatus = "connecting" | "online" | "offline" | "unauthorized";

const TOKEN_KEY = "personal-agent-console-token";

export function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem(TOKEN_KEY) ?? "dev-app-token",
  );
  const [tokenDraft, setTokenDraft] = useState(token);
  const [showConnection, setShowConnection] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [tab, setTab] = useState<Tab>("sessions");
  const [machines, setMachines] = useState<StoredMachine[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const api = useMemo(() => new FleetApi(token), [token]);

  const selectedMachine = machines.find(
    (machine) => machine.id === selectedMachineId,
  );
  const selectedSession = sessions.find(
    (session) => session.id === selectedSessionId,
  );
  const pendingCount = approvals.filter(
    (approval) => approval.status === "pending",
  ).length;

  const refreshMachines = useCallback(async () => {
    const result = await api.machines();
    setMachines(result.machines);
    setSelectedMachineId((current) =>
      current && result.machines.some((machine) => machine.id === current)
        ? current
        : (result.machines.find((machine) => machine.status === "online")?.id ??
          result.machines[0]?.id ??
          ""),
    );
  }, [api]);

  const refreshSessions = useCallback(async () => {
    if (!selectedMachineId) {
      setSessions([]);
      return;
    }
    const result = await api.sessions(selectedMachineId);
    setSessions(result.sessions);
    setSelectedSessionId((current) =>
      current && result.sessions.some((session) => session.id === current)
        ? current
        : (result.sessions[0]?.id ?? ""),
    );
  }, [api, selectedMachineId]);

  const refreshApprovals = useCallback(async () => {
    const result = await api.approvals();
    setApprovals(result.approvals);
  }, [api]);

  const run = useCallback(async (operation: () => Promise<void>) => {
    setError("");
    try {
      await operation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败");
    }
  }, []);

  useEffect(() => {
    void run(async () => {
      await Promise.all([refreshMachines(), refreshApprovals()]);
    });
  }, [refreshApprovals, refreshMachines, run]);

  useEffect(() => {
    void run(refreshSessions);
  }, [refreshSessions, run]);

  useEffect(() => {
    if (!selectedSessionId) {
      setEvents([]);
      return;
    }
    void run(async () =>
      setEvents((await api.events(selectedSessionId)).events),
    );
  }, [api, run, selectedSessionId]);

  useEffect(
    () =>
      api.connect((message) => {
        if (message.type === "app.event") {
          if (message.event.sessionId === selectedSessionId) {
            setEvents((current) =>
              current.some((event) => event.id === message.event.id)
                ? current
                : [...current, message.event],
            );
          }
          if (message.event.type.startsWith("session.")) void refreshSessions();
          if (message.event.type.startsWith("approval."))
            void refreshApprovals();
          if (message.event.type === "file.changed")
            setNotice("文件状态已更新");
        } else if (message.type === "app.machine.status") {
          setMachines((current) =>
            current.map((machine) =>
              machine.id === message.machineId
                ? { ...machine, status: message.status, lastSeen: message.at }
                : machine,
            ),
          );
        }
      }, setConnection),
    [api, refreshApprovals, refreshSessions, selectedSessionId],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function saveToken(event: FormEvent) {
    event.preventDefault();
    const next = tokenDraft.trim();
    if (!next) return;
    localStorage.setItem(TOKEN_KEY, next);
    setToken(next);
    setShowConnection(false);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            A/
          </span>
          <div>
            <p className="eyebrow">PRIVATE FLEET</p>
            <h1>Agent Console</h1>
          </div>
        </div>
        <button
          className="connection-button"
          onClick={() => setShowConnection((value) => !value)}
        >
          <span className={`status-dot ${connection}`} />
          {connectionLabel(connection)}
        </button>
      </header>

      {showConnection || connection === "unauthorized" ? (
        <form className="connection-panel" onSubmit={saveToken}>
          <div>
            <strong>
              {connection === "unauthorized" ? "访问令牌无效" : "Relay 连接"}
            </strong>
            <p>令牌只保存在这台手机的浏览器中。</p>
          </div>
          <label>
            App token
            <input
              type="password"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          <button className="primary compact" type="submit">
            重新连接
          </button>
        </form>
      ) : null}

      {error ? (
        <button className="alert error" onClick={() => setError("")}>
          <span>{error}</span>
          <span>×</span>
        </button>
      ) : null}
      {notice ? <div className="alert notice">{notice}</div> : null}

      <section className="fleet-strip" aria-label="电脑列表">
        {machines.length ? (
          machines.map((machine) => (
            <button
              key={machine.id}
              className={`machine-pill ${machine.id === selectedMachineId ? "selected" : ""}`}
              onClick={() => setSelectedMachineId(machine.id)}
            >
              <span
                className={`machine-glyph ${machine.status}`}
                aria-hidden="true"
              />
              <span>
                <strong>{machine.name}</strong>
                <small>
                  {machine.platform} ·{" "}
                  {machine.status === "online" ? "在线" : "离线"}
                </small>
              </span>
            </button>
          ))
        ) : (
          <div className="empty-inline">
            <span className="pulse-ring" />
            等待本机 daemon 连接…
          </div>
        )}
      </section>

      <main>
        {tab === "sessions" ? (
          <SessionsView
            api={api}
            machine={selectedMachine}
            sessions={sessions}
            selectedSession={selectedSession}
            events={events}
            onSelect={setSelectedSessionId}
            onChanged={refreshSessions}
            run={run}
            notify={setNotice}
          />
        ) : null}
        {tab === "files" ? (
          <FilesView
            api={api}
            machine={selectedMachine}
            run={run}
            notify={setNotice}
          />
        ) : null}
        {tab === "approvals" ? (
          <ApprovalsView
            api={api}
            approvals={approvals}
            onChanged={refreshApprovals}
            run={run}
            notify={setNotice}
          />
        ) : null}
      </main>

      <nav className="bottom-nav" aria-label="主导航">
        <NavButton
          active={tab === "sessions"}
          label="会话"
          glyph=">_"
          onClick={() => setTab("sessions")}
        />
        <NavButton
          active={tab === "files"}
          label="文件"
          glyph="◇"
          onClick={() => setTab("files")}
        />
        <NavButton
          active={tab === "approvals"}
          label="审批"
          glyph="✓"
          badge={pendingCount}
          onClick={() => setTab("approvals")}
        />
      </nav>
    </div>
  );
}

function SessionsView({
  api,
  machine,
  sessions,
  selectedSession,
  events,
  onSelect,
  onChanged,
  run,
  notify,
}: {
  api: FleetApi;
  machine?: StoredMachine;
  sessions: Session[];
  selectedSession?: Session;
  events: AgentEvent[];
  onSelect: (id: string) => void;
  onChanged: () => Promise<void>;
  run: (operation: () => Promise<void>) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [showNew, setShowNew] = useState(false);
  const [harnessId, setHarnessId] = useState("");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [input, setInput] = useState("");
  const outputRef = useRef<HTMLPreElement>(null);
  const availableHarnesses =
    machine?.harnesses.filter((harness) => harness.available) ?? [];

  useEffect(() => {
    setHarnessId(availableHarnesses[0]?.id ?? "");
    setCwd(machine?.allowedRoots[0] ?? "");
  }, [machine?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (outputRef.current)
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [events]);

  const output = events
    .filter((event) => event.type === "session.output")
    .map((event) => String(event.data.chunk ?? ""))
    .join("");

  async function startSession(event: FormEvent) {
    event.preventDefault();
    if (!machine || !harnessId || !cwd) return;
    await run(async () => {
      const result = await api.startSession({
        machineId: machine.id,
        harnessId,
        cwd,
        ...(prompt.trim() ? { initialPrompt: prompt.trim() } : {}),
      });
      await onChanged();
      onSelect(result.session.id);
      setPrompt("");
      setShowNew(false);
      notify("会话已在电脑上启动");
    });
  }

  async function sendInput(event: FormEvent) {
    event.preventDefault();
    if (!selectedSession || !input) return;
    const text = input;
    setInput("");
    await run(async () => {
      await api.input(selectedSession.id, text);
    });
  }

  if (!machine)
    return (
      <EmptyState
        title="还没有电脑在线"
        detail="先在一台电脑上启动本机 daemon。"
      />
    );

  return (
    <div className="workspace-grid">
      <section className="session-rail panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">WORKSPACES</p>
            <h2>会话</h2>
          </div>
          <button
            className="icon-button"
            onClick={() => setShowNew((value) => !value)}
            aria-label="新建会话"
          >
            +
          </button>
        </div>

        {showNew ? (
          <form className="new-session" onSubmit={startSession}>
            <label>
              Harness
              <select
                value={harnessId}
                onChange={(event) => setHarnessId(event.target.value)}
                required
              >
                {availableHarnesses.map((harness) => (
                  <option key={harness.id} value={harness.id}>
                    {harness.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              工作目录
              <select
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                required
              >
                {machine.allowedRoots.map((root) => (
                  <option key={root}>{root}</option>
                ))}
              </select>
            </label>
            <label>
              第一条指令（可选）
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={3}
              />
            </label>
            <button className="primary" disabled={!availableHarnesses.length}>
              启动受管会话
            </button>
            {!availableHarnesses.length ? (
              <small>这台电脑上没有检测到可用 harness。</small>
            ) : null}
          </form>
        ) : null}

        <div className="session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`session-row ${session.id === selectedSession?.id ? "selected" : ""}`}
              onClick={() => onSelect(session.id)}
            >
              <span className={`state-bar ${session.state}`} />
              <span className="session-copy">
                <strong>{session.title}</strong>
                <small>
                  {session.harnessId} · {relativeTime(session.updatedAt)}
                </small>
              </span>
              <span className="session-state">{stateLabel(session.state)}</span>
            </button>
          ))}
          {!sessions.length ? <p className="muted centered">暂无会话</p> : null}
        </div>
      </section>

      <section className="terminal-panel panel">
        {selectedSession ? (
          <>
            <div className="terminal-header">
              <div>
                <span
                  className={`status-dot ${sessionDot(selectedSession.state)}`}
                />
                <strong>{selectedSession.title}</strong>
                <small>{selectedSession.cwd}</small>
              </div>
              <div className="terminal-actions">
                <button
                  onClick={() =>
                    void run(
                      async () =>
                        void (await api.interrupt(selectedSession.id)),
                    )
                  }
                  disabled={selectedSession.state !== "running"}
                >
                  Ctrl-C
                </button>
                <button
                  className="danger-text"
                  onClick={() =>
                    void run(async () => {
                      await api.stop(selectedSession.id);
                      notify("已发送停止指令");
                    })
                  }
                  disabled={selectedSession.state !== "running"}
                >
                  停止
                </button>
              </div>
            </div>
            <pre className="terminal-output" ref={outputRef}>
              {stripAnsi(output) || "等待 harness 输出…"}
            </pre>
            <EventTimeline events={events} />
            <form className="command-bar" onSubmit={sendInput}>
              <span>›</span>
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="给 agent 发送指令…"
                rows={1}
                disabled={selectedSession.state !== "running"}
              />
              <button
                className="send-button"
                disabled={!input || selectedSession.state !== "running"}
              >
                ↑
              </button>
            </form>
          </>
        ) : (
          <EmptyState
            title="选择或启动一个会话"
            detail="输出和工具事件会实时出现在这里。"
          />
        )}
      </section>
    </div>
  );
}

function EventTimeline({ events }: { events: AgentEvent[] }) {
  const items = events.filter((event) =>
    [
      "tool.call.started",
      "tool.call.finished",
      "approval.requested",
      "file.changed",
      "system.notice",
    ].includes(event.type),
  );
  if (!items.length) return null;
  return (
    <details className="event-timeline">
      <summary>{items.length} 条结构化事件</summary>
      {items.slice(-20).map((event) => (
        <div className="event-row" key={event.id}>
          <time>
            {new Date(event.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
          <strong>{eventLabel(event.type)}</strong>
          <code>{compactEventData(event.data)}</code>
        </div>
      ))}
    </details>
  );
}

function FilesView({
  api,
  machine,
  run,
  notify,
}: {
  api: FleetApi;
  machine?: StoredMachine;
  run: (operation: () => Promise<void>) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [root, setRoot] = useState("");
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<FileListing>();
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRoot(machine?.allowedRoots[0] ?? "");
    setPath("");
  }, [machine?.id]);

  const refresh = useCallback(async () => {
    if (!machine || !root) {
      setListing(undefined);
      return;
    }
    setListing(await api.listFiles(machine.id, root, path));
  }, [api, machine, path, root]);

  useEffect(() => {
    void run(refresh);
  }, [refresh, run]);

  if (!machine)
    return (
      <EmptyState
        title="还没有电脑在线"
        detail="文件只能来自已授权的本机目录。"
      />
    );
  const machineId = machine.id;

  async function upload(file: File) {
    const target = joinRelative(path, file.name);
    await run(async () => {
      const result = (await api.writeFile(
        machineId,
        root,
        target,
        await fileToBase64(file),
      )) as {
        status?: string;
      };
      if (result.status === "approval_required")
        notify("同名文件已存在，请到审批页确认覆盖");
      else notify(`${file.name} 已发送到电脑`);
      await refresh();
    });
  }

  async function download(entry: FileEntry) {
    await run(async () => {
      const file = await api.readFile(machineId, root, entry.relativePath);
      const bytes = Uint8Array.from(atob(file.contentBase64), (character) =>
        character.charCodeAt(0),
      );
      const url = URL.createObjectURL(
        new Blob([bytes], { type: file.mimeType }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      URL.revokeObjectURL(url);
      notify(`${file.name} 已接收到手机`);
    });
  }

  const segments = path.split(/[\\/]/).filter(Boolean);
  return (
    <section className="files-panel panel">
      <div className="section-heading files-heading">
        <div>
          <p className="eyebrow">ALLOWLISTED ROOT</p>
          <h2>文件</h2>
        </div>
        <button
          className="primary compact"
          onClick={() => uploadRef.current?.click()}
        >
          上传到此处
        </button>
        <input
          ref={uploadRef}
          type="file"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.currentTarget.value = "";
          }}
        />
      </div>
      <label className="root-select">
        授权目录
        <select
          value={root}
          onChange={(event) => {
            setRoot(event.target.value);
            setPath("");
          }}
        >
          {machine.allowedRoots.map((allowedRoot) => (
            <option key={allowedRoot}>{allowedRoot}</option>
          ))}
        </select>
      </label>
      <div className="breadcrumbs">
        <button onClick={() => setPath("")}>ROOT</button>
        {segments.map((segment, index) => (
          <span key={`${segment}-${index}`}>
            /
            <button
              onClick={() => setPath(segments.slice(0, index + 1).join("/"))}
            >
              {segment}
            </button>
          </span>
        ))}
      </div>
      <div className="file-list">
        {path ? (
          <button
            className="file-row"
            onClick={() => setPath(parentPath(path))}
          >
            <span className="file-icon folder">↰</span>
            <strong>返回上一级</strong>
          </button>
        ) : null}
        {listing?.entries.map((entry) => (
          <button
            className="file-row"
            key={entry.relativePath}
            onClick={() =>
              entry.kind === "directory"
                ? setPath(entry.relativePath)
                : void download(entry)
            }
          >
            <span className={`file-icon ${entry.kind}`}>
              {entry.kind === "directory" ? "▰" : "·/"}
            </span>
            <span className="file-copy">
              <strong>{entry.name}</strong>
              <small>
                {entry.kind === "directory" ? "目录" : formatBytes(entry.size)}{" "}
                · {relativeTime(entry.modifiedAt)}
              </small>
            </span>
            <span className="chevron">
              {entry.kind === "directory" ? "›" : "↓"}
            </span>
          </button>
        ))}
        {listing && !listing.entries.length ? (
          <p className="muted centered">这个目录是空的</p>
        ) : null}
      </div>
      <p className="safety-note">
        仅可访问 daemon 配置的白名单目录；现有文件的覆盖必须单独审批。
      </p>
    </section>
  );
}

function ApprovalsView({
  api,
  approvals,
  onChanged,
  run,
  notify,
}: {
  api: FleetApi;
  approvals: Approval[];
  onChanged: () => Promise<void>;
  run: (operation: () => Promise<void>) => Promise<void>;
  notify: (message: string) => void;
}) {
  async function resolve(id: string, decision: "approve" | "deny") {
    await run(async () => {
      await api.resolveApproval(id, decision);
      await onChanged();
      notify(decision === "approve" ? "操作已批准" : "操作已拒绝");
    });
  }

  return (
    <section className="approvals-panel panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">HUMAN IN THE LOOP</p>
          <h2>审批</h2>
        </div>
        <span className="count-chip">
          {approvals.filter((item) => item.status === "pending").length} 待处理
        </span>
      </div>
      <div className="approval-list">
        {approvals.map((approval) => (
          <article
            className={`approval-card ${approval.status}`}
            key={approval.id}
          >
            <div className="approval-topline">
              <span className={`risk ${approval.risk}`}>
                {riskLabel(approval.risk)}
              </span>
              <time>{relativeTime(approval.createdAt)}</time>
            </div>
            <h3>{approval.title}</h3>
            <p>{approval.description}</p>
            {approval.status === "pending" ? (
              <div className="approval-actions">
                <button
                  className="secondary"
                  onClick={() => void resolve(approval.id, "deny")}
                >
                  拒绝
                </button>
                <button
                  className="primary"
                  onClick={() => void resolve(approval.id, "approve")}
                >
                  批准一次
                </button>
              </div>
            ) : (
              <span className="resolved-label">
                {approvalStatusLabel(approval.status)}
              </span>
            )}
          </article>
        ))}
        {!approvals.length ? (
          <EmptyState
            title="没有待审批操作"
            detail="危险文件操作和工具调用会出现在这里。"
          />
        ) : null}
      </div>
    </section>
  );
}

function NavButton({
  active,
  label,
  glyph,
  badge,
  onClick,
}: {
  active: boolean;
  label: string;
  glyph: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button className={active ? "active" : ""} onClick={onClick}>
      <span className="nav-glyph">{glyph}</span>
      <span>{label}</span>
      {badge ? <b>{badge}</b> : null}
    </button>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span aria-hidden="true">⌁</span>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

function connectionLabel(status: ConnectionStatus): string {
  return {
    connecting: "连接中",
    online: "Relay 在线",
    offline: "Relay 离线",
    unauthorized: "需要登录",
  }[status];
}

function stateLabel(state: Session["state"]): string {
  return {
    starting: "启动中",
    running: "运行中",
    waiting: "等待中",
    stopped: "已停止",
    completed: "已完成",
    failed: "失败",
  }[state];
}

function approvalStatusLabel(status: Approval["status"]): string {
  return {
    pending: "待审批",
    approved: "已批准",
    denied: "已拒绝",
    expired: "已过期",
  }[status];
}

function riskLabel(risk: Approval["risk"]): string {
  return { low: "低风险", medium: "需确认", high: "高风险" }[risk];
}

function eventLabel(type: AgentEvent["type"]): string {
  return {
    "session.created": "会话创建",
    "session.output": "会话输出",
    "session.state": "状态变化",
    "tool.call.started": "工具开始",
    "tool.call.finished": "工具完成",
    "approval.requested": "请求审批",
    "approval.resolved": "审批完成",
    "file.changed": "文件变化",
    "system.notice": "系统消息",
  }[type];
}

function relativeTime(input: string): string {
  const seconds = Math.round((Date.now() - Date.parse(input)) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Date(input).toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function joinRelative(base: string, name: string): string {
  return [...base.split(/[\\/]/).filter(Boolean), name].join("/");
}

function parentPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).slice(0, -1).join("/");
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("无法读取文件"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function stripAnsi(value: string): string {
  let clean = value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "");
  while (clean.includes("\b")) {
    const next = clean.replace(/[^\n]\x08/g, "");
    if (next === clean) break;
    clean = next;
  }
  return clean.replace(/[\x08\r]/g, "");
}

function sessionDot(
  state: Session["state"],
): "online" | "connecting" | "offline" | "idle" {
  if (state === "running") return "online";
  if (state === "starting" || state === "waiting") return "connecting";
  if (state === "failed") return "offline";
  return "idle";
}

function compactEventData(data: Record<string, unknown>): string {
  const encoded = JSON.stringify(data);
  return encoded.length > 180 ? `${encoded.slice(0, 177)}…` : encoded;
}
