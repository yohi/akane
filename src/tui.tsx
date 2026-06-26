import type { RGBA } from "@opentui/core";
import type { PluginOptions } from "@opencode-ai/plugin";
import type { TuiPlugin, TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import type { Session } from "@opencode-ai/sdk/v2";
import type { SharedWatchdogState, SharedSessionState } from "./shared-state";
import { formatSessionState, formatTimestamp, readSharedState, stateFilePath } from "./tui-state";
import { For, Show, createSignal, onCleanup } from "solid-js";

const POLL_MS = 1000;
const SUBAGENT_IDLE_MS = 60_000;
const SUBAGENT_FRESH_MS = 30_000;

interface AgentEntry {
  name: string;
  firstSeen: number;
  lastSeen: number;
}

interface SubagentEntry {
  key: string;
  name: string;
  source: "session" | "event";
  firstSeen: number;
  lastSeen: number;
}

interface SidebarProps {
  api: TuiPluginApi;
  sessionId: string;
}

function recordAgent(
  record: Record<string, AgentEntry>,
  name: string,
): Record<string, AgentEntry> {
  const now = Date.now();
  const existing = record[name];
  return {
    ...record,
    [name]: {
      name,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    },
  };
}

function formatElapsedSeconds(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${seconds}s`;
}

function subagentColor(
  elapsedMs: number,
  theme: { success: RGBA; warning: RGBA; error: RGBA },
): RGBA {
  if (elapsedMs < SUBAGENT_FRESH_MS) return theme.success;
  if (elapsedMs < SUBAGENT_IDLE_MS) return theme.warning;
  return theme.error;
}

// OpenTUI's Solid JSX types omit fg/bg on span/strong; the runtime renderable
// supports them. We use a tiny wrapper that spreads the props as `any` to keep
// the build type-clean while still emitting the color options at runtime.
function ColoredSpan(props: { fg: string | RGBA; children: any }) {
  return <span {...({ fg: props.fg } as any)}>{props.children}</span>;
}

function ColoredStrong(props: { fg: string | RGBA; children: any }) {
  return <strong {...({ fg: props.fg } as any)}>{props.children}</strong>;
}

function Sidebar(props: SidebarProps) {
  const [state, setState] = createSignal<SharedWatchdogState | undefined>(undefined);
  const [agents, setAgents] = createSignal<Record<string, AgentEntry>>({});
  const [sessions, setSessions] = createSignal<Record<string, Session>>({});
  const [now, setNow] = createSignal(Date.now());

  const directory = () => props.api.state.path.worktree;
  const filePath = () => stateFilePath(directory());
  const theme = () => props.api.theme.current;

  const refresh = () => {
    setState(readSharedState(filePath()));
  };

  refresh();
  const pollTimer = setInterval(refresh, POLL_MS);
  const nowTimer = setInterval(() => setNow(Date.now()), 10_000);
  onCleanup(() => {
    clearInterval(pollTimer);
    clearInterval(nowTimer);
  });

  const unsubPartUpdated = props.api.event.on("message.part.updated", (event) => {
    if (event.properties.sessionID !== props.sessionId) return;

    const part = event.properties.part;
    let name: string | undefined;
    if (part.type === "subtask") {
      name = part.agent;
    } else if (part.type === "agent") {
      name = part.name;
    }
    if (!name) return;

    setAgents((prev) => recordAgent(prev, name));
  });
  onCleanup(unsubPartUpdated);

  const updateSession = (info: Session) => {
    setSessions((prev) => ({ ...prev, [info.id]: info }));
  };
  const removeSession = (sessionID: string) => {
    setSessions((prev) => {
      const next = { ...prev };
      delete next[sessionID];
      return next;
    });
  };

  const unsubSessionCreated = props.api.event.on("session.created", (event) => {
    updateSession(event.properties.info);
  });
  onCleanup(unsubSessionCreated);

  const unsubSessionUpdated = props.api.event.on("session.updated", (event) => {
    updateSession(event.properties.info);
  });
  onCleanup(unsubSessionUpdated);

  const unsubSessionDeleted = props.api.event.on("session.deleted", (event) => {
    removeSession(event.properties.info.id);
  });
  onCleanup(unsubSessionDeleted);

  const sessionState = (): SharedSessionState | undefined => state()?.sessions[props.sessionId];
  const activeSessions = (): number =>
    Object.values(state()?.sessions ?? {}).filter((session) => session.state !== "IDLE").length;

  const activeEventAgents = (): AgentEntry[] => {
    const cutoff = now() - SUBAGENT_IDLE_MS;
    return Object.values(agents())
      .filter((entry) => entry.lastSeen >= cutoff)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  };

  const activeSubagentSessions = (): Session[] => {
    return Object.values(sessions()).filter(
      (session) =>
        session.parentID === props.sessionId &&
        session.agent &&
        session.agent !== "user" &&
        session.agent !== "system",
    );
  };

  const activeSubagentNames = (): SubagentEntry[] => {
    const nowTime = now();
    const fromSessions: SubagentEntry[] = activeSubagentSessions().map((session) => ({
      key: session.id,
      name: session.agent!,
      source: "session",
      firstSeen: session.time.created ?? nowTime,
      lastSeen: session.time.updated ?? nowTime,
    }));
    const fromEvents: SubagentEntry[] = activeEventAgents().map((entry) => ({
      key: `event:${entry.name}`,
      name: entry.name,
      source: "event",
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
    }));
    const seen = new Set<string>();
    const combined: SubagentEntry[] = [];
    for (const entry of [...fromSessions, ...fromEvents]) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      combined.push(entry);
    }
    return combined.sort((a, b) => a.name.localeCompare(b.name));
  };

  const branch = () => props.api.state.vcs?.branch ?? "-";

  return (
    <box style={{ border: true }}>
      <text>
        <ColoredStrong fg={theme().accent}>Akane Watchdog</ColoredStrong>
        <br />
        Branch: <span>{branch()}</span>
        <br />
        Plugin: <span>{state()?.enabled ? "enabled" : "disabled"}</span>
        <br />
        <br />
        <ColoredStrong fg={theme().accent}>Telemetry</ColoredStrong>
        <br />
        Active sessions: <span>{activeSessions()}</span>
        <br />
        Hangups: <span>{state()?.global.hangupsDetected ?? 0}</span>
        <br />
        Pings: <span>{state()?.global.pingsSent ?? 0}</span>
        <br />
        Recoveries: <span>{state()?.global.recoveries ?? 0}</span>
        <br />
        Silenced: <span>{state()?.global.silencedFailures ?? 0}</span>
        <br />
        <br />
        <ColoredStrong fg={theme().accent}>This session</ColoredStrong>
        <br />
        State: <span>{formatSessionState(sessionState()?.state)}</span>
        <br />
        Agent: <span>{sessionState()?.agentName ?? "-"}</span>
        <br />
        Tools running: <span>{sessionState()?.runningToolsCount ?? 0}</span>
        <br />
        Pending: <span>{sessionState()?.pendingRequestsCount ?? 0}</span>
        <br />
        Last activity: <span>{formatTimestamp(sessionState()?.lastActivityAt, now())}</span>
        <br />
        <Show when={sessionState()?.errorReason}>
          {(reason) => (
            <span>
              <span>Error: {reason()}</span>
              <br />
            </span>
          )}
        </Show>
        <br />
        <ColoredStrong fg={theme().accent}>Active subagents</ColoredStrong>
        <br />
        <Show when={activeSubagentNames().length === 0}>
          <ColoredSpan fg={theme().textMuted}>None</ColoredSpan>
          <br />
        </Show>
        <For each={activeSubagentNames()}>
          {(entry) => {
            const elapsed = () => now() - entry.firstSeen;
            const suffix = entry.source === "session" ? ` (${entry.key.slice(-6)})` : "";
            return (
              <span>
                <ColoredSpan fg={subagentColor(elapsed(), theme())}>
                  • {entry.name}
                  {suffix} ({formatElapsedSeconds(elapsed())})
                </ColoredSpan>
                <br />
              </span>
            );
          }}
        </For>
      </text>
    </box>
  );
}

const tui: TuiPlugin = async (
  api: TuiPluginApi,
  _options: PluginOptions | undefined,
  _meta: TuiPluginMeta,
) => {
  api.slots.register({
    slots: {
      sidebar_content: (_ctx, props: { session_id: string }) => {
        return <Sidebar api={api} sessionId={props.session_id} />;
      },
    },
  });
};

export default {
  id: "opencode-watchdog-tui",
  tui,
};
