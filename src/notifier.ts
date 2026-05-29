export type NotifierStage = "warn" | "critical" | "silenced";

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
    await this.safeSpawn(["tmux", "display-message", message]);
    await this.safeSpawn([
      "tmux",
      "set-window-option",
      "window-status-current-style",
      STYLE_BY_STAGE[stage],
    ]);
  }

  async clear(sessionId: string): Promise<void> {
    if (!(await this.ensureTmux())) return;
    await this.safeSpawn([
      "tmux",
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
    const probe = await this.safeSpawn(["tmux", "display-message", "-p", "#{session_name}"]);
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
        this.log(
          "warn",
          `tmux command failed: ${cmd.join(" ")} (exitCode: ${result.exitCode}, stdout: ${result.stdout ?? ""})`,
        );
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
