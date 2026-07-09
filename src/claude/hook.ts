import { classifyError, type HangReason } from "../errors";
import { appendEvent } from "./event-log";
import { safeError } from "./safe-error";
import { resolveStateDir, eventsPathFor } from "./state-dir";
import type { AkaneClaudeEvent, AkaneClaudeEventKind } from "./event-types";

// ── Claude Code stdin field contract ───────────────────────────────────
// `agent_type`/`agent_id` are confirmed against the official Claude Code
// Hooks reference (https://code.claude.com/docs/en/hooks, "Common input
// fields"): `agent_type` carries the subagent name/type (e.g. "Explore"),
// `agent_id` a unique per-subagent-call identifier. The remaining fields
// below are still a best-effort mapping and MUST be confirmed against a
// live `claude` install (SPEC §10-3).
// Keep every raw-field access in this block so Task 15 has a single fix point.
export interface CCHookStdin {
  hook_event_name?: string;
  session_id?: string;
  sessionId?: string;
  agent_type?: string;
  agent_id?: string;
  tool_use_id?: string;
  callID?: string;
  error_type?: string;
  error?: unknown;
  stop_reason?: string;
  notification_type?: string;
  matcher?: string;
}

export function extractCCSessionId(input: CCHookStdin): string | undefined {
  const raw = input.session_id ?? input.sessionId;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export function extractCCAgentName(input: CCHookStdin): string | undefined {
  return input.agent_type;
}

export function extractCCCallId(input: CCHookStdin): string | undefined {
  return input.tool_use_id ?? input.callID;
}

function notificationSubtype(input: CCHookStdin): string | undefined {
  return input.notification_type ?? input.matcher;
}

// Extracts a HangReason when a Stop/StopFailure payload carries error signals
// (SPEC §5.4-1: Stop-with-error fallback when StopFailure is unregistrable).
export function errorReasonFromStop(input: CCHookStdin): HangReason | null {
  if (input.error === undefined && input.error_type === undefined && input.stop_reason === undefined) {
    return null;
  }
  return classifyError({ type: input.error_type, message: input.stop_reason, error: input.error });
}

export function normalizeEvent(rawInput: unknown, now: number): AkaneClaudeEvent | null {
  if (typeof rawInput !== "object" || rawInput === null) return null;
  const input = rawInput as CCHookStdin;
  const name = input.hook_event_name;
  if (typeof name !== "string") return null;
  const sessionId = extractCCSessionId(input);
  if (!sessionId) return null;
  const agentName = extractCCAgentName(input);

  const emit = (kind: AkaneClaudeEventKind, extra: Partial<AkaneClaudeEvent> = {}): AkaneClaudeEvent => ({
    kind,
    sessionId,
    ts: now,
    agentName,
    ...extra,
  });

  switch (name) {
    case "UserPromptSubmit":
      return emit("user_message");
    case "MessageDisplay":
      return emit("activity");
    case "PreToolUse":
      return emit("tool_running", { callId: extractCCCallId(input) });
    case "PostToolUse":
    case "PostToolUseFailure":
      return emit("tool_settled", { callId: extractCCCallId(input) });
    case "PermissionRequest":
      return emit("input_requested");
    case "Notification": {
      const sub = notificationSubtype(input);
      if (sub === "permission_prompt") return emit("input_requested");
      if (sub === "idle_prompt") return emit("idle");
      return null; // unknown notification subtype: ignore
    }
    case "Stop": {
      // SPEC §5.4-1: inspect error fields even on Stop so rate_limit/overloaded
      // terminations route to error (not turn_end) when StopFailure is absent.
      const reason = errorReasonFromStop(input);
      return reason ? emit("error", { errorReason: reason }) : emit("turn_end");
    }
    case "StopFailure":
      return emit("error", { errorReason: errorReasonFromStop(input) ?? "unknown" });
    case "SessionStart":
      return emit("session_start");
    case "SessionEnd":
      return emit("session_end");
    case "SubagentStart":
      return emit("activity");
    case "SubagentStop":
      // SPEC §5.1 treats subagent stop as settle. If Claude Code does not provide
      // a call/tool id, dispatchEvent degrades this to activity-only re-arm.
      return emit("tool_settled", { callId: extractCCCallId(input) });
    default:
      return null;
  }
}

export interface HookIO {
  stdinText: string;
  env: Record<string, string | undefined>;
  now: number;
  logError: (message: string) => void;
}

// Pure core: parse -> normalize -> append. Never throws (SPEC §8.1 exit-0).
export function runHook(io: HookIO): void {
  try {
    const parsed = JSON.parse(io.stdinText) as unknown;
    const event = normalizeEvent(parsed, io.now);
    if (!event) return;
    const stateDir = resolveStateDir(io.env);
    appendEvent(eventsPathFor(stateDir, event.sessionId), event);
  } catch (err) {
    io.logError(`hook error (contained): ${safeError(err)}`);
  }
}

export async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  const TIMEOUT_MS = 500; // Short timeout for testing; production can adjust
  let timeoutHandle: NodeJS.Timeout | null = null;
  let timedOut = false;

  return new Promise<string>((resolve) => {
    // Set up timeout: if EOF doesn't arrive within TIMEOUT_MS, resolve with accumulated chunks
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      // NodeJS.ReadableStream doesn't declare destroy(), but Node's actual
      // Readable streams (process.stdin) implement it. Guard defensively so
      // this stays safe for any ReadableStream-compatible mock in tests.
      (stream as unknown as { destroy?: () => void }).destroy?.();
      resolve(Buffer.concat(chunks).toString("utf8"));
    }, TIMEOUT_MS);

    (async () => {
      try {
        for await (const chunk of stream) {
          if (timedOut) break;
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }
      } catch {
        // Stream destroyed by timeout or other error: safe to ignore
      }

      // Clear timeout if we reach EOF before timeout
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }

      // Resolve with accumulated chunks (either from EOF or timeout)
      if (!timedOut) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    })();
  });
}
