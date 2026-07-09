import * as path from "node:path";
import * as os from "node:os";

const STATE_SUBDIR = ".akane";

export function resolveStateDir(env: Record<string, string | undefined>): string {
  const explicit = env.AKANE_STATE_DIR;
  if (explicit && explicit.trim().length > 0) return explicit;
  const xdg = env.XDG_STATE_HOME;
  if (xdg && xdg.trim().length > 0) return path.join(xdg, "akane");
  // HOME 未設定でも cwd 相対 "." にフォールバックしない: hook/monitor は別プロセスで cwd 一致の
  // 保証がなく、相対 stateDir は §4.3「決定論的に同一の stateDir」を破壊し IPC (.ndjson) が食い違う。
  // os.homedir() は同一 uid で決定論的に解決される。
  const home = env.HOME && env.HOME.trim().length > 0 ? env.HOME : os.homedir();
  return path.join(home, ".local", "state", "akane");
}

export function eventsDir(stateDir: string): string {
  return path.join(stateDir, STATE_SUBDIR);
}

// Claude Code stdin is untrusted. Replacing every non-safe char with "_" keeps
// the ndjson file strictly inside eventsDir (SPEC §8.2 path safety). Distinct
// raw ids sharing only unsafe chars may collide; acceptable given ids are
// uuid-like in practice.
export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function eventsPathFor(stateDir: string, sessionId: string): string {
  return path.join(eventsDir(stateDir), `${sanitizeSessionId(sessionId)}.ndjson`);
}
