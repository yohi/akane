/**
 * Redacts + truncates an error into a log-safe string. The 30-char cap and the
 * "... (redacted)" suffix are the SPEC / AGENTS.md §3.7 secrecy invariant, kept
 * as a single implementation so the behavior cannot drift between call sites.
 */
export function safeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const singleLine = msg.replace(/\r\n|\r|\n/g, " ");
  return singleLine.length > 30 ? `${singleLine.slice(0, 30)}... (redacted)` : singleLine;
}
