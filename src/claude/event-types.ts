import type { HangReason } from "../errors";

export type AkaneClaudeEventKind =
  | "user_message"
  | "activity"
  | "tool_running"
  | "tool_settled"
  | "input_requested"
  | "idle"
  | "turn_end"
  | "error"
  | "session_start"
  | "session_end";

export interface AkaneClaudeEvent {
  kind: AkaneClaudeEventKind;
  sessionId: string;
  ts: number;
  agentName?: string;
  callId?: string;
  requestId?: string;
  errorReason?: HangReason;
}

const EVENT_KINDS: ReadonlySet<string> = new Set<AkaneClaudeEventKind>([
  "user_message",
  "activity",
  "tool_running",
  "tool_settled",
  "input_requested",
  "idle",
  "turn_end",
  "error",
  "session_start",
  "session_end",
]);

const HANG_REASONS: ReadonlySet<string> = new Set<HangReason>([
  "rate_limit",
  "provider_timeout",
  "unknown",
]);

export function isAkaneClaudeEvent(value: unknown): value is AkaneClaudeEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<AkaneClaudeEvent>;
  return (
    typeof e.kind === "string" &&
    EVENT_KINDS.has(e.kind) &&
    typeof e.sessionId === "string" &&
    e.sessionId.length > 0 &&
    typeof e.ts === "number" &&
    Number.isFinite(e.ts) &&
    (e.agentName === undefined || typeof e.agentName === "string") &&
    (e.callId === undefined || typeof e.callId === "string") &&
    (e.requestId === undefined || typeof e.requestId === "string") &&
    (e.errorReason === undefined || (typeof e.errorReason === "string" && HANG_REASONS.has(e.errorReason)))
  );
}
