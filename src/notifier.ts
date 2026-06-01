export type NotifierStage = "warn" | "critical" | "silenced";
import type { NotifierType } from "./config";

export interface Notifier {
  notify(sessionId: string, stage: NotifierStage, message: string): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

export type SpawnResult = { exitCode: number; stdout?: string };
export type SpawnFn = (cmd: string[]) => Promise<SpawnResult>;
export type WhichFn = (binary: string) => string | null;

export interface TmuxNotifierDeps {
  env: Record<string, string | undefined>;
  spawn: SpawnFn;
  which: WhichFn;
  log?: (level: "warn" | "info", message: string) => void;
}

const STYLE_BY_STAGE: Record<NotifierStage, string> = {
  warn: "bg=yellow",
  critical: "bg=red",
  silenced: "bg=red",
};

export class TmuxNotifier implements Notifier {
  private detection: "unknown" | "ok" | "disabled" = "unknown";
  private tmuxPath: string = "tmux";
  private readonly log: (level: "warn" | "info", message: string) => void;

  constructor(private readonly deps: TmuxNotifierDeps) {
    this.log = deps.log ?? ((level, message) => console[level](`[watchdog] ${message}`));
  }

  /**
   * Renders `message` verbatim to tmux display-message and applies the stage-specific
   * window highlight color. The caller is responsible for producing the design §5.2
   * mandated text (e.g. "[Watchdog] Agent <sessionId> idle for <stage1Ms>ms").
   * Notifier never prefixes or reformats the message.
   */
  async notify(sessionId: string, stage: NotifierStage, message: string): Promise<void> {
    if (!(await this.ensureTmux())) return;
    await this.safeSpawn([this.tmuxPath, "display-message", message]);
    await this.safeSpawn([
      this.tmuxPath,
      "set-window-option",
      "window-status-current-style",
      STYLE_BY_STAGE[stage],
    ]);
  }

  async clear(sessionId: string): Promise<void> {
    if (!(await this.ensureTmux())) return;
    await this.safeSpawn([
      this.tmuxPath,
      "set-window-option",
      "window-status-current-style",
      "default",
    ]);
  }

  private async ensureTmux(): Promise<boolean> {
    if (this.detection === "ok") return true;
    if (this.detection === "disabled") return false;

    const tmuxEnv = this.deps.env.TMUX;
    if (!tmuxEnv) {
      this.detection = "disabled";
      this.log("info", "tmux not detected (TMUX env empty).");
      return false;
    }
    const path = this.deps.which("tmux");
    if (!path) {
      this.detection = "disabled";
      this.log("info", "tmux binary not found in PATH.");
      return false;
    }
    this.tmuxPath = path;
    const probe = await this.safeSpawn([this.tmuxPath, "display-message", "-p", "#{session_name}"]);
    if (!probe || probe.exitCode !== 0) {
      this.detection = "disabled";
      this.log("info", "tmux probe failed; disabling tmux integration.");
      return false;
    }
    this.detection = "ok";
    return true;
  }

  private async safeSpawn(cmd: string[]): Promise<SpawnResult | null> {
    try {
      const result = await this.deps.spawn(cmd);
      if (result.exitCode !== 0) {
        // Log only the binary name and exit code. The full command line (and stdout)
        // can contain the notification message body (session id / arbitrary text),
        // which may be sensitive and must not be persisted to logs.
        this.log("warn", `tmux command failed: ${cmd[0]} (exitCode: ${result.exitCode})`);
      }
      return result;
    } catch (err) {
      this.log("warn", `tmux spawn failed: ${String(err)}`);
      return null;
    }
  }
}

// Default spawn/which factory using Bun. Kept separate so tests can DI mocks.
export function bunSpawn(): SpawnFn {
  return async (cmd) => {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return { exitCode, stdout };
  };
}

export function bunWhich(): WhichFn {
  return (binary) => Bun.which(binary) ?? null;
}

export interface OSNotifierDeps {
  platform: string;
  spawn: SpawnFn;
  which: WhichFn;
  log?: (level: "warn" | "info", message: string) => void;
}

const OS_URGENCY_BY_STAGE: Record<NotifierStage, "normal" | "critical"> = {
  warn: "normal",
  critical: "critical",
  silenced: "critical",
};

/**
 * Cross-platform OS desktop notification backend.
 * - linux: `notify-send -u <urgency> "Akane Watchdog" <message>`
 * - darwin: `osascript -e 'display notification "<escaped>" with title "Akane Watchdog"'`
 * Arguments are always passed as an array (no shell), avoiding injection. macOS
 * message double-quotes are escaped. Detection failures disable silently.
 */
export class OSNotifier implements Notifier {
  private detection: "unknown" | "ok" | "disabled" = "unknown";
  private notifySendPath = "notify-send";
  private readonly log: (level: "warn" | "info", message: string) => void;

  constructor(private readonly deps: OSNotifierDeps) {
    this.log = deps.log ?? ((level, message) => console[level](`[watchdog] ${message}`));
  }

  async notify(_sessionId: string, stage: NotifierStage, message: string): Promise<void> {
    if (!this.ensureBackend()) return;
    if (this.deps.platform === "darwin") {
      const escaped = message.replace(/"/g, '\\"');
      await this.safeSpawn([
        "osascript",
        "-e",
        `display notification "${escaped}" with title "Akane Watchdog"`,
      ]);
      return;
    }
    const urgency = OS_URGENCY_BY_STAGE[stage];
    await this.safeSpawn([this.notifySendPath, "-u", urgency, "Akane Watchdog", message]);
  }

  async clear(_sessionId: string): Promise<void> {
    // OS notifications are transient; nothing to clear. Always resolves.
  }

  private ensureBackend(): boolean {
    if (this.detection === "ok") return true;
    if (this.detection === "disabled") return false;
    if (this.deps.platform === "darwin") {
      this.detection = "ok";
      return true;
    }
    const path = this.deps.which("notify-send");
    if (!path) {
      this.detection = "disabled";
      this.log("info", "notify-send not found in PATH; disabling OS notifications.");
      return false;
    }
    this.notifySendPath = path;
    this.detection = "ok";
    return true;
  }

  private async safeSpawn(cmd: string[]): Promise<SpawnResult | null> {
    try {
      const result = await this.deps.spawn(cmd);
      if (result.exitCode !== 0) {
        // Log only the binary name and exit code. The full command line contains the
        // notification message body (session id / error reason / arbitrary text),
        // which may be sensitive and must not be persisted to logs.
        this.log("warn", `OS notify failed: ${cmd[0]} (exitCode: ${result.exitCode})`);
      }
      return result;
    } catch (err) {
      this.log("warn", `OS notify spawn failed: ${String(err)}`);
      return null;
    }
  }
}

export interface CreateNotifierDeps {
  env: Record<string, string | undefined>;
  spawn: SpawnFn;
  which: WhichFn;
  platform: string;
  log?: (level: "warn" | "info", message: string) => void;
}

export function createNotifier(type: NotifierType, deps: CreateNotifierDeps): Notifier {
  if (type === "os") {
    return new OSNotifier({
      platform: deps.platform,
      spawn: deps.spawn,
      which: deps.which,
      log: deps.log,
    });
  }
  return new TmuxNotifier({
    env: deps.env,
    spawn: deps.spawn,
    which: deps.which,
    log: deps.log,
  });
}
