import { RGBA } from "@opentui/core";
import type { PluginOptions } from "@opencode-ai/plugin";
import type { TuiPlugin, TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import type { Session } from "@opencode-ai/sdk/v2";
import type { SharedWatchdogState, SharedSessionState } from "./shared-state";
import {
  type AgentEntry,
  type SubagentEntry,
  SUBAGENT_IDLE_MS,
  agentColorToRgba,
  formatElapsedSeconds,
  normalizeAgentsResponse,
  recordAgent,
  subagentColor,
} from "./tui-helpers";
import { colorStyleProps, formatSessionState, formatTimestamp, readSharedState, resolveAgentDisplayColor, stateFilePath } from "./tui-state";
import { For, Show, createSignal, onCleanup } from "solid-js";

const POLL_MS = 1000;

interface SidebarProps {
  api: TuiPluginApi;
  sessionId: string;
}

function Sidebar(props: SidebarProps) {
  const [state, setState] = createSignal<SharedWatchdogState | undefined>(undefined);
  const [agents, setAgents] = createSignal<Record<string, AgentEntry>>({});
  const [agentColors, setAgentColors] = createSignal<Record<string, RGBA | undefined>>({});
  const [sessions, setSessions] = createSignal<Record<string, Session>>({});
  const [now, setNow] = createSignal(Date.now());

  const directory = () => props.api.state.path.worktree;
  const filePath = () => stateFilePath(directory());
  const theme = () => props.api.theme.current;

  const refresh = () => {
    setState(readSharedState(filePath()));
  };

  const refreshAgentColors = async () => {
    const response = await props.api.client.app.agents({ directory: directory() });
    const colors: Record<string, RGBA | undefined> = {};
    for (const agent of normalizeAgentsResponse(response)) {
      if (!agent.color) continue;
      colors[agent.name] = agentColorToRgba(agent.color, theme());
    }
    setAgentColors(colors);
  };

  refresh();
  refreshAgentColors().catch(() => setAgentColors({}));
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
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      combined.push(entry);
    }
    return combined.sort((a, b) => a.name.localeCompare(b.name));
  };

  const branch = () => props.api.state.vcs?.branch ?? "-";
  const agentColor = (agentName: string | undefined, fallback: RGBA): RGBA =>
    resolveAgentDisplayColor(agentName, {
      fallback,
      profileColors: agentColors(),
    });
  const currentAgentColor = (): RGBA => agentColor(sessionState()?.agentName, theme().accent);

  return (
    <box style={{ border: true }}>
      <text>
        <strong {...colorStyleProps(currentAgentColor())}>Akane Watchdog</strong>
        <br />
        Branch: <span>{branch()}</span>
        <br />
        Plugin: <span>{state()?.enabled ? "enabled" : "disabled"}</span>
        <br />
        <br />
        <strong {...colorStyleProps(theme().accent)}>Telemetry</strong>
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
        <strong {...colorStyleProps(currentAgentColor())}>This session</strong>
        <br />
        State: <span>{formatSessionState(sessionState()?.state)}</span>
        <br />
        Agent: <span {...colorStyleProps(agentColor(sessionState()?.agentName, theme().text))}>{sessionState()?.agentName ?? "-"}</span>
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
              <span {...colorStyleProps(theme().error)}>Error: {reason()}</span>
              <br />
            </span>
          )}
        </Show>
        <br />
        <strong {...colorStyleProps(theme().accent)}>Active subagents</strong>
        <br />
        <Show when={activeSubagentNames().length === 0}>
          <span {...colorStyleProps(theme().textMuted)}>None</span>
          <br />
        </Show>
        <For each={activeSubagentNames()}>
          {(entry) => {
            const elapsed = () => now() - entry.firstSeen;
            const suffix = entry.source === "session" ? ` (${entry.key.slice(-6)})` : "";
            return (
              <span>
                <span {...colorStyleProps(agentColor(entry.name, subagentColor(elapsed(), theme())))}>
                  • {entry.name}
                  {suffix} ({formatElapsedSeconds(elapsed())})
                </span>
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
