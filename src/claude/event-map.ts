import type { AkaneClaudeEvent } from "./event-types";

// Structural subset of Watchdog consumed by the dispatcher. The real Watchdog
// (src/watchdog.ts) satisfies this; tests use a recording mock.
export interface WatchdogTarget {
  onUserMessage(sessionId: string, meta?: { agentName?: string }): void;
  onActivity(sessionId: string, meta?: { agentName?: string }): void;
  onToolRunning(sessionId: string, callId: string): void;
  onToolSettled(sessionId: string, callId: string): void;
  onInputRequested(sessionId: string, requestId: string): void;
  onInputResolved(sessionId: string, requestId: string): void;
  onSessionCreated(sessionId: string): void;
  noteError(sessionId: string, reason: "rate_limit" | "provider_timeout" | "unknown"): void;
  stop(sessionId: string): void;
}

// Claude Code has no explicit "permission replied" event (SPEC §5.3-2). We pause
// on this single synthetic request id and release it before the next
// activity-class event, matching the design's simplified PAUSED model.
export const CC_PERMISSION_REQUEST_ID = "cc-permission";

export function dispatchEvent(w: WatchdogTarget, e: AkaneClaudeEvent): void {
  switch (e.kind) {
    case "user_message":
      w.onUserMessage(e.sessionId, { agentName: e.agentName });
      return;
    case "activity":
      w.onInputResolved(e.sessionId, CC_PERMISSION_REQUEST_ID);
      w.onActivity(e.sessionId, { agentName: e.agentName });
      return;
    case "tool_running":
      w.onInputResolved(e.sessionId, CC_PERMISSION_REQUEST_ID);
      if (e.callId) w.onToolRunning(e.sessionId, e.callId);
      else w.onActivity(e.sessionId, { agentName: e.agentName });
      return;
    case "tool_settled":
      w.onInputResolved(e.sessionId, CC_PERMISSION_REQUEST_ID);
      if (e.callId) w.onToolSettled(e.sessionId, e.callId);
      w.onActivity(e.sessionId, { agentName: e.agentName });
      return;
    case "input_requested":
      // Ignore any real requestId: the release path uses the same synthetic id.
      w.onInputRequested(e.sessionId, CC_PERMISSION_REQUEST_ID);
      return;
    case "idle":
    case "turn_end":
    case "session_end":
      w.stop(e.sessionId);
      return;
    case "error":
      if (e.errorReason === "rate_limit" || e.errorReason === "provider_timeout") {
        w.noteError(e.sessionId, e.errorReason);
      } else {
        w.stop(e.sessionId);
      }
      return;
    case "session_start":
      w.onSessionCreated(e.sessionId);
      return;
  }
}
