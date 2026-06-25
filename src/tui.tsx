import type { PluginOptions } from "@opencode-ai/plugin";
import type { TuiPlugin, TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import type { Session } from "@opencode-ai/sdk/v2";
import type { SharedWatchdogState, SharedSessionState } from "./shared-state";
import { formatSessionState, formatTimestamp, readSharedState, stateFilePath } from "./tui-state";
import { For, Show, createSignal, onCleanup } from "solid-js";

const POLL_MS = 1000;
const SUBAGENT_IDLE_MS = 60_000;

interface AgentEntry {
  name: string;
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
  return { ...record, [name]: { name, lastSeen: Date.now() } };
}

function Sidebar(props: SidebarProps) {
  const [state, setState] = createSignal<SharedWatchdogState | undefined>(undefined);
  const [agents, setAgents] = createSignal<Record<string, AgentEntry>>({});
  const [sessions, setSessions] = createSignal<Record<string, Session>>({});
  const [now, setNow] = createSignal(Date.now());

  const directory = () => props.api.state.path.directory;
  const filePath = () => stateFilePath(directory());

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

  const unsubAgentSwitched = props.api.event.on("session.next.agent.switched", (event) => {
    if (event.properties.sessionID !== props.sessionId) return;
    const name = event.properties.agent;
    if (!name) return;
    setAgents((prev) => recordAgent(prev, name));
  });
  onCleanup(unsubAgentSwitched);

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
  const activeSessions = (): number => Object.keys(state()?.sessions ?? {}).length;

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

  const activeSubagentNames = (): string[] => {
    const fromSessions = activeSubagentSessions().map((session) => session.agent!);
    const fromEvents = activeEventAgents().map((entry) => entry.name);
    const combined = Array.from(new Set([...fromSessions, ...fromEvents]));
    return combined.sort();
  };

  const branch = () => props.api.state.vcs?.branch ?? "-";

  return (
    <box style={{ border: true }}>
      <text>
        <strong>Akane Watchdog</strong>
        <br />
        Branch: <span>{branch()}</span>
        <br />
        Plugin: <span>{state()?.enabled ? "enabled" : "disabled"}</span>
        <br />
        <br />
        <strong>Telemetry</strong>
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
        <strong>This session</strong>
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
        <strong>Active subagents</strong>
        <br />
        <Show when={activeSubagentNames().length === 0}>
          <span>None</span>
          <br />
        </Show>
        <For each={activeSubagentNames()}>
          {(name) => (
            <span>
              <span>• {name}</span>
              <br />
            </span>
          )}
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
