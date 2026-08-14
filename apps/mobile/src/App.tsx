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
  const [loaded, setLoaded] = useState(false);
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
      setLoaded(true);
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

  const connectionOpen = showConnection || connection === "unauthorized";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="terminal" />
          </span>
          <div className="brand-copy">
            <h1>Agent Console</h1>
            <p className="brand-context">
              {selectedMachine ? (
                <>
                  <span
                    className={`ctx-dot ${selectedMachine.status}`}
                    aria-hidden="true"
                  />
                  <span className="ctx-name">{selectedMachine.name}</span>
                </>
              ) : (
                <span className="ctx-name muted">未选择设备</span>
              )}
            </p>
          </div>
        </div>
        <button
          className={`connection-button ${connectionOpen ? "active" : ""}`}
          onClick={() => setShowConnection((value) => !value)}
          aria-expanded={connectionOpen}
        >
          <span className={`status-dot ${connection}`} aria-hidden="true" />
          <span className="connection-label">{connectionLabel(connection)}</span>
          <span className="connection-gear" aria-hidden="true">
            <Icon name="settings" />
          </span>
        </button>
      </header>

      {connectionOpen ? (
        <form className="connection-panel" onSubmit={saveToken}>
          <div className="connection-copy">
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
          <button className="primary" type="submit">
            重新连接
          </button>
        </form>
      ) : null}

      {error ? (
        <button className="alert error" onClick={() => setError("")}>
          <span className="alert-icon" aria-hidden="true">
            <Icon name="alert" />
          </span>
          <span className="alert-text">{error}</span>
          <span className="alert-dismiss" aria-hidden="true">
            ×
          </span>
        </button>
      ) : null}
      {notice ? (
        <div className="alert notice" role="status">
          <span className="alert-icon" aria-hidden="true">
            <Icon name="check" />
          </span>
          <span className="alert-text">{notice}</span>
        </div>
      ) : null}

      <section className="fleet-strip" aria-label="电脑列表">
        {machines.length ? (
          machines.map((machine) => {
            const harnessCount = machine.harnesses.filter(
              (harness) => harness.available,
            ).length;
            return (
              <button
                key={machine.id}
                className={`machine-pill ${machine.status} ${
                  machine.id === selectedMachineId ? "selected" : ""
                }`}
                onClick={() => setSelectedMachineId(machine.id)}
                aria-pressed={machine.id === selectedMachineId}
              >
                <span className="machine-top">
                  <span
                    className={`machine-status ${machine.status}`}
                    aria-hidden="true"
                  />
                  <strong className="machine-name">{machine.name}</strong>
                </span>
                <span className="machine-meta">
                  <span>{machine.platform}</span>
                  <span className="machine-dot" aria-hidden="true">
                    ·
                  </span>
                  <span>{machine.status === "online" ? "在线" : "离线"}</span>
                  <span className="machine-dot" aria-hidden="true">
                    ·
                  </span>
                  <span>{harnessCount} harness</span>
                </span>
              </button>
            );
          })
        ) : loaded ? (
          <div className="empty-inline">
            <span className="pulse-ring" aria-hidden="true" />
            等待本机 daemon 连接…
          </div>
        ) : (
          <div className="empty-inline">
            <span className="pulse-ring" aria-hidden="true" />
            正在载入设备…
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
          icon="terminal"
          onClick={() => setTab("sessions")}
        />
        <NavButton
          active={tab === "files"}
          label="文件"
          icon="folder"
          onClick={() => setTab("files")}
        />
        <NavButton
          active={tab === "approvals"}
          label="审批"
          icon="shield"
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
  const [mobileTerminal, setMobileTerminal] = useState(false);
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

  function openSession(id: string) {
    onSelect(id);
    setMobileTerminal(true);
  }

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
      setMobileTerminal(true);
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
        icon="desktop"
        title="还没有电脑在线"
        detail="先在一台电脑上启动本机 daemon。"
      />
    );

  const running = selectedSession?.state === "running";

  return (
    <div className={`workspace-grid ${mobileTerminal ? "show-terminal" : ""}`}>
      <section className="session-rail panel">
        <div className="section-heading">
          <div className="heading-copy">
            <p className="eyebrow">工作区</p>
            <h2>会话</h2>
          </div>
          <button
            className="primary compact new-session-button"
            onClick={() => setShowNew(true)}
            disabled={!availableHarnesses.length}
          >
            <Icon name="plus" />
            新建会话
          </button>
        </div>

        <div className="session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`session-row ${
                session.id === selectedSession?.id ? "selected" : ""
              }`}
              onClick={() => openSession(session.id)}
              aria-pressed={session.id === selectedSession?.id}
            >
              <span className={`state-bar ${session.state}`} aria-hidden="true" />
              <span className="session-copy">
                <span className="session-title-row">
                  <strong className="session-title">{session.title}</strong>
                  <span className={`session-badge ${session.state}`}>
                    {stateLabel(session.state)}
                  </span>
                </span>
                <span className="session-cwd">{session.cwd}</span>
                <span className="session-meta">
                  <span className="harness-tag">{session.harnessId}</span>
                  <span className="session-time">
                    {relativeTime(session.updatedAt)}
                  </span>
                </span>
              </span>
            </button>
          ))}
          {!sessions.length ? (
            <div className="rail-empty">
              <p>这台电脑上还没有会话</p>
              <button
                className="secondary compact"
                onClick={() => setShowNew(true)}
                disabled={!availableHarnesses.length}
              >
                启动第一个会话
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <section className="terminal-panel panel">
        {selectedSession ? (
          <>
            <div className="terminal-header">
              <button
                className="back-button"
                onClick={() => setMobileTerminal(false)}
                aria-label="返回会话列表"
              >
                <Icon name="back" />
              </button>
              <div className="terminal-id">
                <div className="terminal-title-row">
                  <span
                    className={`status-dot ${sessionDot(selectedSession.state)}`}
                    aria-hidden="true"
                  />
                  <strong>{selectedSession.title}</strong>
                  <span className={`session-badge ${selectedSession.state}`}>
                    {stateLabel(selectedSession.state)}
                  </span>
                </div>
                <small>{selectedSession.cwd}</small>
              </div>
              <div className="terminal-actions">
                <button
                  className="ghost-button"
                  onClick={() =>
                    void run(
                      async () =>
                        void (await api.interrupt(selectedSession.id)),
                    )
                  }
                  disabled={!running}
                >
                  Ctrl-C
                </button>
                <button
                  className="danger-button"
                  onClick={() =>
                    void run(async () => {
                      await api.stop(selectedSession.id);
                      notify("已发送停止指令");
                    })
                  }
                  disabled={!running}
                >
                  <Icon name="stop" />
                  停止
                </button>
              </div>
            </div>
            <pre className="terminal-output" ref={outputRef} tabIndex={0}>
              {stripAnsi(output) || "等待 harness 输出…"}
            </pre>
            <EventTimeline events={events} />
            <form className="command-bar" onSubmit={sendInput}>
              <span className="command-prompt" aria-hidden="true">
                ›
              </span>
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={running ? "给 agent 发送指令…" : "会话未运行"}
                rows={1}
                disabled={!running}
                aria-label="发送指令"
              />
              <button
                className="send-button"
                disabled={!input || !running}
                aria-label="发送"
              >
                <Icon name="send" />
              </button>
            </form>
          </>
        ) : (
          <EmptyState
            icon="terminal"
            title="选择或启动一个会话"
            detail="输出和工具事件会实时出现在这里。"
          />
        )}
      </section>

      {showNew ? (
        <div
          className="sheet-scrim"
          onClick={(event) => {
            if (event.target === event.currentTarget) setShowNew(false);
          }}
        >
          <form
            className="sheet"
            onSubmit={startSession}
            role="dialog"
            aria-modal="true"
            aria-label="新建会话"
          >
            <div className="sheet-grabber" aria-hidden="true" />
            <div className="sheet-head">
              <h2>新建会话</h2>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setShowNew(false)}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
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
                placeholder="例如：审查当前分支的改动并总结风险"
              />
            </label>
            <button
              className="primary sheet-submit"
              disabled={!availableHarnesses.length}
            >
              启动受管会话
            </button>
            {!availableHarnesses.length ? (
              <small className="sheet-warning">
                这台电脑上没有检测到可用 harness。
              </small>
            ) : null}
          </form>
        </div>
      ) : null}
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
      <summary>
        <Icon name="pulse" />
        {items.length} 条结构化事件
      </summary>
      <div className="event-scroll">
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
      </div>
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
        icon="folder"
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
  const directories =
    listing?.entries.filter((entry) => entry.kind === "directory") ?? [];
  const files =
    listing?.entries.filter((entry) => entry.kind === "file") ?? [];

  return (
    <section className="files-panel panel">
      <div className="section-heading files-heading">
        <div className="heading-copy">
          <p className="eyebrow">白名单目录</p>
          <h2>文件</h2>
        </div>
        <button
          className="primary compact"
          onClick={() => uploadRef.current?.click()}
        >
          <Icon name="upload" />
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

      <div className="files-toolbar">
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
        <nav className="breadcrumbs" aria-label="路径">
          <button onClick={() => setPath("")}>root</button>
          {segments.map((segment, index) => (
            <span key={`${segment}-${index}`}>
              <span className="crumb-sep" aria-hidden="true">
                /
              </span>
              <button
                onClick={() => setPath(segments.slice(0, index + 1).join("/"))}
              >
                {segment}
              </button>
            </span>
          ))}
        </nav>
      </div>

      <div className="file-list">
        {path ? (
          <button
            className="file-row up"
            onClick={() => setPath(parentPath(path))}
          >
            <span className="file-icon folder" aria-hidden="true">
              <Icon name="levelup" />
            </span>
            <span className="file-copy">
              <strong>返回上一级</strong>
            </span>
          </button>
        ) : null}
        {directories.map((entry) => (
          <button
            className="file-row"
            key={entry.relativePath}
            onClick={() => setPath(entry.relativePath)}
          >
            <span className="file-icon folder" aria-hidden="true">
              <Icon name="folder" />
            </span>
            <span className="file-copy">
              <strong>{entry.name}</strong>
              <small>目录 · {relativeTime(entry.modifiedAt)}</small>
            </span>
            <span className="chevron" aria-hidden="true">
              <Icon name="chevron" />
            </span>
          </button>
        ))}
        {files.map((entry) => (
          <button
            className="file-row"
            key={entry.relativePath}
            onClick={() => void download(entry)}
          >
            <span className="file-icon file" aria-hidden="true">
              <Icon name="file" />
            </span>
            <span className="file-copy">
              <strong>{entry.name}</strong>
              <small>
                {formatBytes(entry.size)} · {relativeTime(entry.modifiedAt)}
              </small>
            </span>
            <span className="chevron download" aria-hidden="true">
              <Icon name="download" />
            </span>
          </button>
        ))}
        {listing && !listing.entries.length ? (
          <p className="muted centered">这个目录是空的</p>
        ) : null}
      </div>

      <p className="safety-note">
        <Icon name="lock" />
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

  const pending = approvals.filter((item) => item.status === "pending");
  const resolved = approvals.filter((item) => item.status !== "pending");
  const ordered = [
    ...pending.sort(
      (a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt),
    ),
    ...resolved.sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    ),
  ];

  return (
    <section className="approvals-panel panel">
      <div className="section-heading">
        <div className="heading-copy">
          <p className="eyebrow">人工确认</p>
          <h2>审批</h2>
        </div>
        <span className={`count-chip ${pending.length ? "active" : ""}`}>
          {pending.length} 待处理
        </span>
      </div>
      {ordered.length ? (
        <div className="approval-list">
          {ordered.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              onResolve={resolve}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon="shield"
          title="没有待审批操作"
          detail="危险文件操作和工具调用会出现在这里。"
        />
      )}
    </section>
  );
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: Approval;
  onResolve: (id: string, decision: "approve" | "deny") => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const isPending = approval.status === "pending";
  const highRisk = approval.risk === "high";

  return (
    <article className={`approval-card ${approval.status} risk-${approval.risk}`}>
      <div className="approval-topline">
        <span className={`risk ${approval.risk}`}>
          {highRisk ? (
            <span className="risk-icon" aria-hidden="true">
              <Icon name="alert" />
            </span>
          ) : null}
          {riskLabel(approval.risk)}
        </span>
        <span className="approval-kind">{kindLabel(approval.kind)}</span>
      </div>
      <h3>{approval.title}</h3>
      <p>{approval.description}</p>
      <div className="approval-timing">
        <span>{relativeTime(approval.createdAt)}请求</span>
        <span className={`expiry ${isExpiringSoon(approval.expiresAt) ? "soon" : ""}`}>
          {expiryLabel(approval.expiresAt)}
        </span>
      </div>
      {isPending ? (
        <div className="approval-actions">
          <button
            className="secondary"
            onClick={() => {
              setArmed(false);
              void onResolve(approval.id, "deny");
            }}
          >
            拒绝
          </button>
          {highRisk ? (
            armed ? (
              <button
                className="danger-confirm"
                onClick={() => {
                  setArmed(false);
                  void onResolve(approval.id, "approve");
                }}
              >
                确认批准高风险操作
              </button>
            ) : (
              <button
                className="approve-guarded"
                onClick={() => setArmed(true)}
              >
                批准…
              </button>
            )
          ) : (
            <button
              className="primary"
              onClick={() => void onResolve(approval.id, "approve")}
            >
              批准一次
            </button>
          )}
        </div>
      ) : (
        <span className={`resolved-label ${approval.status}`}>
          {approvalStatusLabel(approval.status)}
        </span>
      )}
    </article>
  );
}

function NavButton({
  active,
  label,
  icon,
  badge,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: IconName;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      className={active ? "active" : ""}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      <span className="nav-glyph" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className="nav-label">{label}</span>
      {badge ? (
        <b aria-label={`${badge} 条待处理`}>{badge > 99 ? "99+" : badge}</b>
      ) : null}
    </button>
  );
}

function EmptyState({
  title,
  detail,
  icon = "terminal",
}: {
  title: string;
  detail: string;
  icon?: IconName;
}) {
  return (
    <div className="empty-state">
      <span className="empty-glyph" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

type IconName =
  | "terminal"
  | "folder"
  | "shield"
  | "settings"
  | "plus"
  | "back"
  | "send"
  | "stop"
  | "upload"
  | "download"
  | "file"
  | "chevron"
  | "levelup"
  | "lock"
  | "alert"
  | "check"
  | "pulse"
  | "desktop";

function Icon({ name }: { name: IconName }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "terminal":
      return (
        <svg {...common}>
          <path d="m5 8 4 4-4 4" />
          <path d="M12 16h7" />
        </svg>
      );
    case "folder":
      return (
        <svg {...common}>
          <path d="M4 6a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "back":
      return (
        <svg {...common}>
          <path d="m14 6-6 6 6 6" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <path d="M12 19V5M6 11l6-6 6 6" />
        </svg>
      );
    case "stop":
      return (
        <svg {...common}>
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      );
    case "upload":
      return (
        <svg {...common}>
          <path d="M12 15V4M8 8l4-4 4 4" />
          <path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
        </svg>
      );
    case "download":
      return (
        <svg {...common}>
          <path d="M12 4v11M8 11l4 4 4-4" />
          <path d="M5 19h14" />
        </svg>
      );
    case "file":
      return (
        <svg {...common}>
          <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
          <path d="M14 3v5h5" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...common}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      );
    case "levelup":
      return (
        <svg {...common}>
          <path d="M7 14 3 10l4-4" />
          <path d="M3 10h10a6 6 0 0 1 6 6v2" />
        </svg>
      );
    case "lock":
      return (
        <svg {...common}>
          <rect x="5" y="10" width="14" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      );
    case "alert":
      return (
        <svg {...common}>
          <path d="M12 4 2 20h20z" />
          <path d="M12 10v4M12 17h.01" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="m5 12 4 4 10-10" />
        </svg>
      );
    case "pulse":
      return (
        <svg {...common}>
          <path d="M3 12h4l2-6 4 12 2-6h6" />
        </svg>
      );
    case "desktop":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </svg>
      );
    default:
      return null;
  }
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

function kindLabel(kind: Approval["kind"]): string {
  return {
    tool: "工具调用",
    "file-overwrite": "覆盖文件",
    "file-delete": "删除文件",
    command: "执行命令",
  }[kind];
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

function expiryLabel(input: string): string {
  const seconds = Math.round((Date.parse(input) - Date.now()) / 1000);
  if (seconds <= 0) return "已过期";
  if (seconds < 60) return `${seconds} 秒后过期`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟后过期`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时后过期`;
  return `${Math.floor(seconds / 86_400)} 天后过期`;
}

function isExpiringSoon(input: string): boolean {
  const seconds = Math.round((Date.parse(input) - Date.now()) / 1000);
  return seconds > 0 && seconds < 300;
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
