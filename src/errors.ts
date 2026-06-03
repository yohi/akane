export type HangReason = "rate_limit" | "provider_timeout" | "unknown";

/**
 * Recursively collects candidate error strings from `name` / `message` / `error`
 * fields. Robust against unknown payload shapes (the exact session.error shape is
 * an open question — see docs/SDK_NOTES.md). Returns "" when nothing extractable.
 */
function collectStrings(payload: unknown, depth = 0): string {
  if (depth > 4 || payload == null) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["name", "message", "error", "code", "type"]) {
    const v = obj[key];
    if (typeof v === "string") {
      parts.push(v);
    } else if (typeof v === "number") {
      parts.push(String(v));
    } else if (v && typeof v === "object") {
      parts.push(collectStrings(v, depth + 1));
    }
  }
  return parts.join(" ").trim();
}

export function classifyError(payload: unknown): HangReason | null {
  const text = collectStrings(payload);
  if (text.length === 0) return null;
  if (/rate.?limit|\b429\b|too many requests/i.test(text)) return "rate_limit";
  if (/timeout|timed out|etimedout|deadline/i.test(text)) return "provider_timeout";
  return "unknown";
}

export function reasonToJa(reason: HangReason): string {
  switch (reason) {
    case "rate_limit":
      return "APIレート制限に到達しました";
    case "provider_timeout":
      return "プロバイダ応答がタイムアウトしました";
    case "unknown":
      return "原因不明のエラーが発生しました";
  }
}
