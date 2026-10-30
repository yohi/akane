import type { RecoveryTracker } from "./recovery";
import type { SessionRegistry } from "./sessions";
import type { HostEvent, WatchdogPort } from "./types";
import { classifyError } from "../errors";
import type { WatchdogConfig } from "../config";

interface RouterDependencies {
  readonly watchdog: WatchdogPort;
  readonly sessions: SessionRegistry;
  readonly recovery: RecoveryTracker;
  readonly stage2Ms?: number;
  readonly pauseOnInputRequest?: boolean;
  readonly agents?: WatchdogConfig["agents"];
  readonly now?: () => number;
}

export function createEventRouter(deps: RouterDependencies): {
  handle(event: HostEvent): Promise<void>;
  dispose(): void;
} {
  let disposed = false;
  const seen = new Set<string>();
  const armLocked = (sessionID: string): boolean => {
    const lastPing = deps.watchdog.getLastPingTime(sessionID);
    return lastPing > 0 && (deps.now ?? Date.now)() - lastPing < Math.max((deps.stage2Ms ?? 180000) * 2, 30000);
  };
  const agentAllowed = (name: string | undefined): boolean => {
    const include = deps.agents?.include;
    const exclude = deps.agents?.exclude;
    if (include?.length && (!name || !include.includes(name))) return false;
    return !name || !exclude?.includes(name);
  };
  return {
    async handle(event) {
      if (disposed) return;
      if (seen.has(event.id)) return;
      seen.add(event.id);
      if (seen.size > 10000) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      switch (event.type) {
        case "session.deleted": {
          const { sessionID } = event.data;
          deps.sessions.invalidate(sessionID);
          deps.recovery.supersede(sessionID);
          deps.watchdog.stop(sessionID);
          return;
        }
        case "session.moved": {
          const { sessionID, location } = event.data;
          if (location.directory === undefined) return;
          deps.sessions.invalidate(sessionID);
          deps.recovery.supersede(sessionID);
          if (location.directory !== deps.sessions.directory) deps.watchdog.stop(sessionID);
          return;
        }
        case "session.execution.interrupted": {
          const { sessionID } = event.data;
          const recoveryPhase = deps.recovery.phase(sessionID);
          if (recoveryPhase === "interrupting") return;
          if (recoveryPhase === "resumed") {
            const generation = deps.recovery.generation(sessionID);
            if (generation !== undefined) deps.recovery.transition(sessionID, generation, "settled");
            return;
          }
          deps.sessions.invalidate(sessionID);
          deps.recovery.supersede(sessionID);
          deps.watchdog.stop(sessionID);
          return;
        }
        case "session.status": {
          const { sessionID, status } = event.data;
          if (!(await deps.sessions.resolve(sessionID)) || disposed) return;
          if (armLocked(sessionID)) return;
          if (status.type === "retry") deps.watchdog.onStatusRetry(sessionID);
          else if (status.type === "busy") deps.watchdog.onStatusActive(sessionID);
          return;
        }
        case "session.execution.started": {
          const { sessionID } = event.data;
          const session = await deps.sessions.resolve(sessionID);
          if (session && !disposed && agentAllowed(session.agent) && !armLocked(sessionID)) {
            deps.watchdog.onActivity(sessionID, { agentName: session.agent });
          }
          return;
        }
        case "session.step.started": {
          const { sessionID, agent } = event.data;
          if (!(await deps.sessions.resolve(sessionID)) || disposed || !agentAllowed(agent) || armLocked(sessionID)) return;
          deps.watchdog.onActivity(sessionID, { agentName: agent });
          return;
        }
        case "session.agent.selected": {
          const { sessionID } = event.data;
          const session = await deps.sessions.resolve(sessionID);
          if (session && !disposed && agentAllowed(session.agent) && !armLocked(sessionID)) {
            deps.watchdog.onActivity(sessionID, { agentName: session.agent });
          }
          return;
        }
        case "session.execution.failed":
        case "session.step.failed": {
          const { sessionID, error } = event.data;
          if (!(await deps.sessions.resolve(sessionID)) || disposed) return;
          const reason = classifyError(error);
          if (reason === "rate_limit" || reason === "provider_timeout") deps.watchdog.noteError(sessionID, reason);
          else deps.watchdog.stop(sessionID);
          return;
        }
        case "session.execution.succeeded": {
          const { sessionID } = event.data;
          if (!(await deps.sessions.resolve(sessionID)) || disposed) return;
          deps.recovery.supersede(sessionID);
          deps.watchdog.stop(sessionID);
          return;
        }
        case "session.tool.success":
        case "session.tool.failed": {
          const { sessionID, assistantMessageID, id } = event.data;
          const session = await deps.sessions.resolve(sessionID);
          if (!session || disposed || !agentAllowed(session.agent) || armLocked(sessionID)) return;
          deps.watchdog.onToolSettled(sessionID, `${assistantMessageID}:${id}`);
          return;
        }
        case "session.tool.called": {
          const { sessionID, assistantMessageID, id } = event.data;
          const session = await deps.sessions.resolve(sessionID);
          if (!session || disposed || !agentAllowed(session.agent) || armLocked(sessionID)) return;
          deps.watchdog.onToolRunning(sessionID, `${assistantMessageID}:${id}`);
          return;
        }
        case "session.inbox.enqueued": {
          const { sessionID, inboxID, item } = event.data;
          if (item.type !== "user" || deps.recovery.isOwnMessage(sessionID, inboxID)) return;
          const { text, files, agents, skills } = item.payload;
          if (!text.trim() && !files?.length && !agents?.length && !skills?.length) return;
          const session = await deps.sessions.resolve(sessionID);
          if (!session || disposed || !agentAllowed(session.agent)) return;
          deps.recovery.supersede(sessionID);
          deps.watchdog.onUserMessage(sessionID, { agentName: session.agent });
          return;
        }
        case "session.text.delta":
        case "session.reasoning.delta": {
          const { sessionID } = event.data;
          const session = await deps.sessions.resolve(sessionID);
          if (!session || disposed || !agentAllowed(session.agent)) return;
          if (armLocked(sessionID)) return;
          deps.watchdog.onActivity(sessionID);
          return;
        }
        case "session.text.started":
        case "session.text.ended":
        case "session.reasoning.started":
        case "session.reasoning.ended":
        case "session.tool.input.started":
        case "session.tool.input.delta":
        case "session.tool.input.ended":
        case "session.tool.progress":
        case "session.compaction.started":
        case "session.compaction.delta":
        case "session.compaction.ended": {
          const { sessionID } = event.data;
          const session = await deps.sessions.resolve(sessionID);
          if (session && !disposed && agentAllowed(session.agent) && !armLocked(sessionID)) {
            deps.watchdog.onActivity(sessionID, { agentName: session.agent });
          }
          return;
        }
        case "permission.asked": {
          const { sessionID, id } = event.data;
          if (deps.pauseOnInputRequest === false) return;
          if (!(await deps.sessions.resolve(sessionID)) || disposed) return;
          deps.watchdog.onInputRequested(sessionID, `permission:${id}`);
          return;
        }
        case "permission.replied": {
          const { sessionID, requestID } = event.data;
          if (!(await deps.sessions.resolve(sessionID)) || disposed) return;
          deps.watchdog.onInputResolved(sessionID, `permission:${requestID}`);
          return;
        }
        case "form.created": {
          const { sessionID, id } = event.data.form;
          if (deps.pauseOnInputRequest === false) return;
          if (sessionID === "global" || !(await deps.sessions.resolve(sessionID)) || disposed) return;
          deps.watchdog.onInputRequested(sessionID, `form:${id}`);
          return;
        }
        case "form.cancelled":
        case "form.replied": {
          const { sessionID, id } = event.data;
          if (sessionID === "global" || !(await deps.sessions.resolve(sessionID)) || disposed) return;
          deps.watchdog.onInputResolved(sessionID, `form:${id}`);
          return;
        }
        default:
          return;
      }
    },
    dispose() { disposed = true; seen.clear(); },
  };
}
