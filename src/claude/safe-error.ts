/**
 * Redacts + truncates an error into a log-safe string. The 30-char cap and the
 * "... (redacted)" suffix are the SPEC / AGENTS.md §3.7 secrecy invariant, kept
 * as a single implementation so the behavior cannot drift between call sites.
 */
export function safeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 30 ? `${msg.slice(0, 30)}... (redacted)` : msg;
}
