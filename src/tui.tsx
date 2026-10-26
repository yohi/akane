import { RGBA } from "@opentui/core";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginOptions } from "@opencode-ai/plugin";
import type { TuiPlugin, TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import type { Part, Session } from "@opencode-ai/sdk/v2";
import type { SharedWatchdogState, SharedSessionState } from "./shared-state";
import {
  type AgentEntry,
  type SubagentEntry,
  SUBAGENT_IDLE_MS,
  applySessionUpdate,
  agentColorToRgba,
  formatElapsedSeconds,
  isActiveChildSession,
  isSessionPartUpdate,
  normalizeAgentsResponse,
  normalizeSessionChildren,
  recordAgent,
  subagentColor,
} from "./tui-helpers";
import { categoryColor, createCategoryResolver } from "./tui-category";
import { colorStyleProps, formatCurrentSessionState, formatLiveMetric, formatTimestamp, formatWorktreePath, newestSharedState, readSharedState, resolveAgentDisplayColor, sharedStateHealth, stateFilePath } from "./tui-state";
import { For, Show, createSignal, onCleanup } from "solid-js";

const POLL_MS = 1000;

interface SidebarProps {
  readonly api: TuiPluginApi;
  readonly sessionId: string;
}

function Sidebar(props: SidebarProps) {
  const [state, setState] = createSignal<SharedWatchdogState | undefined>(undefined);
  const [agents, setAgents] = createSignal<Record<string, AgentEntry>>({});
  const [agentColors, setAgentColors] = createSignal<Record<string, RGBA | undefined>>({});
  const [sessions, setSessions] = createSignal<Record<string, Session>>({});
  const [stoppedSessionIds, setStoppedSessionIds] = createSignal<ReadonlySet<string>>(new Set());
  const deletedSessionIds = new Set<string>();
  let childrenInFlight = false;
  let disposed = false;
  const [now, setNow] = createSignal(Date.now());
  const resolver = createCategoryResolver();

  const directory = () => props.api.state.path.worktree || props.api.state.path.directory;
  const theme = () => props.api.theme.current;

  const refresh = () => {
    const primaryDir = props.api.state.path.worktree;
    const alternateDir = props.api.state.path.directory;
    const primary = primaryDir ? readSharedState(stateFilePath(primaryDir)) : undefined;
    const alternate = alternateDir && alternateDir !== primaryDir
      ? readSharedState(stateFilePath(alternateDir)) : undefined;
    setState(newestSharedState(primary, alternate));
    resolver.refresh({
      taskDirectory: path.join(directory(), ".omo", "senpi-task", "tasks"),
      teamRuntimeDirectory: path.join(os.homedir(), ".omo", "runtime"),
    });
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

  // Subscribe to updates and reconcile existing children from the v1 server API.
  // An already-running child has no session.created event to replay on sidebar mount.
  const refreshChildSessions = async () => {
    if (disposed || childrenInFlight) return;
    childrenInFlight = true;
    try {
      const response = await props.api.client.session.children({ sessionID: props.sessionId, directory: directory() });
      if (disposed) return;
      const children = normalizeSessionChildren(response);
      setSessions((prev) => {
        const next = { ...prev };
        for (const child of children) {
          if (child.parentID !== props.sessionId || deletedSessionIds.has(child.id)) continue;
          if ((next[child.id]?.time.updated ?? 0) > (child.time.updated ?? 0)) continue;
          next[child.id] = child;
        }
        return next;
      });
    } catch {
      // Offline/temporary SDK errors must not hide event-sourced sessions or crash the sidebar.
    } finally {
      childrenInFlight = false;
    }
  };

  refresh();
  refreshAgentColors().catch(() => setAgentColors({}));
  void refreshChildSessions();
  const childrenTimer = setInterval(() => { void refreshChildSessions(); }, 15_000);

  const pollTimer = setInterval(() => {
    refresh();
    refreshAgentColors().catch(() => setAgentColors({}));
  }, POLL_MS);
  const nowTimer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => {
    disposed = true;
    clearInterval(childrenTimer);
    clearInterval(pollTimer);
    clearInterval(nowTimer);
  });

  const unsubPartUpdated = props.api.event.on("message.part.updated", (event) => {
    if (!isSessionPartUpdate(event, props.sessionId)) return;

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

  const unsubToolCalled = props.api.event.on("session.next.tool.called", (event) => {
    resolver.observeToolCall(
      event.properties.sessionID,
      event.properties.tool,
      event.properties.input,
      event.properties.callID,
    );
  });
  onCleanup(unsubToolCalled);

  const unsubToolSucceeded = props.api.event.on("session.next.tool.success", (event) => {
    resolver.observeToolSettled(event.properties.sessionID, event.properties.callID, "success");
  });
  onCleanup(unsubToolSucceeded);

  const unsubToolFailed = props.api.event.on("session.next.tool.failed", (event) => {
    resolver.observeToolSettled(event.properties.sessionID, event.properties.callID, "failure");
  });
  onCleanup(unsubToolFailed);

  const updateSession = (info: Session, eventType: "created" | "updated") => {
    setSessions((prev) => applySessionUpdate(prev, info, deletedSessionIds, eventType));
  };
  const markStopped = (sessionID: string, stopped: boolean) => {
    setStoppedSessionIds((prev) => {
      const next = new Set(prev);
      if (stopped) next.add(sessionID);
      else next.delete(sessionID);
      return next;
    });
  };
  const removeSession = (sessionID: string) => {
    setSessions((prev) => {
      const next = { ...prev };
      delete next[sessionID];
      return next;
    });
  };

  const unsubSessionCreated = props.api.event.on("session.created", (event) => {
    updateSession(event.properties.info, "created");
    markStopped(event.properties.info.id, false);
    resolver.observeSessionCreated(event.properties.info);
  });
  onCleanup(unsubSessionCreated);

  const unsubSessionUpdated = props.api.event.on("session.updated", (event) => {
    updateSession(event.properties.info, "updated");
  });
  onCleanup(unsubSessionUpdated);

  const unsubSessionDeleted = props.api.event.on("session.deleted", (event) => {
    deletedSessionIds.add(event.properties.info.id);
    markStopped(event.properties.info.id, true);
    removeSession(event.properties.info.id);
    resolver.evict(event.properties.info.id);
  });
  onCleanup(unsubSessionDeleted);

  const unsubSessionIdle = props.api.event.on("session.idle", (event) => {
    markStopped(event.properties.sessionID, true);
  });
  onCleanup(unsubSessionIdle);

  const unsubSessionStatus = props.api.event.on("session.status", (event) => {
    const status = event.properties.status.type;
    if (status === "idle") markStopped(event.properties.sessionID, true);
    else if (status === "busy" || status === "retry") markStopped(event.properties.sessionID, false);
  });
  onCleanup(unsubSessionStatus);

  const health = () => sharedStateHealth(state(), now());
  const sessionState = (): SharedSessionState | undefined => state()?.sessions[props.sessionId];
  const count = (value: number | undefined) => formatLiveMetric(value, health());
  const activeSessions = (): number =>
    Object.values(state()?.sessions ?? {}).filter((session) => session.state !== "IDLE").length;

  const activeEventAgents = (): AgentEntry[] => {
    const cutoff = now() - SUBAGENT_IDLE_MS;
    return Object.values(agents())
      .filter((entry) => entry.lastSeen >= cutoff)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  };

  const activeSubagentSessions = (): Session[] =>
    Object.values(sessions()).filter((session) =>
      isActiveChildSession(
        session, props.sessionId,
        props.api.state.session.status(session.id)?.type,
        now(), stoppedSessionIds().has(session.id),
      ),
    );

  const activeSubagentNames = (): SubagentEntry[] => {
    const nowTime = now();
    const fromSessions: SubagentEntry[] = activeSubagentSessions().map((session) => {
      const parentParts: readonly Part[] = session.parentID === undefined
        ? []
        : props.api.state.session.messages(session.parentID).flatMap((message) => props.api.state.part(message.id));
      const category = resolver.resolve(session, parentParts);
      return {
        key: session.id,
        name: session.agent ?? "unknown",
        source: "session",
        firstSeen: session.time.created ?? nowTime,
        lastSeen: session.time.updated ?? nowTime,
        ...(category.kind === "resolved" ? { category: category.category } : {}),
      };
    });
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
        Worktree: <span>{formatWorktreePath(directory())}</span>
        <br />
        Plugin: <span>{health() === "ready" ? (state()?.enabled ? "enabled" : "disabled") : health()}</span>
        <br />
        <br />
        <strong {...colorStyleProps(theme().accent)}>Telemetry</strong>
        <br />
        Active sessions: <span>{count(activeSessions())}</span>
        <br />
        Hangups: <span>{count(state()?.global.hangupsDetected)}</span>
        <br />
        Pings: <span>{count(state()?.global.pingsSent)}</span>
        <br />
        Recoveries: <span>{count(state()?.global.recoveries)}</span>
        <br />
        Silenced: <span>{count(state()?.global.silencedFailures)}</span>
        <br />
        <br />
        <strong {...colorStyleProps(currentAgentColor())}>This session</strong>
        <br />
        State: <span>{formatCurrentSessionState(sessionState()?.state, health())}</span>
        <br />
        Agent: <span {...colorStyleProps(agentColor(sessionState()?.agentName, theme().text))}>{sessionState()?.agentName ?? "-"}</span>
        <br />
        Tools running: <span>{count(sessionState()?.runningToolsCount)}</span>
        <br />
        Pending: <span>{count(sessionState()?.pendingRequestsCount)}</span>
        <br />
        Last activity: <span>{health() === "ready" ? formatTimestamp(sessionState()?.lastActivityAt, now()) : "-"}</span>
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
                  {entry.category && (
                    <span {...colorStyleProps(categoryColor(entry.category, theme()))}>
                      {" "}({entry.category})
                    </span>
                  )}
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
